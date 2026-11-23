from functools import lru_cache
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps
import pillow_heif

pillow_heif.register_heif_opener()
Image.MAX_IMAGE_PIXELS = 40_000_000
MODEL_DIR = Path(os.getenv("MODEL_DIR", Path(__file__).resolve().parents[1] / "models"))
FORMATS = {"png": "PNG", "jpg": "JPEG", "webp": "WEBP", "avif": "AVIF", "tiff": "TIFF", "bmp": "BMP", "ico": "ICO", "gif": "GIF", "pdf": "PDF"}


@lru_cache(maxsize=2)
def session(name):
    path = MODEL_DIR / name
    if not path.exists():
        raise ValueError("Model AI belum tersedia. Jalankan scripts/download_models.py.")
    options = ort.SessionOptions()
    options.intra_op_num_threads = int(os.getenv("AI_THREADS", "4"))
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def read_image(path):
    with Image.open(path) as source:
        if source.width * source.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("Gambar maksimal 40 megapiksel.")
        if getattr(source, "n_frames", 1) > 1:
            raise ValueError("Gambar animasi/multipage belum didukung. Gunakan gambar satu frame.")
        source.load()
        icc = source.info.get("icc_profile")
        oriented = ImageOps.exif_transpose(source)
        image = oriented.convert("RGBA")
        # Convert embedded color profiles to sRGB before discarding private metadata.
        if icc:
            try:
                from io import BytesIO
                from PIL import ImageCms

                color_input = oriented if oriented.mode in ("RGB", "CMYK", "LAB") else oriented.convert("RGB")
                rgb = ImageCms.profileToProfile(color_input, ImageCms.ImageCmsProfile(BytesIO(icc)), ImageCms.createProfile("sRGB"), outputMode="RGB")
                rgb.putalpha(image.getchannel("A"))
                image = rgb
            except (ValueError, OSError, ImageCms.PyCMSError):
                pass
        return image


def preview(image, path):
    small = image.copy()
    small.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    small.info.clear()
    small.save(path, "WEBP", quality=90, method=4)


def remove_background(image, mode, progress, cancelled):
    progress(12, "Menyiapkan model segmentasi")
    model = session("birefnet-lite.onnx" if mode == "fast" else "birefnet-general.onnx")
    rgb = np.asarray(image.convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
    rgb = (rgb - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    tensor = rgb.transpose(2, 0, 1)[None]
    progress(25, "Memisahkan subjek dan detail tepi")
    pred = model.run(None, {model.get_inputs()[0].name: tensor})[0].squeeze()
    if cancelled():
        raise InterruptedError
    pred = 1 / (1 + np.exp(-np.clip(pred, -80, 80)))
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / (hi - lo) if hi - lo > 1e-6 else pred
    mask = Image.fromarray((pred * 255).clip(0, 255).astype(np.uint8)).resize(image.size, Image.Resampling.LANCZOS)
    image.putalpha(ImageChops.multiply(image.getchannel("A"), mask))
    progress(85, "Menyempurnakan transparansi")
    return image


def upscale(image, scale, mode, progress, cancelled):
    width, height = image.size
    if width * height * scale * scale > 60_000_000:
        raise ValueError("Hasil upscale maksimal 60 megapiksel. Pilih skala lebih kecil.")
    if mode == "fast":
        progress(45, "Upscale Lanczos berkualitas tinggi")
        return image.resize((width * scale, height * scale), Image.Resampling.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1, percent=110, threshold=3))
    if width * height > 2_000_000:
        raise ValueError("AI upscale di CPU maksimal input 2 MP. Gunakan mode Cepat untuk gambar lebih besar.")
    model = session("realesrgan-x4.onnx")
    tile, pad = 192, 16
    result = Image.new("RGB", (width * 4, height * 4))
    rgb = image.convert("RGB")
    total = ((width + tile - 1) // tile) * ((height + tile - 1) // tile)
    done = 0
    for top in range(0, height, tile):
        for left in range(0, width, tile):
            if cancelled():
                raise InterruptedError
            right, bottom = min(left + tile, width), min(top + tile, height)
            x0, y0, x1, y1 = max(0, left - pad), max(0, top - pad), min(width, right + pad), min(height, bottom + pad)
            patch = np.asarray(rgb.crop((x0, y0, x1, y1)), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
            output = model.run(None, {model.get_inputs()[0].name: patch})[0][0].transpose(1, 2, 0)
            block = Image.fromarray(np.rint(output.clip(0, 1) * 255).astype(np.uint8))
            result.paste(block.crop(((left - x0) * 4, (top - y0) * 4, (right - x0) * 4, (bottom - y0) * 4)), (left * 4, top * 4))
            done += 1
            progress(10 + round(80 * done / total), f"Merekonstruksi detail · {done}/{total} tile")
    if scale != 4:
        result = result.resize((width * scale, height * scale), Image.Resampling.LANCZOS)
    result.putalpha(image.getchannel("A").resize(result.size, Image.Resampling.LANCZOS))
    return result


def transform(image, options, progress, cancelled):
    tool = options["tool"]
    progress(5, "Membaca gambar")
    if tool == "remove":
        image = remove_background(image, options["mode"], progress, cancelled)
    elif tool == "upscale":
        image = upscale(image, options["scale"], options["mode"], progress, cancelled)
    elif tool == "resize":
        width, height = options.get("width"), options.get("height")
        if not width and not height:
            raise ValueError("Isi lebar atau tinggi tujuan.")
        width = width or max(1, round(image.width * height / image.height))
        height = height or max(1, round(image.height * width / image.width))
        if width * height > 60_000_000:
            raise ValueError("Hasil resize maksimal 60 megapiksel.")
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    elif tool == "adjust":
        alpha = image.getchannel("A")
        rgb = image.convert("RGB")
        rgb = ImageEnhance.Brightness(rgb).enhance(options["brightness"] / 100)
        rgb = ImageEnhance.Contrast(rgb).enhance(options["contrast"] / 100)
        rgb = ImageEnhance.Color(rgb).enhance(options["saturation"] / 100)
        image = rgb.convert("RGBA")
        image.putalpha(alpha)
    rotate = options.get("rotate", 0)
    if rotate:
        image = image.rotate(-rotate, expand=True)
    if options.get("flip"):
        image = ImageOps.mirror(image)
    return image


def save_image(image, target, options):
    fmt, quality = options["format"], options["quality"]
    # PNG/WebP/AVIF/TIFF/ICO preserve alpha; flatten other formats explicitly.
    if fmt in ("jpg", "bmp", "pdf", "gif"):
        background = Image.new("RGBA", image.size, options["background"])
        background.alpha_composite(image)
        image = background.convert("RGB")
    image.info.clear()
    kwargs = {}
    if fmt == "jpg":
        kwargs = dict(quality=quality, subsampling=0, optimize=True, progressive=True)
    elif fmt == "webp":
        kwargs = dict(quality=quality, lossless=options["lossless"], method=6)
    elif fmt == "avif":
        kwargs = dict(quality=quality, speed=6, max_threads=2)
    elif fmt == "png":
        kwargs = dict(compress_level=6, optimize=False)
    elif fmt == "tiff":
        kwargs = dict(compression="tiff_lzw")
    elif fmt == "ico":
        image.thumbnail((256, 256), Image.Resampling.LANCZOS)
        kwargs = dict(sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    image.save(target, FORMATS[fmt], **kwargs)
    return image.size
