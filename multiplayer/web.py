"""Single-worker ASGI hosting entry with invitation-gated ephemeral guests."""

import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
from threading import Event, Thread
import time
import anyio

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from multiplayer.rooms import RoomError
from multiplayer.hosting import load_config
from multiplayer.bot_rooms import BotRooms
from multiplayer.bot_worker import OnDemandPolicyWorker
from multiplayer.model_bundle import load_bundle
from multiplayer.security import IngressMiddleware, RateLimits, WebSettings
from multiplayer.chat import ChatHub


ROOT = Path(__file__).resolve().parents[1]
SHARED_STATIC = ROOT / "UI" / "static"
LOCAL_STATIC = Path(__file__).parent / "static"
PICTURES = ROOT / "pictures"
TILE_NAMES = {f"{i}.png" for i in range(21)} | {"24.png", "plus.png", "mult.png", "app_icon.png"}
TILE_ATLAS = "tiles-4c6895cd818e.png"
ASSETS = {"icons.svg", "tile-back.svg", "LICENSE-lucide.txt", TILE_ATLAS}


def online_rooms(**kwargs):
    models, info = load_bundle()
    return BotRooms(OnDemandPolicyWorker(models=models, model_info=info), practice=False, **kwargs)


def create_app(*, settings=None, runtime=None):
    settings = settings or WebSettings(("http://127.0.0.1:8771", "http://localhost:8771"))
    rooms = runtime or online_rooms()
    limits = RateLimits()
    chat = ChatHub(rooms)

    @asynccontextmanager
    async def lifespan(app):
        prepare = getattr(rooms, "prepare", None)
        if callable(prepare):
            await run_in_threadpool(prepare)
        app.state.last_tick_at = time.monotonic()
        stop = Event()

        def advance():
            while not stop.wait(0.1):
                try:
                    rooms.tick()
                    app.state.last_tick_at = time.monotonic()
                except Exception:
                    # Do not continue a table after an unexpected partial tick.
                    app.state.runtime_failed = True
                    logging.getLogger(__name__).error("Game runtime stopped; restart the opening to reset")
                    return
        worker = Thread(target=advance, name="multiplayer-tick", daemon=True)
        worker.start()
        try:
            yield
        finally:
            stop.set()
            await asyncio.to_thread(worker.join)
            close = getattr(rooms, "close", None)
            if callable(close):
                await run_in_threadpool(close)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.rooms = rooms
    app.state.runtime_failed = False
    app.state.last_tick_at = time.monotonic()
    app.state.pending_sockets = 0
    app.add_middleware(IngressMiddleware, settings=settings)

    def healthy():
        if app.state.runtime_failed or time.monotonic() - app.state.last_tick_at > 10:
            raise HTTPException(503, "游戏运行已暂停，请管理员重新开服")

    def token_from(request):
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not 1 <= len(authorization) <= 256:
            raise HTTPException(401, "身份已失效，请重新进入")
        token = authorization[7:]
        with rooms.lock:
            try:
                rooms.tick()
                rooms.client(token)
            except RoomError:
                raise HTTPException(401, "服务器已重新开服或身份已失效") from None
        return token

    async def body_from(request):
        try:
            body = json.loads(await request.body(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            if type(body) is not dict:
                raise ValueError()
            return body
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, "请提交有效 JSON 对象") from None

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.api_route("/healthz", methods=["GET", "HEAD"])
    def health():
        healthy()
        return {"ok": True, "server_instance_id": rooms.instance_id}

    @app.post("/api/local/session")
    async def session(request: Request):
        healthy()
        body = await body_from(request)
        if not limits.take("sessions", rate=1, burst=12):
            raise HTTPException(429, "创建身份过快，请稍后再试")
        if not settings.accepts_invite(body.get("invite_code")):
            return JSONResponse({"error": "请输入有效的朋友邀请码", "code": "invite_required"}, status_code=403)
        try:
            token = await run_in_threadpool(rooms.new_client)
        except RoomError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"token": token, "server_instance_id": rooms.instance_id}

    @app.get("/api/local/state")
    def state(request: Request):
        healthy()
        token = token_from(request)
        with rooms.lock:
            rooms.tick()
            try:
                return rooms.view(token)
            except RoomError:
                raise HTTPException(401, "身份已切换或失效，请重新进入") from None

    @app.post("/api/local/action")
    async def action(request: Request):
        healthy()
        token = token_from(request)
        command = await body_from(request)
        if command.get("type") in {"create", "join"}:
            # Bound costly password hashing separately from cheap state reads.
            if not limits.take("passwords", rate=3, burst=8) or not limits.take((token, "password"), rate=0.5, burst=3):
                raise HTTPException(429, "尝试房间过快，请稍后再试")
        try:
            result = await run_in_threadpool(rooms.dispatch, token, command)
            return {"state": result}
        except (ValueError, KeyError, TypeError) as exc:
            message = str(exc) if isinstance(exc, ValueError) else "操作参数不正确"
            try:
                current = rooms.view(token)
            except RoomError:
                raise HTTPException(401, "身份已切换或失效，请重新进入") from None
            return JSONResponse({"error": message, "state": current}, status_code=400)

    @app.get("/api/local/wall-record")
    def wall(request: Request):
        healthy()
        token = token_from(request)
        query = request.query_params
        if set(query) != {"room_id", "round_id"} or any(len(query.getlist(key)) != 1 for key in query):
            raise HTTPException(400, "请指定当前房间和结算局")
        try:
            with rooms.lock:
                rooms.tick()
                return {"wall_record": rooms.wall_record(token, room_id=query["room_id"], round_id=query["round_id"])}
        except RoomError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.websocket("/api/local/presence")
    async def presence(socket: WebSocket):
        if app.state.pending_sockets >= 32 or app.state.runtime_failed:
            await socket.close(code=1013)
            return
        app.state.pending_sockets += 1
        token, connection = None, None
        pending = True
        peer, tasks = None, []
        try:
            await socket.accept()
            raw = await asyncio.wait_for(socket.receive_text(), timeout=5)
            if len(raw) > 512:
                raise ValueError("Oversized handshake")
            hello = json.loads(raw)
            if type(hello) is not dict or set(hello) != {"token", "server_instance_id"} or type(hello["token"]) is not str or len(hello["token"]) > 128:
                raise ValueError("Invalid handshake")
            token = hello["token"]
            connection = await run_in_threadpool(rooms.open_connection, token, instance_id=hello["server_instance_id"])
            app.state.pending_sockets -= 1
            pending = False
            await socket.send_json({"ready": True, "connection_id": connection, "server_instance_id": rooms.instance_id})
            peer = chat.attach(token, connection)

            async def read_messages():
                while True:
                    try:
                        raw = await asyncio.wait_for(socket.receive_text(), timeout=5)
                    except TimeoutError:
                        def connected():
                            with rooms.lock:
                                client = rooms.client(token)
                                if connection not in rooms.presence[client.member_id].connections:
                                    raise RoomError("连接已失效")
                        await run_in_threadpool(connected)
                        continue
                    if raw == "ping":
                        if not limits.take((connection, "ws"), rate=0.5, burst=3):
                            raise RoomError("心跳请求过快")
                        chat.enqueue(peer, "pong")
                        continue
                    # Bound parsing and error replies too. Backpressure keeps a
                    # chat flood off the event loop without closing presence.
                    if not chat.limits.take(connection, rate=5, burst=10):
                        chat.error(peer, "聊天操作太快，请稍等一下")
                        await asyncio.sleep(0.2)
                        continue
                    if len(raw) > 4096:
                        chat.error(peer, "聊天请求过长")
                        continue
                    try:
                        packet = json.loads(raw)
                    except (ValueError, RecursionError):
                        chat.error(peer, "无效的聊天请求")
                        continue
                    await chat.handle(peer, packet)

            # One writer per socket; broadcasts never wait for another client's
            # network or hold the game lock while sending.
            tasks = [asyncio.create_task(read_messages()), asyncio.create_task(chat.write(peer, socket))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ValueError, KeyError, TypeError, RoomError, TimeoutError):
            await socket.close(code=4001)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except asyncio.CancelledError:
            pass
        finally:
            with anyio.CancelScope(shield=True):
                if peer is not None:
                    chat.detach(peer)
                for task in tasks:
                    task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                if pending:
                    app.state.pending_sockets -= 1
                if connection is not None:
                    await run_in_threadpool(rooms.close_connection, token, connection)

    @app.get("/")
    @app.get("/index.html")
    def index():
        html = (SHARED_STATIC / "index.html").read_text(encoding="utf-8")
        html = html.replace('<script src="/app.js" defer></script>', '<link rel="stylesheet" href="/multiplayer.css"><script src="/chat.js" defer></script><script src="/multiplayer.js" defer></script><script src="/app.js" defer></script>')
        html = html.replace('<body>', '<body class="local-multiplayer">')
        html = html.replace('</header>', '</header>' + (LOCAL_STATIC / "controls.html").read_text(encoding="utf-8"), 1)
        return HTMLResponse(html)

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    def asset(path: str):
        paths = {"app.js": SHARED_STATIC / "app.js", "styles.css": SHARED_STATIC / "styles.css",
                 "reference.js": SHARED_STATIC / "reference.js",
                 "multiplayer.js": LOCAL_STATIC / "client.js", "multiplayer.css": LOCAL_STATIC / "local.css",
                 "chat.js": LOCAL_STATIC / "chat.js"}
        if path.startswith("tiles/") and path[6:] in TILE_NAMES:
            return FileResponse(PICTURES / path[6:])
        if path.startswith("assets/") and path[7:] in ASSETS:
            headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path[7:] == TILE_ATLAS else None
            return FileResponse(SHARED_STATIC / "assets" / path[7:], headers=headers)
        if path in paths:
            return FileResponse(paths[path])
        raise HTTPException(404, "接口或资源不存在")

    return app


def main():
    config = load_config()
    app = create_app(settings=config.web, runtime=online_rooms(
        disconnect_seconds=config.disconnect_seconds, grace_seconds=config.grace_seconds,
        session_ttl_seconds=config.session_ttl_seconds))
    print(f"Opening: {config.web.origins[-1]}", flush=True)
    print(f"Memory only; reset on every process start. Invitations: {'enabled' if config.web.invite_code else 'local testing'}.", flush=True)
    import uvicorn
    uvicorn.run(app, host=config.host, port=config.port, workers=1, reload=False, proxy_headers=False,
                access_log=False, server_header=False, ws="websockets", ws_max_size=4096, ws_max_queue=4,
                ws_ping_interval=5, ws_ping_timeout=10, ws_per_message_deflate=False,
                limit_concurrency=512, timeout_keep_alive=5, timeout_graceful_shutdown=3)


if __name__ == "__main__":
    main()
