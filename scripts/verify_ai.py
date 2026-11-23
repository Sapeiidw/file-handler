"""Exercise both segmentation models and tiled Real-ESRGAN on the bundled sample."""

import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from backend.imaging import preview, read_image, remove_background, upscale

root = Path(__file__).resolve().parents[1]
output = root / "data" / "verification"
output.mkdir(parents=True, exist_ok=True)
image = read_image(root / "frontend/public/sample.jpg")
report = {}
for mode in ("fast", "quality"):
    start = time.monotonic()
    cutout = remove_background(image.copy(), mode, lambda n, msg: print(f"{mode}: {n}% {msg}", flush=True), lambda: False)
    alpha = cutout.getchannel("A")
    low, high = alpha.getextrema()
    assert low < 10 and high > 245, (low, high)
    cutout.save(output / f"cutout-{mode}.png")
    preview(cutout, output / f"cutout-{mode}.webp")
    report[f"background_{mode}"] = {"seconds": round(time.monotonic() - start, 2), "input": image.size, "alpha_range": [low, high]}
small = image.copy()
small.thumbnail((240, 240), Image.Resampling.LANCZOS)
start = time.monotonic()
result = upscale(small, 4, "quality", lambda n, msg: print(f"upscale: {n}% {msg}", flush=True), lambda: False)
assert result.size == (small.width * 4, small.height * 4)
result.save(output / "upscaled.png")
small.save(output / "upscale-input.png")
report["upscale_ai"] = {"seconds": round(time.monotonic() - start, 2), "input": small.size, "output": result.size}
(output / "report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2), flush=True)
