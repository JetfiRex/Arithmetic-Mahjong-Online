"""Validated CLI/environment configuration for local and single-instance hosting."""

import argparse
from dataclasses import dataclass
import math
import os

from multiplayer.security import WebSettings


@dataclass(frozen=True)
class HostingConfig:
    host: str
    port: int
    web: WebSettings
    disconnect_seconds: float
    grace_seconds: float
    session_ttl_seconds: float


def load_config(argv=None, *, environ=None):
    env = os.environ if environ is None else environ
    cloud = bool(env.get("PORT") or env.get("RENDER_EXTERNAL_URL"))
    parser = argparse.ArgumentParser(description="算术麻将网页联机；单实例单 worker，重启清空牌局。")
    parser.add_argument("--host", default=env.get("HOST", "0.0.0.0" if cloud else "127.0.0.1"))
    parser.add_argument("--port", type=int, default=env.get("PORT", "8771"))
    parser.add_argument("--public-origin", default=env.get("PUBLIC_ORIGIN") or env.get("RENDER_EXTERNAL_URL"),
                        help="正式网站的精确 HTTPS 地址；Render 默认读取 RENDER_EXTERNAL_URL")
    parser.add_argument("--disconnect-seconds", type=float, default=env.get("DISCONNECT_SECONDS", "10"))
    parser.add_argument("--grace-seconds", type=float, default=env.get("GRACE_SECONDS", "300"))
    parser.add_argument("--session-ttl-seconds", type=float, default=env.get("SESSION_TTL_SECONDS", "3600"),
                        help="断线身份与全员离线房间的保留时间，默认一小时")
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.port <= 65535:
            raise ValueError("PORT must be between 1 and 65535")
        if not args.host or any(c.isspace() for c in args.host):
            raise ValueError("HOST must be a bind address")
        for key in ("WEB_CONCURRENCY", "UVICORN_WORKERS"):
            if env.get(key, "1") != "1":
                raise ValueError(f"{key} must be 1: rooms are held in one process")
        intervals = (args.disconnect_seconds, args.grace_seconds, args.session_ttl_seconds)
        if any(not math.isfinite(value) or value <= 0 for value in intervals):
            raise ValueError("Runtime intervals must be positive finite numbers")
        if args.session_ttl_seconds < args.disconnect_seconds + args.grace_seconds:
            raise ValueError("SESSION_TTL_SECONDS must cover disconnect and reconnect grace periods")
        if args.public_origin and not args.public_origin.startswith("https://"):
            raise ValueError("PUBLIC_ORIGIN must use HTTPS")
        if args.host not in {"127.0.0.1", "localhost", "::1"} and not args.public_origin:
            raise ValueError("A public bind requires PUBLIC_ORIGIN (or RENDER_EXTERNAL_URL) and INVITE_CODE")
        origins = [f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"]
        if args.public_origin:
            origins.append(args.public_origin)
        web = WebSettings(tuple(origins), invite_code=env.get("INVITE_CODE", ""))
        if args.host not in {"127.0.0.1", "localhost", "::1"} and not web.invite_code:
            raise ValueError("A public bind requires INVITE_CODE")
        return HostingConfig(args.host, args.port, web, *intervals)
    except ValueError as exc:
        parser.error(str(exc))
