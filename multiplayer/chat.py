"""Bounded room chat, independent of game snapshots and action revisions."""
import asyncio
from dataclasses import dataclass, field
import json
import time
import unicodedata

from starlette.concurrency import run_in_threadpool

from multiplayer.rooms import RoomError, _check
from multiplayer.security import RateLimits


MAX_PEER_BUFFER_BYTES = 256 * 1024
MAX_TOTAL_BUFFER_BYTES = 8 * 1024 * 1024


class ChatSyncRateLimit(RoomError):
    pass


class ChatStore:
    def __init__(self, rooms):
        self.rooms = rooms
        self.limits = RateLimits()

    def _room(self, token, connection, room_id):
        client = self.rooms.client(token)
        _check(connection in self.rooms.presence[client.member_id].connections, "聊天连接已失效，请等待重连")
        _check(type(room_id) is str and client.room_id == room_id and room_id in self.rooms.rooms,
               "你已不在这个房间")
        room = self.rooms.rooms[room_id]
        _check(client.member_id in room.members, "你已不在这个房间")
        return room, room.members[client.member_id]

    def allowed(self, token, connection, room_id):
        with self.rooms.lock:
            try:
                self._room(token, connection, room_id)
                return True
            except (RoomError, KeyError):
                return False

    def history(self, token, connection, room_id, after_id):
        with self.rooms.lock:
            room, _ = self._room(token, connection, room_id)
            _check(type(after_id) is int and 0 <= after_id <= room.chat_sequence, "无效的聊天消息位置")
            if not self.limits.take(("history", room_id, connection), rate=0.2, burst=1):
                raise ChatSyncRateLimit("消息同步太频繁，稍后自动重试")
            oldest = room.chat_messages[0]["message_id"] if room.chat_messages else 1
            return {"type": "chat_history", "room_id": room_id,
                    "messages": [dict(m) for m in room.chat_messages if m["message_id"] > after_id],
                    "latest_id": room.chat_sequence, "reset": after_id > 0 and after_id < oldest - 1}

    def post(self, token, connection, room_id, client_id, value):
        # Normalize outside the game lock; only authorization and bounded state
        # changes need to share the room's serialized action path.
        _check(type(client_id) is str and 0 < len(client_id) <= 64 and client_id.isascii(), "缺少聊天消息编号")
        _check(type(value) is str and len(value) <= 600, "每条消息最多 300 字")
        value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
        _check(0 < len(value) <= 300, "请输入 1 到 300 字的消息")
        _check(all(c in "\n\t" or unicodedata.category(c) not in {"Cc", "Cs"} for c in value),
               "消息包含无效字符")
        with self.rooms.lock:
            room, member = self._room(token, connection, room_id)
            key = (member.member_id, client_id)
            if key in room.chat_seen:
                existing = room.chat_seen[key]
                _check(existing["text"] == value, "重复消息编号包含不同内容")
                return dict(existing), False
            _check(self.limits.take((room_id, member.member_id), rate=1, burst=3), "发送太快了，请稍等一下")
            room.chat_sequence += 1
            message = {"message_id": room.chat_sequence, "client_id": client_id,
                       "member_id": member.member_id, "name": member.name,
                       "text": value, "sent_at": int(time.time() * 1000)}
            room.chat_messages.append(message)
            room.chat_seen[key] = message
            while len(room.chat_seen) > 256:
                room.chat_seen.popitem(last=False)
            return dict(message), True


@dataclass(frozen=True, slots=True)
class ChatPacket:
    kind: str
    room_id: str | None
    text: str
    size: int


@dataclass(eq=False)
class ChatPeer:
    token: str
    connection: str
    room_id: str | None = None
    needs_sync: bool = False
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))
    buffered_bytes: int = 0


class ChatHub:
    def __init__(self, rooms):
        self.store = ChatStore(rooms)
        self.instance_id = rooms.instance_id
        self.peers: set[ChatPeer] = set()
        self.by_room: dict[str, set[ChatPeer]] = {}
        self.buffered_bytes = 0
        self.limits = RateLimits()

    def attach(self, token, connection):
        peer = ChatPeer(token, connection)
        self.peers.add(peer)
        return peer

    def detach(self, peer):
        self.subscribe(peer, None)
        self.discard_queue(peer)
        self.peers.discard(peer)

    def subscribe(self, peer, room_id):
        old = self.by_room.get(peer.room_id)
        if old is not None:
            old.discard(peer)
            if not old:
                del self.by_room[peer.room_id]
        peer.room_id = room_id
        if room_id is not None:
            self.by_room.setdefault(room_id, set()).add(peer)

    def encode(self, packet):
        text = json.dumps({**packet, "server_instance_id":self.instance_id}, ensure_ascii=False, separators=(",", ":"))
        return ChatPacket(packet["type"], packet.get("room_id"), text, len(text.encode("utf-8")))

    def release(self, peer, packet):
        if isinstance(packet, ChatPacket):
            peer.buffered_bytes -= packet.size
            self.buffered_bytes -= packet.size
        peer.queue.task_done()

    def discard_queue(self, peer):
        while not peer.queue.empty():
            self.release(peer, peer.queue.get_nowait())

    def enqueue(self, peer, packet):
        if isinstance(packet, dict):
            packet = self.encode(packet)
        if isinstance(packet, ChatPacket) and packet.kind == "chat_message" and peer.needs_sync:
            return
        size = packet.size if isinstance(packet, ChatPacket) else 0
        if (peer.queue.full() or peer.buffered_bytes + size > MAX_PEER_BUFFER_BYTES
                or self.buffered_bytes + size > MAX_TOTAL_BUFFER_BYTES):
            self.discard_queue(peer)
            peer.needs_sync = True
            # A small control notice is allowed beyond the data budget so a
            # congested chat can recover without dropping game presence.
            packet = self.encode({"type":"chat_resync", "room_id":peer.room_id})
            size = packet.size
        peer.queue.put_nowait(packet)
        peer.buffered_bytes += size
        self.buffered_bytes += size

    def broadcast(self, room_id, packet):
        encoded = self.encode(packet)
        for peer in tuple(self.by_room.get(room_id, ())):
            self.enqueue(peer, encoded)

    def error(self, peer, message, *, packet=None, retry_after_ms=None):
        packet = packet if isinstance(packet, dict) else {}
        client_id = packet.get("client_id")
        if type(client_id) is not str or len(client_id) > 64 or not client_id.isascii():
            client_id = None
        action = packet.get("type")
        if action not in ("chat_sync", "chat_send"):
            action = None
        response = {"type": "chat_error", "room_id": peer.room_id,
                    "client_id": client_id, "action": action, "error": message}
        if retry_after_ms is not None:
            response["retry_after_ms"] = retry_after_ms
        self.enqueue(peer, response)

    async def handle(self, peer, packet):
        kind = None
        try:
            _check(type(packet) is dict, "无效的聊天请求")
            kind, room_id = packet.get("type"), packet.get("room_id")
            if kind == "chat_sync":
                _check(set(packet) == {"type", "room_id", "after_id"}, "无效的聊天请求")
                _check(type(room_id) is str and len(room_id) <= 64 and room_id.isascii(), "无效的聊天房间")
                # Subscribe before reading history. A concurrent live message may
                # arrive first; the client merges by ID without gaps or repeats.
                self.subscribe(peer, room_id)
                peer.needs_sync = False
                history = await run_in_threadpool(self.store.history, peer.token, peer.connection, room_id, packet["after_id"])
                self.enqueue(peer, history)
            elif kind == "chat_send":
                _check(set(packet) == {"type", "room_id", "client_id", "text"}, "无效的聊天请求")
                _check(peer.room_id == room_id, "请等待聊天连接就绪")
                message, created = await run_in_threadpool(self.store.post, peer.token, peer.connection,
                                                          room_id, packet["client_id"], packet["text"])
                event = {"type": "chat_message", "room_id": room_id, "message": message}
                if created:
                    self.broadcast(room_id, event)
                else:
                    self.enqueue(peer, event)
            else:
                raise RoomError("不支持的聊天请求")
        except ChatSyncRateLimit as exc:
            # Authorization succeeded; keep the subscription while the client
            # waits, instead of forcing a manual reconnect for slow delivery.
            peer.needs_sync = True
            self.error(peer, str(exc), packet=packet, retry_after_ms=5000)
        except RoomError as exc:
            self.error(peer, str(exc), packet=packet)
            if kind == "chat_sync":
                self.subscribe(peer, None)

    async def write(self, peer, socket):
        while True:
            packet = await peer.queue.get()
            try:
                if isinstance(packet, ChatPacket) and packet.kind in {"chat_message", "chat_history"}:
                    # Keep authorization at delivery even with a room index.
                    if not await run_in_threadpool(self.store.allowed, peer.token, peer.connection, packet.room_id):
                        if peer.room_id == packet.room_id:
                            self.subscribe(peer, None)
                        continue
                await socket.send_text(packet.text if isinstance(packet, ChatPacket) else packet)
            finally:
                # Includes in-flight sends: a stalled network cannot hide its
                # payload from the buffer budget by taking it out of the queue.
                self.release(peer, packet)
