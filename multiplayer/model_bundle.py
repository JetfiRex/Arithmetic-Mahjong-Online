"""Only the three reviewed inference exports are included in deployment."""

import hashlib
from pathlib import Path
import tomllib

from multiplayer.play_model import FrozenModel


BUNDLE_ROOT = Path(__file__).parent / "models"


def load_bundle(root=BUNDLE_ROOT):
    root = Path(root).resolve()
    models, info = {}, {}
    try:
        manifest = tomllib.loads((root / "manifest.toml").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    for kind in ("nn", "rl", "cfr"):
        entry = manifest.get(kind, {})
        if not isinstance(entry, dict):
            info[kind] = {"available": False, "error": "部署模型清单格式无效"}
            continue
        filename = entry.get("file", "")
        try:
            if type(filename) is not str or not filename or Path(filename).name != filename:
                raise ValueError("缺少部署模型文件")
            path = root / filename
            limit = (128 if kind == "cfr" else 16) * 1024 * 1024
            with path.open("rb") as stream:
                data = stream.read(limit + 1)
            if not data or len(data) > limit:
                raise ValueError("部署模型为空或超过大小上限")
            digest = hashlib.sha256(data).hexdigest()
            if digest != entry.get("sha256"):
                raise ValueError("部署模型 SHA-256 不匹配")
            models[kind] = FrozenModel(path, digest, entry.get("source_name", filename))
            info[kind] = {"available": False, "error": "模型等待加载校验"}
        except (OSError, ValueError) as exc:
            info[kind] = {"available": False, "error": str(exc) if isinstance(exc, ValueError) else "部署模型文件缺失或无法读取"}
    return models, info
