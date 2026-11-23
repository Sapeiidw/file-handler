"""Download verified model files once. Inference never contacts an external API."""

import hashlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "models"
MODELS = {
    "birefnet-general.onnx": (
        "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx",
        "md5",
        "7a35a0141cbbc80de11d9c9a28f52697",
    ),
    "birefnet-lite.onnx": (
        "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
        "md5",
        "4fab47adc4ff364be1713e97b7e66334",
    ),
    "realesrgan-x4.onnx": (
        "https://huggingface.co/skillsafe-ai/realesrgan-x4plus/resolve/main/model.onnx",
        "sha256",
        "4851ec156207d271f5328605d0582eeb851e656227da8aca093ced9e60789291",
    ),
}


def download(item):
    name, (url, algorithm, checksum) = item
    target = ROOT / name
    if target.exists() and hashlib.file_digest(target.open("rb"), algorithm).hexdigest() == checksum:
        print(f"Verified: {name}", flush=True)
        return
    print(f"Downloading {name}...", flush=True)
    temporary = target.with_suffix(".part")
    urllib.request.urlretrieve(url, temporary)
    with temporary.open("rb") as stream:
        actual = hashlib.file_digest(stream, algorithm).hexdigest()
    if actual != checksum:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum mismatch: {name}: {actual}")
    temporary.replace(target)
    print(f"Ready: {name} ({target.stat().st_size // 1048576} MB)", flush=True)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, MODELS.items()))
