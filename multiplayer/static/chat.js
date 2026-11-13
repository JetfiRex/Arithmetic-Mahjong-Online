"use strict";

class RoomChatClient {
  constructor(transport) {
    this.transport = transport;
    this.root = document.getElementById("room-chat");
    this.panel = document.getElementById("room-chat-panel");
    this.toggle = document.getElementById("room-chat-toggle");
    this.list = document.getElementById("room-chat-messages");
    this.input = document.getElementById("room-chat-input");
    this.button = document.getElementById("room-chat-send");
    this.error = document.getElementById("room-chat-error");
    this.retry = document.getElementById("room-chat-retry");
    this.toggle.onclick = () => this.setOpen(!this.open);
    document.getElementById("room-chat-close").onclick = () => this.setOpen(false);
    document.getElementById("room-chat-form").onsubmit = event => { event.preventDefault(); this.send(); };
    this.input.oninput = () => this.renderControls();
    this.input.oncompositionstart = () => { this.composing = true; };
    this.input.oncompositionend = () => { this.composing = false; this.renderControls(); };
    this.input.onkeydown = event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !this.composing && event.keyCode !== 229) {
        event.preventDefault(); this.send();
      }
    };
    this.panel.onkeydown = event => { if (event.key === "Escape") { this.setOpen(false); this.toggle.focus(); } };
    this.retry.onclick = () => this.sync();
    this.reset();
  }

  key(snapshot) {
    return snapshot?.room ? `${snapshot.server_instance_id}:${snapshot.room.room_id}:${snapshot.session_id}` : null;
  }

  current() { return !!this.owner && this.owner === this.key(state); }

  reset() {
    clearTimeout(this.ackTimer); clearTimeout(this.syncTimer);
    this.owner = this.roomId = this.memberId = this.connection = null;
    this.messages = new Map(); this.nodes = new Map(); this.latest = this.unread = 0;
    this.hasHistory = false;
    this.pending = null; this.online = this.synced = this.syncing = this.open = this.composing = false;
    this.error.textContent = ""; this.input.value = "";
    this.list.replaceChildren(); this.root.hidden = true;
    document.getElementById("room-chat-empty").hidden = false;
    this.setOpen(false); this.renderControls();
  }

  update(snapshot) {
    const owner = this.key(snapshot);
    if (owner !== this.owner) {
      this.reset(); this.owner = owner;
      if (owner) {
        this.roomId = snapshot.room.room_id; this.memberId = snapshot.session_id;
        document.getElementById("room-chat-room").textContent = snapshot.room.name;
      }
    }
    this.root.hidden = !owner;
    if (!owner) return;
    const connection = this.transport.socket?.readyState === 1 ? this.transport.connectionId : null;
    if (connection !== this.connection) {
      this.connection = connection; this.online = !!connection;
      this.synced = this.syncing = false;
      clearTimeout(this.syncTimer);
      if (this.pending?.waiting) this.failPending("连接已中断，重连后可以重试");
      if (this.online) this.sync();
      this.renderControls();
    }
  }

  sync() {
    if (!this.current() || !this.online || this.syncing) return;
    this.syncing = true; this.synced = false; this.error.textContent = "";
    try {
      this.transport.socket.send(JSON.stringify({type:"chat_sync", room_id:this.roomId, after_id:this.latest}));
      clearTimeout(this.syncTimer);
      const owner = this.owner, connection = this.connection;
      this.syncTimer = setTimeout(() => {
        if (owner !== this.owner || connection !== this.connection) return;
        this.syncing = false; this.error.textContent = "暂时未能同步消息，可以点击重试"; this.renderControls();
      }, 10000);
    } catch {
      this.syncing = false; this.error.textContent = "聊天连接暂不可用，请稍后重试";
    }
    this.renderControls();
  }

  send() {
    const text = this.input.value.replace(/\r\n?/g, "\n").trim();
    if (!this.current() || !this.online || !this.synced || this.pending?.waiting || !text) return;
    if ([...text].length > 300) { this.error.textContent = "每条消息最多 300 字"; return; }
    const clientId = this.pending?.text === text ? this.pending.id : crypto.randomUUID();
    this.pending = {id:clientId, text, waiting:true};
    this.error.textContent = "";
    try {
      this.transport.socket.send(JSON.stringify({type:"chat_send", room_id:this.roomId, client_id:clientId, text}));
      clearTimeout(this.ackTimer);
      this.ackTimer = setTimeout(() => {
        if (this.pending?.id === clientId) this.failPending("未收到发送确认，点击发送可重试");
      }, 10000);
    } catch { this.failPending("消息未发送，请等待连接恢复后重试"); }
    this.renderControls();
  }

  failPending(message) {
    clearTimeout(this.ackTimer);
    if (this.pending) this.pending.waiting = false;
    this.error.textContent = message; this.renderControls();
  }

  receive(packet) {
    if (!this.current() || packet.server_instance_id !== state.server_instance_id || packet.room_id !== this.roomId) return;
    if (packet.type === "chat_resync") {
      clearTimeout(this.syncTimer); this.syncing = false; this.sync(); return;
    }
    if (packet.type === "chat_error") {
      if (packet.client_id === this.pending?.id) this.failPending(packet.error);
      else this.error.textContent = packet.error;
      if (packet.action === "chat_sync") {
        clearTimeout(this.syncTimer); this.syncing = false;
        if (Number.isFinite(packet.retry_after_ms) && packet.retry_after_ms > 0) {
          const owner = this.owner, connection = this.connection;
          this.synced = false; this.syncing = true;
          this.syncTimer = setTimeout(() => {
            if (owner !== this.owner || connection !== this.connection) return;
            this.syncing = false; this.sync();
          }, Math.max(1000, Math.min(30000, packet.retry_after_ms)));
        }
      }
      this.renderControls(); return;
    }
    if (packet.type === "chat_history") {
      clearTimeout(this.syncTimer); this.syncing = false; this.synced = true;
      this.error.textContent = "";
      // Live messages can precede history; keep records newer than its snapshot.
      if (packet.reset) {
        for (const id of this.messages.keys()) if (id <= packet.latest_id) this.messages.delete(id);
      }
      this.merge(packet.messages, this.hasHistory);
      this.hasHistory = true;
      this.latest = Math.max(this.latest, packet.latest_id);
      this.advanceCursor();
    } else if (packet.type === "chat_message") this.merge([packet.message], true);
    this.renderControls();
  }

  merge(messages, countUnread) {
    const scrollBottom = this.list.scrollHeight - this.list.clientHeight - this.list.scrollTop < 36;
    for (const message of messages) {
      if (!Number.isSafeInteger(message.message_id) || message.message_id < 1) continue;
      const fresh = !this.messages.has(message.message_id);
      this.messages.set(message.message_id, message);
      if (fresh && countUnread && !this.open && message.member_id !== this.memberId) this.unread++;
      if (message.member_id === this.memberId && message.client_id === this.pending?.id) {
        clearTimeout(this.ackTimer);
        if (this.input.value.replace(/\r\n?/g, "\n").trim() === this.pending.text) this.input.value = "";
        this.pending = null; this.error.textContent = "";
      }
    }
    this.advanceCursor();
    const ordered = [...this.messages.keys()].sort((a,b) => a-b).slice(-100), retained = new Set(ordered);
    for (const id of this.messages.keys()) if (!retained.has(id)) this.messages.delete(id);
    for (const [id, node] of this.nodes) if (!retained.has(id)) { node.remove(); this.nodes.delete(id); }
    for (const [index, id] of ordered.entries()) {
      let node = this.nodes.get(id);
      if (!node) {
        const message = this.messages.get(id);
        node = document.createElement("li"); node.className = "chat-message";
        if (message.member_id === this.memberId) node.classList.add("own");
        const meta = document.createElement("div"); meta.className = "chat-message-meta";
        const name = document.createElement("strong"); name.textContent = message.name;
        const time = document.createElement("time");
        time.dateTime = new Date(message.sent_at).toISOString();
        time.textContent = new Date(message.sent_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
        const body = document.createElement("p"); body.textContent = message.text;
        meta.append(name, time); node.append(meta, body); this.nodes.set(id, node);
      }
      if (this.list.children[index] !== node) this.list.insertBefore(node, this.list.children[index] || null);
    }
    document.getElementById("room-chat-empty").hidden = ordered.length > 0;
    if (scrollBottom && this.open) this.list.scrollTop = this.list.scrollHeight;
    this.renderBadge();
  }

  advanceCursor() {
    // Live broadcasts may finish out of order. Reconnect must request gaps,
    // rather than skipping them after seeing a newer message ID.
    while (this.messages.has(this.latest + 1)) this.latest++;
  }

  setOpen(open) {
    this.open = open; this.panel.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    this.list.setAttribute("aria-live", open ? "polite" : "off");
    if (open) { this.unread = 0; this.list.scrollTop = this.list.scrollHeight; this.input.focus(); }
    this.renderBadge();
  }

  renderBadge() {
    const badge = document.getElementById("room-chat-unread");
    badge.hidden = !this.unread; badge.textContent = this.unread > 99 ? "99+" : String(this.unread);
    this.toggle.setAttribute("aria-label", this.unread ? `房间聊天，${this.unread} 条未读消息` : "房间聊天");
  }

  renderControls() {
    const length = [...this.input.value.trim()].length;
    document.getElementById("room-chat-count").textContent = `${length}/300`;
    document.getElementById("room-chat-status").textContent = !this.online ? "连接中…" : this.synced ? "房间内所有人可见" : this.syncing ? "正在同步消息…" : "消息尚未同步";
    this.button.disabled = !this.online || !this.synced || !!this.pending?.waiting || !length || length > 300;
    this.button.textContent = this.pending?.waiting ? "发送中…" : "发送";
    this.retry.hidden = !this.online || this.synced || this.syncing;
  }
}
