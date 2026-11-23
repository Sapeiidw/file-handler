import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeftRight,
  ArrowDownToLine,
  ScanLine,
  ImagePlus,
  SlidersHorizontal,
  Minimize2,
  Maximize2,
  Crop,
  Plus,
  X,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  CircleHelp,
  Settings2,
  ShieldCheck,
  Layers3,
  FolderOpen,
  LoaderCircle,
  RotateCw,
  FlipHorizontal2,
  Trash2,
  ExternalLink,
  Zap,
  Sparkles,
  Image as ImageIcon,
  AlertCircle,
  MoveHorizontal,
  Command,
  FileImage,
  CircleDot,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./styles.css";

type Tool = "convert" | "remove" | "upscale" | "compress" | "resize" | "adjust";
type Job = {
  id: string;
  name: string;
  tool: Tool;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  error: string | null;
  created: number;
  preview: string;
  original: string;
  download: string;
  options: Options;
  meta: {
    width: number;
    height: number;
    size: number;
    output_width?: number;
    output_height?: number;
    output_size?: number;
    duration?: number;
  };
};
type Options = {
  tool: Tool;
  format: string;
  quality: number;
  lossless: boolean;
  mode: "quality" | "fast";
  scale: number;
  width: number | null;
  height: number | null;
  rotate: number;
  flip: boolean;
  background: string;
  brightness: number;
  contrast: number;
  saturation: number;
};
type Staged = { id: string; file: File; url: string };
type Health = {
  status: string;
  engine: string;
  retention_hours: number;
  models: Record<string, boolean>;
  formats: string[];
};
const tools: {
  id: Tool;
  label: string;
  title: string;
  desc: string;
  icon: LucideIcon;
  tag?: string;
}[] = [
  {
    id: "convert",
    label: "Konversi format",
    title: "Image converter",
    desc: "Format baru, kualitas tetap utuh. Buat gambarmu siap untuk apa saja.",
    icon: ArrowLeftRight,
  },
  {
    id: "remove",
    label: "Hapus background",
    title: "Background remover",
    desc: "Pisahkan subjek dengan presisi. Sampai ke detail paling kecil.",
    icon: ScanLine,
    tag: "AI",
  },
  {
    id: "upscale",
    label: "Upscale gambar",
    title: "Image upscaler",
    desc: "Lebih besar. Lebih tajam. Kembalikan detail dengan AI.",
    icon: Maximize2,
    tag: "AI",
  },
  {
    id: "compress",
    label: "Kompres gambar",
    title: "Image compressor",
    desc: "Ukuran lebih ringan, tampilan tetap memukau.",
    icon: Minimize2,
  },
  {
    id: "resize",
    label: "Resize & rotate",
    title: "Resize & rotate",
    desc: "Dimensi yang pas untuk setiap kebutuhanmu.",
    icon: Crop,
  },
  {
    id: "adjust",
    label: "Atur warna",
    title: "Color adjustment",
    desc: "Sedikit sentuhan untuk hasil yang lebih hidup.",
    icon: SlidersHorizontal,
  },
];
const defaults: Options = {
  tool: "convert",
  format: "webp",
  quality: 90,
  lossless: false,
  mode: "quality",
  scale: 2,
  width: null,
  height: null,
  rotate: 0,
  flip: false,
  background: "#ffffff",
  brightness: 100,
  contrast: 100,
  saturation: 100,
};
const formats = [
  { id: "webp", name: "WebP", hint: "Ringan & modern", badge: "REKOMENDASI" },
  { id: "png", name: "PNG", hint: "Lossless & transparan" },
  { id: "jpg", name: "JPG", hint: "Kompatibilitas luas" },
  { id: "avif", name: "AVIF", hint: "Kompresi efisien" },
  { id: "tiff", name: "TIFF", hint: "Arsip & cetak" },
  { id: "bmp", name: "BMP", hint: "Bitmap tanpa kompresi" },
  { id: "ico", name: "ICO", hint: "Ikon & favicon" },
  { id: "gif", name: "GIF", hint: "Gambar statis · 256 warna" },
  { id: "pdf", name: "PDF", hint: "Dokumen satu halaman" },
];
const bytes = (n: number) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
const loadIds = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem("fh-jobs") || "[]")
      .filter((s: unknown) => typeof s === "string")
      .slice(0, 100);
  } catch {
    return [];
  }
};
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = "Tidak dapat menghubungi service.";
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : msg;
    } catch {
      /* non-json proxy error */
    }
    throw new Error(msg);
  }
  return r.json();
}

function App() {
  const [tool, setTool] = useState<Tool>("convert");
  const [options, setOptions] = useState<Options>(defaults);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [ids, setIds] = useState<string[]>(loadIds);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [drag, setDrag] = useState(false);
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<"help" | "settings" | "history" | null>(
    null,
  );
  const [selected, setSelected] = useState<Job | null>(null);
  const [compare, setCompare] = useState(50);
  const [formatOpen, setFormatOpen] = useState(false);
  const [view, setView] = useState<"all" | "done">("all");
  const input = useRef<HTMLInputElement>(null);
  const stagedRef = useRef<Staged[]>([]);
  const active = tools.find((t) => t.id === tool)!;
  const done = jobs.filter((j) => j.status === "done");
  const pending = jobs.filter(
    (j) => j.status === "queued" || j.status === "processing",
  );
  const visibleJobs = (view === "done" ? done : jobs).slice(0, 8);
  const currentFormat = formats.find((f) => f.id === options.format)!;
  const unavailableAI =
    tool === "remove"
      ? !health?.models[
          options.mode === "fast"
            ? "birefnet-lite.onnx"
            : "birefnet-general.onnx"
        ]
      : tool === "upscale" && options.mode === "quality"
        ? !health?.models["realesrgan-x4.onnx"]
        : false;
  const overlayType = selected ? "preview" : modal;
  const setOption = <K extends keyof Options>(key: K, value: Options[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }));
  const chooseTool = (next: Tool) => {
    setTool(next);
    setOptions({
      ...defaults,
      tool: next,
      format: next === "remove" ? "png" : "webp",
      quality: next === "compress" ? 75 : 90,
    });
    setFormatOpen(false);
  };
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);
  useEffect(
    () => () => {
      stagedRef.current.forEach((s) => URL.revokeObjectURL(s.url));
    },
    [],
  );
  useEffect(() => {
    localStorage.setItem("fh-jobs", JSON.stringify(ids));
  }, [ids]);
  useEffect(() => {
    let live = true;
    const check = () =>
      api<Health>("/api/health")
        .then((h) => {
          if (live) setHealth(h);
        })
        .catch(() => {
          if (live) setHealth(null);
        });
    void check();
    const timer = setInterval(check, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!ids.length) {
      setJobs([]);
      return;
    }
    try {
      setJobs(await api<Job[]>("/api/jobs?ids=" + ids.join(",")));
    } catch (e) {
      setToast((e as Error).message);
    }
  }, [ids]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!ids.length) return;
    const timer = setInterval(
      () => {
        if (!document.hidden) void refresh();
      },
      pending.length ? 1500 : 30000,
    );
    return () => clearInterval(timer);
  }, [refresh, ids.length, pending.length]);
  useEffect(() => {
    setSelected((prev) =>
      prev ? jobs.find((j) => j.id === prev.id) || prev : null,
    );
  }, [jobs]);
  useEffect(() => {
    if (!overlayType) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const candidates = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],input:not([disabled]),[tabindex="0"]',
        ) || [],
      );
    candidates()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = candidates();
      if (!nodes.length) return;
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    document.body.style.overflow = "hidden";
    const surfaces = document.querySelectorAll<HTMLElement>(
      ".sidebar,.main-shell",
    );
    surfaces.forEach((el) => {
      el.inert = true;
    });
    return () => {
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = "";
      surfaces.forEach((el) => {
        el.inert = false;
      });
      previous?.focus();
    };
  }, [overlayType]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setModal(null);
        setFormatOpen(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        input.current?.click();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const addFiles = (files: File[]) => {
    const valid = files.filter((f) => {
      if (f.size > 50 * 1024 * 1024) {
        setToast(`${f.name}: ukuran maksimal 50 MB.`);
        return false;
      }
      if (
        !/\.(jpe?g|png|webp|avif|heic|heif|tiff?|bmp|ico|gif)$/i.test(f.name)
      ) {
        setToast(`${f.name}: format input belum didukung.`);
        return false;
      }
      return true;
    });
    setStaged((prev) => {
      if (prev.length + valid.length > 20)
        setToast("Maksimal 20 gambar per batch.");
      return [
        ...prev,
        ...valid.slice(0, 20 - prev.length).map((file) => ({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
        })),
      ];
    });
  };
  const removeStaged = (id: string) =>
    setStaged((prev) => {
      const s = prev.find((x) => x.id === id);
      if (s) URL.revokeObjectURL(s.url);
      return prev.filter((x) => x.id !== id);
    });
  const clearStaged = () => {
    staged.forEach((s) => URL.revokeObjectURL(s.url));
    setStaged([]);
  };
  const sample = async () => {
    try {
      const r = await fetch("/sample.jpg");
      if (!r.ok) throw new Error();
      addFiles([
        new File([await r.blob()], "red-sneaker.jpg", { type: "image/jpeg" }),
      ]);
    } catch {
      setToast("Gambar contoh belum tersedia. Silakan upload gambar sendiri.");
    }
  };
  const process = async () => {
    if (!staged.length || busy) return;
    setBusy(true);
    const batch = [...staged];
    let index = 0;
    const settings = { ...options, tool };
    const worker = async () => {
      while (index < batch.length) {
        const s = batch[index++];
        try {
          const data = new FormData();
          data.append("file", s.file);
          data.append("options", JSON.stringify(settings));
          const job = await api<Job>("/api/jobs", {
            method: "POST",
            body: data,
          });
          setIds((prev) => [job.id, ...prev].slice(0, 100));
          removeStaged(s.id);
        } catch (e) {
          setToast(`${s.file.name}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    setBusy(false);
  };
  const deleteJob = async (j: Job) => {
    try {
      await api(`/api/jobs/${j.id}`, { method: "DELETE" });
      if (j.status === "processing" || j.status === "queued") {
        void refresh();
      } else {
        setIds((prev) => prev.filter((id) => id !== j.id));
        setJobs((prev) => prev.filter((x) => x.id !== j.id));
      }
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const downloadZip = async () => {
    setZipping(true);
    try {
      const r = await fetch("/api/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: done.map((j) => j.id) }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.detail || "Download gagal.");
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "file-handler-results.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setZipping(false);
    }
  };
  const jobRow = (j: Job) => (
    <div className="job-row" key={j.id}>
      <button
        className="job-thumb checker"
        onClick={() => {
          setModal(null);
          setSelected(j);
          setCompare(50);
        }}
        title="Lihat gambar"
      >
        <img src={j.status === "done" ? j.preview : j.original} alt="" />
      </button>
      <div className="job-name">
        <button
          onClick={() => {
            setModal(null);
            setSelected(j);
            setCompare(50);
          }}
        >
          {j.name}
        </button>
        <span>
          {j.meta.width} × {j.meta.height} <i /> {bytes(j.meta.size)} <i />{" "}
          {tools.find((t) => t.id === j.tool)?.label}
        </span>
        {j.status === "processing" && (
          <div className="progress-track">
            <div style={{ width: `${j.progress}%` }} />
          </div>
        )}
        {j.error && <small className="error-text">{j.error}</small>}
      </div>
      <div className="job-output">
        <span>{j.options.format.toUpperCase()}</span>
        <small>{j.meta.output_size ? bytes(j.meta.output_size) : "—"}</small>
      </div>
      <span className={`status status-${j.status}`}>
        {j.status === "done" ? (
          <Check size={12} />
        ) : j.status === "processing" ? (
          <LoaderCircle size={12} className="spin" />
        ) : j.status === "failed" ? (
          <AlertCircle size={12} />
        ) : (
          <Clock3 size={12} />
        )}{" "}
        {j.status === "done"
          ? "Selesai"
          : j.status === "processing"
            ? `${j.progress}%`
            : j.status === "queued"
              ? "Antrean"
              : j.status === "cancelled"
                ? "Dibatalkan"
                : "Gagal"}
      </span>
      <div className="job-actions">
        {j.status === "done" && (
          <a className="icon-button" href={j.download} title="Download hasil">
            <ArrowDownToLine size={17} />
          </a>
        )}
        <button
          className="icon-button delete"
          title={
            j.status === "processing" || j.status === "queued"
              ? "Batalkan proses"
              : "Hapus file"
          }
          onClick={() => void deleteJob(j)}
        >
          {j.status === "processing" || j.status === "queued" ? (
            <X size={16} />
          ) : (
            <Trash2 size={16} />
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-icon">
            <Layers3 size={23} strokeWidth={2.3} />
          </span>
          <span>
            file<span className="brand-thin">handler</span>
            <small>YOUR LOCAL IMAGE STUDIO</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">P</span>
          <div>
            Personal workspace<small>Semua alat, satu tempat</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-heading">WORKSPACE</div>
        <nav aria-label="Alat gambar">
          {tools.map((t, i) => (
            <button
              key={t.id}
              aria-label={t.label}
              title={t.label}
              className={`nav-item ${tool === t.id ? "active" : ""}`}
              onClick={() => chooseTool(t.id)}
            >
              <t.icon size={18} />
              <span>{t.label}</span>
              {t.tag ? <em>{t.tag}</em> : <small>0{i + 1}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <button
          aria-label="Riwayat proses"
          title="Riwayat proses"
          className="nav-item history-nav"
          onClick={() => setModal("history")}
        >
          <Clock3 size={18} />
          <span>Riwayat proses</span>
          <b>{jobs.length}</b>
        </button>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-card-icon">
              <ShieldCheck size={21} />
            </span>
            <strong>Gambarmu tetap milikmu.</strong>
            <p>
              Diproses di perangkat ini.
              <br />
              Tanpa upload ke layanan luar.
            </p>
            <span className="local-card-note">
              <CircleDot size={11} /> 100% local processing
            </span>
          </div>
          <button
            aria-label="Pengaturan"
            title="Pengaturan"
            className="nav-item"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={18} />
            <span>Pengaturan</span>
          </button>
          <button
            aria-label="Bantuan & shortcut"
            title="Bantuan & shortcut"
            className="nav-item"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={18} />
            <span>Bantuan & shortcut</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-footer">
            <span className={`online-dot ${!health ? "offline" : ""}`} />
            {health ? "Local engine online" : "Engine tidak terhubung"}
            <small>v1.0</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <strong>{active.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <ShieldCheck size={13} /> Private by default
            </span>
            <span className="header-divider" />
            <button
              className="icon-button"
              aria-label="Bantuan"
              onClick={() => setModal("help")}
            >
              <CircleHelp size={18} />
            </button>
            <span className="user-avatar">P</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> LESS FRICTION. MORE CREATION.
              </div>
              <h1>
                {active.title}
                <span>.</span>
              </h1>
              <p>{active.desc}</p>
            </div>
            <div className="heading-badge">
              <Zap size={15} />
              <span>Built for your workflow</span>
            </div>
          </div>
          <div className="studio-grid">
            <section className="upload-panel panel">
              <div className="panel-header">
                <h2>
                  <ImagePlus size={17} />
                  Gambar kamu{" "}
                  <span className="count-badge">
                    {String(staged.length).padStart(2, "0")}
                  </span>
                </h2>
                <span className="batch-label">
                  <Layers3 size={13} /> Batch ready
                </span>
              </div>
              <input
                ref={input}
                type="file"
                className="sr-only"
                aria-label="Upload gambar"
                multiple
                accept=".jpg,.jpeg,.png,.webp,.avif,.heic,.heif,.tiff,.tif,.bmp,.ico,.gif"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
              <div
                className={`dropzone ${drag ? "dragging" : ""} ${staged.length ? "has-files" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setDrag(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  addFiles(Array.from(e.dataTransfer.files));
                }}
              >
                {!staged.length ? (
                  <>
                    <div className="upload-art">
                      <span className="art-back">
                        <FileImage size={31} />
                      </span>
                      <span className="art-front">
                        <ImageIcon size={39} strokeWidth={1.5} />
                        <i>
                          <Plus size={13} />
                        </i>
                      </span>
                      <span className="art-spark spark-one">✦</span>
                      <span className="art-spark spark-two">✧</span>
                    </div>
                    <h3>Tarik gambar ke sini</h3>
                    <p>atau pilih gambar dari perangkatmu</p>
                    <button
                      className="primary-button upload-button"
                      onClick={() => input.current?.click()}
                    >
                      <Plus size={17} /> Pilih gambar{" "}
                      <span>
                        <Command size={11} /> O
                      </span>
                    </button>
                    <span className="upload-limit">
                      Maks. 50 MB / gambar <i /> Hingga 20 gambar sekaligus
                    </span>
                  </>
                ) : (
                  <div className="staged-files">
                    <div className="staged-heading">
                      <strong>{staged.length} gambar siap diproses</strong>
                      <button
                        className="text-button"
                        onClick={clearStaged}
                        disabled={busy}
                      >
                        Hapus semua
                      </button>
                    </div>
                    {staged.map((s) => (
                      <div className="staged-row" key={s.id}>
                        <div className="staged-thumb checker">
                          <img
                            src={s.url}
                            alt=""
                            onError={(e) => {
                              e.currentTarget.style.visibility = "hidden";
                            }}
                          />
                        </div>
                        <div>
                          <strong>{s.file.name}</strong>
                          <small>
                            {bytes(s.file.size)} ·{" "}
                            {s.file.name.split(".").pop()?.toUpperCase()}
                          </small>
                        </div>
                        <button
                          className="icon-button"
                          aria-label={`Hapus ${s.file.name}`}
                          onClick={() => removeStaged(s.id)}
                          disabled={busy}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="add-more"
                      onClick={() => input.current?.click()}
                      disabled={busy}
                    >
                      <Plus size={15} /> Tambah gambar
                    </button>
                  </div>
                )}
              </div>
              <div className="supported">
                <span>INPUT FORMATS</span>
                <div>
                  {["JPG", "PNG", "WebP", "HEIC", "AVIF", "+ lainnya"].map(
                    (f) => (
                      <span key={f}>{f}</span>
                    ),
                  )}
                </div>
              </div>
              <div className="sample-strip">
                <span>
                  Belum ada gambar?{" "}
                  <button onClick={() => void sample()} disabled={busy}>
                    Coba gambar contoh <ArrowUpRight size={12} />
                  </button>
                </span>
                <div className="sample-photo">
                  <img src="/sample.jpg" alt="Sepatu merah, gambar contoh" />
                </div>
              </div>
            </section>
            <section className="settings-panel panel">
              <div className="panel-header">
                <h2>
                  <SlidersHorizontal size={16} />
                  Pengaturan output
                </h2>
                <button
                  className="reset-button"
                  onClick={() => chooseTool(tool)}
                  title="Reset pengaturan"
                >
                  <RotateCw size={14} /> Reset
                </button>
              </div>
              <div className="settings-body">
                {(tool === "remove" || tool === "upscale") && (
                  <div className="setting-block">
                    <label>Mode pemrosesan</label>
                    <div className="segmented modes">
                      <button
                        className={options.mode === "quality" ? "selected" : ""}
                        onClick={() => setOption("mode", "quality")}
                      >
                        <Sparkles size={13} /> Kualitas AI
                      </button>
                      <button
                        className={options.mode === "fast" ? "selected" : ""}
                        onClick={() => setOption("mode", "fast")}
                      >
                        <Zap size={13} /> Cepat
                      </button>
                    </div>
                    <p className="field-hint">
                      {tool === "remove"
                        ? options.mode === "quality"
                          ? "BiRefNet General · detail tepi lebih presisi"
                          : "BiRefNet Lite · model yang lebih ringan"
                        : options.mode === "quality"
                          ? "Real-ESRGAN · rekonstruksi detail asli"
                          : "Lanczos · resize tajam tanpa rekonstruksi AI"}
                    </p>
                  </div>
                )}
                {tool === "upscale" && (
                  <div className="setting-block">
                    <label>Skala upscale</label>
                    <div className="segmented scale">
                      {[2, 4].map((n) => (
                        <button
                          className={options.scale === n ? "selected" : ""}
                          onClick={() => setOption("scale", n)}
                          key={n}
                        >
                          {n}×{" "}
                          <small>
                            {n === 2 ? "Lebih besar" : "Detail maksimal"}
                          </small>
                        </button>
                      ))}
                    </div>
                    <p className="field-hint">
                      {options.mode === "quality"
                        ? "Input AI maks. 2 MP · Waktu tergantung ukuran gambar."
                        : "Hasil maksimal 60 MP."}
                    </p>
                  </div>
                )}
                {tool === "resize" && (
                  <>
                    <div className="setting-block">
                      <label>
                        Dimensi output <span>PX</span>
                      </label>
                      <div className="dimension-inputs">
                        <input
                          aria-label="Lebar"
                          type="number"
                          min="1"
                          max="16000"
                          placeholder="Lebar"
                          value={options.width || ""}
                          onChange={(e) =>
                            setOption(
                              "width",
                              e.target.value ? Number(e.target.value) : null,
                            )
                          }
                        />
                        <X size={13} />
                        <input
                          aria-label="Tinggi"
                          type="number"
                          min="1"
                          max="16000"
                          placeholder="Tinggi"
                          value={options.height || ""}
                          onChange={(e) =>
                            setOption(
                              "height",
                              e.target.value ? Number(e.target.value) : null,
                            )
                          }
                        />
                      </div>
                      <p className="field-hint">
                        Isi satu dimensi untuk menjaga rasio gambar.
                      </p>
                    </div>
                    <div className="setting-block">
                      <label>Orientasi</label>
                      <div className="orientation-controls">
                        <button
                          onClick={() =>
                            setOption("rotate", (options.rotate + 90) % 360)
                          }
                        >
                          <RotateCw size={14} /> {options.rotate}°
                        </button>
                        <button
                          className={options.flip ? "enabled" : ""}
                          onClick={() => setOption("flip", !options.flip)}
                        >
                          <FlipHorizontal2 size={14} /> Flip
                        </button>
                      </div>
                    </div>
                  </>
                )}
                {tool === "adjust" &&
                  (["brightness", "contrast", "saturation"] as const).map(
                    (key, i) => (
                      <div className="setting-block" key={key}>
                        <label htmlFor={key}>
                          {["Kecerahan", "Kontras", "Saturasi"][i]}
                          <b>{options[key]}%</b>
                        </label>
                        <input
                          id={key}
                          type="range"
                          min="0"
                          max="200"
                          value={options[key]}
                          onChange={(e) =>
                            setOption(key, Number(e.target.value))
                          }
                          style={
                            {
                              "--range": `${options[key] / 2}%`,
                            } as React.CSSProperties
                          }
                        />
                      </div>
                    ),
                  )}
                <div className="setting-block format-block">
                  <label>
                    Konversi ke <span>FORMAT</span>
                  </label>
                  <button
                    className={`format-select ${formatOpen ? "open" : ""}`}
                    aria-expanded={formatOpen}
                    onClick={() => setFormatOpen(!formatOpen)}
                  >
                    <span className="format-icon">
                      <FileImage size={21} />
                    </span>
                    <span>
                      <strong>{currentFormat.name}</strong>
                      <small>{currentFormat.hint}</small>
                    </span>
                    <ChevronDown size={15} />
                  </button>
                  {formatOpen && (
                    <div className="format-menu">
                      {formats.map((f) => (
                        <button
                          key={f.id}
                          className={options.format === f.id ? "chosen" : ""}
                          onClick={() => {
                            setOption("format", f.id);
                            setFormatOpen(false);
                          }}
                        >
                          <span>
                            <strong>{f.name}</strong>
                            <small>{f.hint}</small>
                          </span>
                          {f.badge && <em>{f.badge}</em>}
                          {options.format === f.id && <Check size={14} />}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="quick-formats">
                    {["webp", "png", "jpg", "avif"].map((f) => (
                      <button
                        className={options.format === f ? "selected" : ""}
                        key={f}
                        onClick={() => setOption("format", f)}
                      >
                        {f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                {["jpg", "webp", "avif"].includes(options.format) && (
                  <div className="setting-block quality-block">
                    <label htmlFor="quality">
                      Kualitas output{" "}
                      <b>
                        {options.quality}
                        <small>%</small>
                      </b>
                    </label>
                    <input
                      id="quality"
                      type="range"
                      min="1"
                      max="100"
                      value={options.quality}
                      disabled={options.format === "webp" && options.lossless}
                      onChange={(e) =>
                        setOption("quality", Number(e.target.value))
                      }
                      style={
                        {
                          "--range": `${options.quality}%`,
                        } as React.CSSProperties
                      }
                    />
                    <div className="range-labels">
                      <span>File lebih kecil</span>
                      <span>Kualitas terbaik</span>
                    </div>
                  </div>
                )}
                {options.format === "webp" && (
                  <div className="toggle-setting">
                    <span>
                      <strong>Lossless mode</strong>
                      <small>Pertahankan setiap detail gambar</small>
                    </span>
                    <button
                      role="switch"
                      aria-label="Lossless mode"
                      aria-checked={options.lossless}
                      className={`toggle ${options.lossless ? "on" : ""}`}
                      onClick={() => setOption("lossless", !options.lossless)}
                    >
                      <span />
                    </button>
                  </div>
                )}
                {["jpg", "bmp", "pdf", "gif"].includes(options.format) && (
                  <div className="color-setting">
                    <label htmlFor="background">
                      Warna pengganti transparansi
                    </label>
                    <input
                      id="background"
                      type="color"
                      value={options.background}
                      onChange={(e) => setOption("background", e.target.value)}
                    />
                  </div>
                )}
                <div className="output-note">
                  <ShieldCheck size={15} />
                  <span>Metadata pribadi dihapus dari hasil.</span>
                </div>
              </div>
              <div className="process-footer">
                <button
                  className="primary-button process-button"
                  disabled={
                    !staged.length ||
                    busy ||
                    !health ||
                    unavailableAI ||
                    (tool === "resize" && !options.width && !options.height)
                  }
                  onClick={() => void process()}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <active.icon size={16} />
                  )}
                  <span>
                    {busy
                      ? "Mengunggah gambar…"
                      : tool === "remove"
                        ? "Hapus background"
                        : tool === "upscale"
                          ? "Upscale gambar"
                          : `Proses ${staged.length || ""} gambar`}
                  </span>
                  <ArrowRight size={17} />
                </button>
                <small>
                  {unavailableAI
                    ? "Model AI sedang disiapkan."
                    : staged.length
                      ? `${staged.length} gambar · ${bytes(staged.reduce((n, s) => n + s.file.size, 0))} total`
                      : "Pilih gambar untuk mulai berkreasi"}
                </small>
              </div>
            </section>
          </div>
          <section className="results-panel panel">
            <div className="results-heading">
              <div>
                <h2>
                  Aktivitas terbaru{" "}
                  <span className="count-badge">{jobs.length}</span>
                  {pending.length > 0 && (
                    <span className="processing-indicator">
                      <span />
                      {pending.length} diproses
                    </span>
                  )}
                </h2>
                <p>Hasil gambar siap untuk langkah berikutnya.</p>
              </div>
              <button
                className="outline-button"
                disabled={!done.length || zipping}
                onClick={() => void downloadZip()}
              >
                {zipping ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <ArrowDownToLine size={14} />
                )}{" "}
                Download semua <span>ZIP</span>
              </button>
            </div>
            <div className="results-tabs">
              <button
                className={view === "all" ? "active" : ""}
                onClick={() => setView("all")}
              >
                Semua file <span>{jobs.length}</span>
              </button>
              <button
                className={view === "done" ? "active" : ""}
                onClick={() => setView("done")}
              >
                Selesai <span>{done.length}</span>
              </button>
              <span className="retention">
                <Clock3 size={12} /> Otomatis dihapus setelah{" "}
                {health?.retention_hours || 24} jam
              </span>
            </div>
            {visibleJobs.length ? (
              <div className="jobs-list">
                {visibleJobs.map(jobRow)}
                {jobs.length > 8 && (
                  <button
                    className="all-history"
                    onClick={() => setModal("history")}
                  >
                    Lihat seluruh riwayat <ArrowRight size={13} />
                  </button>
                )}
              </div>
            ) : (
              <div className="empty-results">
                <div>
                  <FolderOpen size={25} strokeWidth={1.4} />
                </div>
                <strong>
                  {view === "done"
                    ? "Belum ada hasil selesai"
                    : "Ruang untuk hasil karyamu"}
                </strong>
                <p>
                  {view === "done"
                    ? "Hasil yang selesai akan muncul di sini."
                    : "Upload gambar pertamamu. Hasil proses akan muncul di sini."}
                </p>
              </div>
            )}
          </section>
          <div className="feature-footer">
            <span>
              <ShieldCheck size={14} />
              <strong>Privat, selalu.</strong> Gambar diproses secara lokal.
            </span>
            <span>
              <CheckCheck size={14} /> Tanpa watermark
            </span>
            <span>
              <Layers3 size={14} /> Batch processing
            </span>
            <button onClick={() => setModal("help")}>
              Made to make things easier <ArrowUpRight size={12} />
            </button>
          </div>
        </main>
        <footer className="page-footer">
          <span>
            FILE HANDLER <i>/</i> A little less work. A lot more possibility.
          </span>
          <span>Crafted for your everyday.</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="alert">
          <AlertCircle size={18} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Tutup notifikasi"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <section
            className={`modal ${modal === "history" ? "history-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "history"
                ? "Riwayat proses"
                : modal === "help"
                  ? "Bantuan"
                  : "Pengaturan"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>
                {modal === "history"
                  ? "Riwayat proses"
                  : modal === "help"
                    ? "Sedikit bantuan, banyak kemungkinan."
                    : "Workspace lokal"}
              </h2>
              <button
                className="icon-button"
                aria-label="Tutup dialog"
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </div>
            {modal === "history" ? (
              <>
                <p className="modal-desc">
                  File tersimpan selama {health?.retention_hours || 24} jam.
                  Riwayat perangkat ini.
                </p>
                {jobs.length ? (
                  jobs.map(jobRow)
                ) : (
                  <div className="empty-results">
                    <Clock3 size={28} />
                    <p>Belum ada aktivitas. Mulai dengan upload gambar.</p>
                  </div>
                )}
              </>
            ) : modal === "help" ? (
              <>
                <p className="modal-desc">
                  Satu alur sederhana untuk semua gambarmu.
                </p>
                <div className="help-step">
                  <b>01</b>
                  <div>
                    <strong>Pilih alat & upload gambar</strong>
                    <p>
                      Tarik file ke area upload atau tekan Ctrl / ⌘ + O.
                      Maksimal 20 gambar, masing-masing 50 MB.
                    </p>
                  </div>
                </div>
                <div className="help-step">
                  <b>02</b>
                  <div>
                    <strong>Atur sesuai kebutuhan</strong>
                    <p>
                      Pilih format, kualitas, atau mode AI. PNG dan WebP
                      mendukung transparansi. Input animasi dan SVG belum
                      didukung.
                    </p>
                  </div>
                </div>
                <div className="help-step">
                  <b>03</b>
                  <div>
                    <strong>Proses, bandingkan, download</strong>
                    <p>
                      Klik gambar hasil untuk membandingkan sebelum/sesudah.
                      Download satu per satu atau sekaligus sebagai ZIP.
                    </p>
                  </div>
                </div>
                <div className="help-note">
                  <Clock3 size={17} />
                  <p>
                    AI berjalan di CPU lokal. Gambar besar membutuhkan waktu
                    lebih lama. Mode Cepat tersedia untuk menghemat waktu.
                  </p>
                </div>
                <a
                  className="docs-link"
                  href="/api/docs"
                  target="_blank"
                  rel="noreferrer"
                >
                  API documentation <ExternalLink size={13} />
                </a>
              </>
            ) : (
              <>
                <div className="settings-info">
                  <span>Status engine</span>
                  <strong>{health ? "Online" : "Offline"}</strong>
                </div>
                <div className="settings-info">
                  <span>Runtime</span>
                  <strong>{health?.engine || "—"}</strong>
                </div>
                <div className="settings-info">
                  <span>Retensi file</span>
                  <strong>{health?.retention_hours || 24} jam</strong>
                </div>
                <div className="settings-info">
                  <span>Format output</span>
                  <strong>9 format</strong>
                </div>
                <p className="modal-desc">Model AI</p>
                {Object.entries(health?.models || {}).map(([name, ready]) => (
                  <div className="settings-info" key={name}>
                    <span>{name.replace(".onnx", "")}</span>
                    <strong className={ready ? "model-ready" : ""}>
                      {ready ? "Siap digunakan" : "Belum tersedia"}
                    </strong>
                  </div>
                ))}
                <div className="help-note">
                  <ShieldCheck size={19} />
                  <p>
                    Gambar tetap di perangkat ini. Metadata pribadi dibuang saat
                    ekspor. File otomatis dibersihkan setelah masa retensi.
                  </p>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section
            className="modal preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Preview gambar"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <h2>{selected.name}</h2>
                <p>
                  {selected.meta.width} × {selected.meta.height}
                  {selected.meta.output_width
                    ? ` → ${selected.meta.output_width} × ${selected.meta.output_height}`
                    : ""}{" "}
                  · {selected.options.format.toUpperCase()}
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Tutup preview"
                onClick={() => setSelected(null)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="comparison checker">
              <img
                className="comparison-base"
                src={
                  selected.status === "done"
                    ? selected.preview
                    : selected.original
                }
                alt="Hasil pemrosesan"
              />
              {selected.status === "done" && (
                <>
                  <div
                    className="comparison-before"
                    style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}
                  >
                    <img src={selected.original} alt="Gambar asli" />
                  </div>
                  <span className="before-label">SEBELUM</span>
                  <span className="after-label">SESUDAH</span>
                  <div
                    className="comparison-line"
                    style={{ left: `${compare}%` }}
                  >
                    <span>
                      <MoveHorizontal size={18} />
                    </span>
                  </div>
                  <input
                    aria-label="Bandingkan sebelum dan sesudah"
                    type="range"
                    min="0"
                    max="100"
                    value={compare}
                    onChange={(e) => setCompare(Number(e.target.value))}
                  />
                </>
              )}
            </div>
            <div className="preview-footer">
              <span>
                {selected.status === "done"
                  ? `${bytes(selected.meta.size)} → ${bytes(selected.meta.output_size || 0)} · ${selected.meta.duration}s`
                  : selected.message}
              </span>
              {selected.status === "done" && (
                <a className="primary-button" href={selected.download}>
                  <ArrowDownToLine size={16} /> Download hasil
                </a>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
