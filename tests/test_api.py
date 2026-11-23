import io
import json
import os
import time
import zipfile

from fastapi.testclient import TestClient
from PIL import Image
import pytest


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    os.environ["DATA_DIR"] = str(tmp_path_factory.mktemp("file-handler"))
    from backend.app import app

    with TestClient(app) as instance:
        yield instance


def image_bytes(size=(96, 64)):
    image = Image.new("RGBA", size, (210, 40, 70, 128))
    stream = io.BytesIO()
    image.save(stream, "PNG", pnginfo=None)
    return stream.getvalue()


def submit(client, options=None, content=None, name="test.png"):
    return client.post("/api/jobs", files={"file": (name, content or image_bytes(), "image/png")}, data={"options": json.dumps(options or {})})


def wait(client, job_id):
    for _ in range(150):
        job = client.get("/api/jobs/" + job_id).json()
        if job["status"] not in ("queued", "processing"):
            assert job["status"] == "done", job
            return job
        time.sleep(0.05)
    pytest.fail("Image job exceeded timeout")


@pytest.mark.parametrize("fmt", ["png", "jpg", "webp", "avif", "tiff", "bmp", "ico", "gif", "pdf"])
def test_output_formats_are_real(client, fmt):
    response = submit(client, {"format": fmt})
    assert response.status_code == 202, response.text
    job = wait(client, response.json()["id"])
    output = client.get(job["download"])
    assert output.status_code == 200
    assert "attachment" in output.headers["content-disposition"]
    if fmt == "pdf":
        assert output.content.startswith(b"%PDF")
    else:
        image = Image.open(io.BytesIO(output.content))
        assert image.format == {"jpg": "JPEG", "tiff": "TIFF"}.get(fmt, fmt.upper())
        image.load()
        if fmt in ("png", "webp", "avif", "tiff"):
            assert image.mode == "RGBA"
            assert abs(image.getpixel((10, 10))[3] - 128) <= 1
    assert job["meta"]["output_size"] == len(output.content)


def test_resize_rotate_and_zip(client):
    response = submit(client, {"tool": "resize", "width": 48, "rotate": 90, "format": "png"})
    job = wait(client, response.json()["id"])
    assert (job["meta"]["output_width"], job["meta"]["output_height"]) == (32, 48)
    bundle = client.post("/api/bundle", json={"ids": [job["id"], job["id"]]})
    assert bundle.status_code == 200
    with zipfile.ZipFile(io.BytesIO(bundle.content)) as archive:
        assert len(archive.namelist()) == 1
        image = Image.open(archive.open(archive.namelist()[0]))
        assert image.size == (32, 48)
    assert client.delete("/api/jobs/" + job["id"]).status_code == 200
    assert client.get(job["download"]).status_code == 404


def test_upscale_fast_preserves_transparency(client):
    response = submit(client, {"tool": "upscale", "mode": "fast", "scale": 4, "format": "png"})
    job = wait(client, response.json()["id"])
    output = Image.open(io.BytesIO(client.get(job["download"]).content))
    assert output.size == (384, 256)
    assert output.getpixel((100, 100))[3] == 128


def test_private_metadata_and_exif_orientation(client):
    image = Image.new("RGB", (80, 40), "red")
    exif = Image.Exif()
    exif[274] = 6
    exif[315] = "Private author"
    stream = io.BytesIO()
    image.save(stream, "JPEG", exif=exif)
    response = submit(client, {"format": "jpg"}, stream.getvalue(), "private.jpg")
    job = wait(client, response.json()["id"])
    output = Image.open(io.BytesIO(client.get(job["download"]).content))
    assert output.size == (40, 80)
    assert not output.getexif()


def test_jpg_flattens_alpha_on_selected_color(client):
    response = submit(client, {"format": "jpg", "background": "#0000ff", "quality": 100})
    job = wait(client, response.json()["id"])
    output = Image.open(io.BytesIO(client.get(job["download"]).content))
    pixel = output.getpixel((10, 10))
    assert pixel[2] > 150
    assert 102 <= pixel[0] <= 108


def test_rejects_invalid_files_and_options(client):
    assert submit(client, content=b"<svg><script>alert(1)</script></svg>", name="bad.svg").status_code == 422
    assert submit(client, {"format": "../../etc/passwd"}).status_code == 422
    assert submit(client, {"scale": 8}).status_code == 422
    assert submit(client, {"tool": "resize"}).status_code == 422
    assert submit(client, {"background": "url(http://evil)"}).status_code == 422
    assert client.get("/api/jobs/not-an-id/download").status_code == 404
    assert client.post("/api/bundle", json={"ids": []}).status_code == 422


def test_rejects_animation(client):
    stream = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(stream, "GIF", save_all=True, append_images=[Image.new("RGB", (20, 20), "blue")], duration=100)
    response = submit(client, content=stream.getvalue(), name="animated.gif")
    assert response.status_code == 422


def test_cross_origin_upload_is_rejected(client):
    response = client.post("/api/jobs", headers={"Origin": "https://example.com"}, files={"file": ("test.png", image_bytes(), "image/png")})
    assert response.status_code == 403


def test_history_only_returns_requested_jobs(client):
    assert client.get("/api/jobs").json() == []
    response = submit(client)
    job = wait(client, response.json()["id"])
    jobs = client.get("/api/jobs?ids=" + job["id"]).json()
    assert len(jobs) == 1 and jobs[0]["id"] == job["id"]


def test_cancellation_wins_over_queued_and_processing_workers(client, monkeypatch):
    import threading
    from backend import app as module

    entered = threading.Event()
    release = threading.Event()

    def slow_transform(image, options, progress, cancelled):
        entered.set()
        assert release.wait(5)
        return image

    monkeypatch.setattr(module, "transform", slow_transform)
    first = submit(client, {"tool": "remove", "format": "png"}).json()
    assert entered.wait(2)
    second = submit(client, {"tool": "remove", "format": "png"}).json()
    try:
        assert client.get("/api/jobs/" + second["id"]).json()["status"] == "queued"
        assert client.delete("/api/jobs/" + second["id"]).status_code == 200
        assert client.delete("/api/jobs/" + first["id"]).status_code == 200
    finally:
        release.set()
    time.sleep(0.1)
    for job in (first, second):
        assert client.get("/api/jobs/" + job["id"]).json()["status"] == "cancelled"
        assert client.get(job["download"]).status_code == 404


def test_expired_files_are_removed_with_their_history(client, monkeypatch):
    from backend import app as module

    job = wait(client, submit(client).json()["id"])
    monkeypatch.setattr(module, "TTL", -1)
    module.cleanup()
    assert not (module.DATA / job["id"]).exists()
    assert client.get("/api/jobs/" + job["id"]).status_code == 404
