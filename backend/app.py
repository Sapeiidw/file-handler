import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import threading
import time
import uuid
import warnings
import zipfile

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, field_validator
from PIL import Image, UnidentifiedImageError
from starlette.background import BackgroundTask

from .imaging import FORMATS, MODEL_DIR, preview, read_image, save_image, transform

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.getenv("DATA_DIR", ROOT / "data"))
DATA.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD = 50 * 1024 * 1024
TTL = int(os.getenv("RETENTION_HOURS", "24")) * 3600
MAX_STORAGE = int(os.getenv("MAX_STORAGE_MB", "5120")) * 1024 * 1024
log = logging.getLogger("file-handler")
DB = DATA / "jobs.sqlite3"
LOCK = threading.RLock()
POOLS = {"ai": ThreadPoolExecutor(max_workers=1), "image": ThreadPoolExecutor(max_workers=2)}
ADMISSION = asyncio.Lock()


def connect():
    db = sqlite3.connect(DB, timeout=30)
    db.row_factory = sqlite3.Row
    return db


with connect() as db:
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, name TEXT, tool TEXT, status TEXT, progress INTEGER, message TEXT, created REAL, updated REAL, options TEXT, meta TEXT, error TEXT)"
    )


class Options(BaseModel):
    tool: str = "convert"
    format: str = "webp"
    quality: int = Field(default=90, ge=1, le=100)
    lossless: bool = False
    mode: str = "quality"
    scale: int = Field(default=2)
    width: int | None = Field(default=None, ge=1, le=16000)
    height: int | None = Field(default=None, ge=1, le=16000)
    rotate: int = 0
    flip: bool = False
    background: str = "#ffffff"
    brightness: int = Field(default=100, ge=0, le=200)
    contrast: int = Field(default=100, ge=0, le=200)
    saturation: int = Field(default=100, ge=0, le=200)

    @field_validator("tool")
    @classmethod
    def valid_tool(cls, value):
        if value not in ("convert", "remove", "upscale", "compress", "resize", "adjust"):
            raise ValueError("Tool tidak dikenal.")
        return value

    @field_validator("format")
    @classmethod
    def valid_format(cls, value):
        if value not in FORMATS:
            raise ValueError("Format output tidak didukung.")
        return value

    @field_validator("mode")
    @classmethod
    def valid_mode(cls, value):
        if value not in ("quality", "fast"):
            raise ValueError("Mode tidak valid.")
        return value

    @field_validator("scale")
    @classmethod
    def valid_scale(cls, value):
        if value not in (2, 4):
            raise ValueError("Skala harus 2 atau 4.")
        return value

    @field_validator("rotate")
    @classmethod
    def valid_rotate(cls, value):
        if value not in (0, 90, 180, 270):
            raise ValueError("Rotasi tidak valid.")
        return value

    @field_validator("background")
    @classmethod
    def valid_color(cls, value):
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise ValueError("Warna background tidak valid.")
        return value


def fetch(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(404, "File tidak ditemukan.")
    with connect() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "File sudah dihapus atau kedaluwarsa.")
    return dict(row)


def public(row):
    result = {k: v for k, v in row.items() if k != "options"}
    result["meta"] = json.loads(result["meta"])
    result["options"] = json.loads(row["options"])
    result["preview"] = f"/api/jobs/{row['id']}/preview"
    result["original"] = f"/api/jobs/{row['id']}/original"
    result["download"] = f"/api/jobs/{row['id']}/download"
    return result


def update(job_id, **values):
    values["updated"] = time.time()
    with LOCK, connect() as db:
        # Cancel wins over any late worker progress/result.
        db.execute(f"UPDATE jobs SET {','.join(k + '=?' for k in values)} WHERE id=? AND status!=?", (*values.values(), job_id, "cancelled"))


def run_job(job_id):
    try:
        row = fetch(job_id)
        if row["status"] == "cancelled":
            return
        update(job_id, status="processing", progress=1, message="Memulai pemrosesan")
        directory = DATA / job_id
        options = json.loads(row["options"])
        image = read_image(directory / "source")

        def cancelled():
            return fetch(job_id)["status"] == "cancelled"

        def progress(amount, message):
            update(job_id, progress=amount, message=message)

        result = transform(image, options, progress, cancelled)
        if cancelled():
            return
        progress(93, "Menyimpan hasil berkualitas tinggi")
        width, height = save_image(result, directory / ("output." + options["format"]), options)
        preview(result, directory / "result.webp")
        meta = json.loads(row["meta"])
        meta.update(
            output_width=width,
            output_height=height,
            output_size=(directory / ("output." + options["format"])).stat().st_size,
            duration=round(time.time() - row["created"], 1),
        )
        update(job_id, status="done", progress=100, message="Selesai", meta=json.dumps(meta))
    except InterruptedError:
        pass
    except Exception as error:
        log.exception("Job failed: %s", job_id)
        message = str(error) if isinstance(error, ValueError) else "Pemrosesan gagal. Coba gambar lain atau mode Cepat."
        update(job_id, status="failed", error=message, message="Gagal diproses")


def cleanup():
    with LOCK, connect() as db:
        rows = db.execute("SELECT id FROM jobs WHERE created<? AND status NOT IN ('queued','processing')", (time.time() - TTL,)).fetchall()
        for row in rows:
            shutil.rmtree(DATA / row["id"], ignore_errors=True)
            db.execute("DELETE FROM jobs WHERE id=?", (row["id"],))
    for path in DATA.glob("bundle-*.zip"):
        if path.stat().st_mtime < time.time() - 3600:
            path.unlink(missing_ok=True)


async def janitor():
    while True:
        await asyncio.to_thread(cleanup)
        await asyncio.sleep(600)


@asynccontextmanager
async def lifespan(app):
    with connect() as db:
        db.execute(
            "UPDATE jobs SET status='failed', error='Service dimulai ulang. Proses ulang gambar ini.', message='Proses terhenti' WHERE status IN ('queued','processing')"
        )
    task = asyncio.create_task(janitor())
    yield
    task.cancel()
    for pool in POOLS.values():
        pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="File Handler", lifespan=lifespan, docs_url=None, openapi_url="/api/openapi.json")


@app.middleware("http")
async def headers(request, call_next):
    # Local tool: no cross-origin writes or external image forwarding.
    origin = request.headers.get("origin")
    if request.method in ("POST", "DELETE", "PUT") and origin:
        from urllib.parse import urlparse

        if urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Origin tidak diizinkan."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/docs", include_in_schema=False)
def docs():
    return HTMLResponse(
        """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>File Handler API</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/api-docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api-docs/swagger-ui-bundle.js"></script><script src="/api-docs-init.js"></script></body></html>"""
    )


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "engine": "ONNX Runtime · CPU",
        "retention_hours": TTL // 3600,
        "models": {name: (MODEL_DIR / name).is_file() for name in ("birefnet-general.onnx", "birefnet-lite.onnx", "realesrgan-x4.onnx")},
        "formats": list(FORMATS),
    }


@app.get("/api/jobs")
def list_jobs(ids: str = ""):
    values = [value for value in ids.split(",") if re.fullmatch("[a-f0-9]{32}", value)][:100]
    if not values:
        return []
    with connect() as db:
        rows = db.execute(f"SELECT * FROM jobs WHERE id IN ({','.join('?' for _ in values)}) ORDER BY created DESC", values).fetchall()
    return [public(dict(row)) for row in rows]


@app.post("/api/jobs", status_code=202)
async def create_job(file: UploadFile = File(...), options: str = Form("{}")):
    directory = None
    try:
        try:
            settings = Options.model_validate_json(options).model_dump()
        except (ValidationError, ValueError):
            raise HTTPException(422, "Pengaturan tidak valid. Periksa format, dimensi, dan kualitas.")
        async with ADMISSION:
            with connect() as db:
                pending = db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','processing')").fetchone()[0]
            if pending >= 60:
                raise HTTPException(429, "Antrean penuh. Tunggu beberapa proses selesai.")
            used = await asyncio.to_thread(lambda: sum(p.stat().st_size for p in DATA.rglob("*") if p.is_file()))
            if used + MAX_UPLOAD > MAX_STORAGE:
                raise HTTPException(507, "Penyimpanan penuh. Hapus file di riwayat terlebih dahulu.")
            job_id = uuid.uuid4().hex
            directory = DATA / job_id
            directory.mkdir(mode=0o700)
            size = 0
            with (directory / "source").open("wb") as stream:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "Ukuran file maksimal 50 MB.")
                    stream.write(chunk)
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    image = await asyncio.to_thread(read_image, directory / "source")
                width, height = image.size
                if settings["tool"] == "resize" and not (settings["width"] or settings["height"]):
                    raise ValueError("Isi lebar atau tinggi tujuan.")
                if settings["tool"] == "upscale":
                    if width * height * settings["scale"] ** 2 > 60_000_000:
                        raise ValueError("Hasil upscale maksimal 60 MP. Pilih skala lebih kecil.")
                    if settings["mode"] == "quality" and width * height > 2_000_000:
                        raise ValueError("AI upscale di CPU maksimal input 2 MP. Pilih mode Cepat untuk gambar ini.")
                await asyncio.to_thread(preview, image, directory / "original.webp")
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
                raise HTTPException(422, str(error) if isinstance(error, ValueError) else "File gambar tidak valid, terlalu besar, atau format belum didukung.")
            name = Path((file.filename or "image").replace("\\", "/")).name[:180]
            now = time.time()
            with connect() as db:
                db.execute(
                    "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        job_id,
                        name,
                        settings["tool"],
                        "queued",
                        0,
                        "Menunggu antrean",
                        now,
                        now,
                        json.dumps(settings),
                        json.dumps({"width": width, "height": height, "size": size}),
                        None,
                    ),
                )
            pool = POOLS["ai" if settings["tool"] in ("remove", "upscale") and settings["mode"] == "quality" or settings["tool"] == "remove" else "image"]
            pool.submit(run_job, job_id)
        return public(fetch(job_id))
    except BaseException:
        if directory is not None:
            shutil.rmtree(directory, ignore_errors=True)
        raise
    finally:
        await file.close()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return public(fetch(job_id))


@app.get("/api/jobs/{job_id}/{kind}")
def get_file(job_id: str, kind: str):
    row = fetch(job_id)
    directory = DATA / job_id
    if kind == "original":
        path = directory / "original.webp"
    elif kind == "preview" and row["status"] == "done":
        path = directory / "result.webp"
    elif kind == "download" and row["status"] == "done":
        fmt = json.loads(row["options"])["format"]
        path = directory / ("output." + fmt)
        filename = Path(row["name"]).stem + "-file-handler." + fmt
        return FileResponse(path, filename=filename)
    else:
        raise HTTPException(404, "Hasil belum tersedia.")
    if not path.is_file():
        raise HTTPException(404, "File sudah dihapus.")
    return FileResponse(path, media_type="image/webp")


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    with LOCK:
        row = fetch(job_id)
        if row["status"] in ("queued", "processing"):
            with connect() as db:
                db.execute("UPDATE jobs SET status='cancelled', message='Dibatalkan', updated=? WHERE id=?", (time.time(), job_id))
        elif row["status"] == "cancelled":
            # Keep files until worker exits; the scheduled cleanup reclaims them.
            return {"ok": True}
        else:
            with connect() as db:
                db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
            shutil.rmtree(DATA / job_id, ignore_errors=True)
    return {"ok": True}


class Bundle(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)


@app.post("/api/bundle")
def bundle(body: Bundle):
    path = DATA / f"bundle-{uuid.uuid4().hex}.zip"
    try:
        with LOCK, zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            for index, job_id in enumerate(dict.fromkeys(body.ids), 1):
                row = fetch(job_id)
                if row["status"] != "done":
                    raise HTTPException(409, "Tunggu semua file selesai sebelum download ZIP.")
                fmt = json.loads(row["options"])["format"]
                archive.write(DATA / job_id / ("output." + fmt), f"{index:02d}-{Path(row['name']).stem}.{fmt}")
        return FileResponse(path, media_type="application/zip", filename="file-handler-results.zip", background=BackgroundTask(path.unlink, missing_ok=True))
    except BaseException:
        path.unlink(missing_ok=True)
        raise


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
