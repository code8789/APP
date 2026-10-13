import {
  boundsOf,
  drawObj,
  hitObj,
  objSvg,
  type DrawObj,
  type MediaObj,
  type Pt,
} from "@/components/teach/ink";

const TILE = 1800;
const MIN_Z = 0.5;
const MAX_Z = 5;
const HISTORY = 40;
const DOCK_GAP = 92;
const MAX_EDGE = 2048;
const MAX_HTML_HEIGHT = 20000;

export type Tool =
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | "text"
  | "line"
  | "arrow"
  | "rect"
  | "circle"
  | "laser";

export type Prefs = {
  tool: Tool;
  color: string;
  size: number;
  opacity: number;
  invert: boolean;
};

export type TeachPatch = {
  docName?: string;
  kind?: "pdf" | "html" | null;
  page?: number;
  pageCount?: number;
  zoom?: number;
  canUndo?: boolean;
  canRedo?: boolean;
  status?: string;
  progress?: { label: string; ratio: number } | null;
  video?: boolean;
  ready?: boolean;
};

export type TeachHooks = {
  getPrefs: () => Prefs;
  patch: (p: TeachPatch) => void;
  onZoom: (z: number) => void;
  requestText: (opts: { title: string; placeholder?: string }) => Promise<string | null>;
  requestPage: (current: number, total: number) => Promise<number | null>;
  onEscape: () => void;
  onJump: () => void;
};

export type StageEls = {
  scroll: HTMLDivElement;
  sizer: HTMLDivElement;
  stage: HTMLDivElement;
};

type PdfRenderTask = { promise: Promise<void>; cancel: () => void };
type PdfPageProxy = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => PdfRenderTask;
  cleanup: () => void;
};
type PdfDocProxy = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageProxy>;
  destroy: () => Promise<void> | void;
};

type Tile = {
  y0: number;
  baseH: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
};

type Page = {
  index: number;
  baseW: number;
  baseH: number;
  shell: HTMLDivElement;
  inner: HTMLDivElement;
  mediaLayer: HTMLDivElement;
  tilesHost: HTMLDivElement;
  tiles: Tile[];
  objects: DrawObj[];
  media: MediaObj[];
  past: string[];
  future: string[];
  pdfCanvas?: HTMLCanvasElement;
  pdfPage?: PdfPageProxy;
  renderTask?: PdfRenderTask | null;
  renderGen: number;
  iframe?: HTMLIFrameElement;
  mounted: boolean;
  thumbBtn?: HTMLButtonElement;
};

type Doc = {
  kind: "pdf" | "html";
  pages: Page[];
};

type MediaHit = {
  page: Page;
  media: MediaObj;
  el: HTMLElement;
  isHandle: boolean;
};

type Draft = { page: Page; obj: DrawObj; origin: Pt; moved: boolean };

const MOBILE_FIX = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="teachpdf-view-fix">html,body{margin:0;background:#fff;}video{max-width:100%;}</style>
<script id="teachpdf-media-fix">
(function(){
  function fix(v){
    v.setAttribute("playsinline","");
    v.setAttribute("webkit-playsinline","");
    if(!v.hasAttribute("controls")) v.controls=true;
    if(!v.getAttribute("preload")) v.preload="metadata";
  }
  function scan(root){
    if(!root.querySelectorAll) return;
    root.querySelectorAll("video").forEach(fix);
  }
  function start(){
    scan(document);
    new MutationObserver(function(ms){
      ms.forEach(function(m){
        m.addedNodes.forEach(function(n){
          if(!n.tagName) return;
          if(n.tagName==="VIDEO") fix(n);
          else scan(n);
        });
      });
    }).observe(document.documentElement,{childList:true,subtree:true});
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
</script>`;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function yieldThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function isPdf(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function isHtml(file: File) {
  return file.type === "text/html" || /\.html?$/i.test(file.name);
}

function isMedia(file: File) {
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) return true;
  return /\.(gif|png|jpe?g|webp|svg|mp4|webm|mov|ogv|m4v)$/i.test(file.name);
}

function mediaKind(file: File): "image" | "video" {
  if (file.type.startsWith("video/") || /\.(mp4|webm|mov|ogv|m4v)$/i.test(file.name)) return "video";
  return "image";
}

function esc(s: string) {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

async function readBytes(file: Blob, onRatio: (n: number) => void) {
  const total = file.size || 1;
  const reader = file.stream().getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    if (got / total - last > 0.04 || got >= total) {
      last = got / total;
      onRatio(Math.min(1, last));
      if (parts.length % 6 === 0) await yieldThread();
    }
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function readText(file: Blob, onRatio: (n: number) => void) {
  const total = file.size || 1;
  const reader = file.stream().getReader();
  const dec = new TextDecoder();
  const chunks: string[] = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(dec.decode(value, { stream: true }));
    got += value.byteLength;
    if (got / total - last > 0.04 || got >= total) {
      last = got / total;
      onRatio(Math.min(1, last));
      await yieldThread();
    }
  }
  chunks.push(dec.decode());
  return chunks.join("");
}

function injectFix(html: string) {
  if (html.includes("teachpdf-media-fix")) return html;
  const match = /<head[^>]*>/i.exec(html);
  if (match) {
    const at = match.index + match[0].length;
    return html.slice(0, at) + MOBILE_FIX + html.slice(at);
  }
  return `<!doctype html><html><head>${MOBILE_FIX}</head><body>${html}</body></html>`;
}

function rewriteAssets(html: string, map: Map<string, string>) {
  const find = (raw: string) => {
    const clean = raw.trim();
    if (/^(https?:|data:|blob:|mailto:|#|\/\/)/i.test(clean)) return null;
    const noHash = clean.split("#")[0]?.split("?")[0] ?? clean;
    const base = decodeURIComponent(noHash.split("/").pop() || "");
    return map.get(clean) || map.get(noHash) || map.get(noHash.replace(/^\.\//, "")) || map.get(base) || null;
  };
  return html
    .replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']+)\2/gi, (full, pre: string, q: string, url: string) => {
      const hit = find(url);
      return hit ? `${pre}${q}${hit}${q}` : full;
    })
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, q: string, url: string) => {
      const hit = find(url);
      return hit ? `url(${q}${hit}${q})` : full;
    });
}

let pdfjsLoad: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs() {
  pdfjsLoad ??= import("pdfjs-dist").then(async (pdfjs) => {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsLoad;
}

export class Engine {
  private alive = true;
  private doc: Doc | null = null;
  private pdf: PdfDocProxy | null = null;
  private pdfBlob: Blob | null = null;
  private htmlSource = "";
  private docName = "";
  private docGen = 0;
  private pageByEl = new Map<Element, Page>();
  private current = 1;
  private userZoom = 1;
  private committedZoom = 1;
  private visualRatio = 1;
  private ownedUrls: string[] = [];
  private urlFiles = new Map<string, Blob>();
  private htmlObserver: ResizeObserver | null = null;
  private htmlTimer = 0;
  private resizeObserver: ResizeObserver;
  private lastAvail = 0;
  private resizeT = 0;
  private mode: "none" | "draw" | "pan" | "pinch" | "media" | "laser" = "none";
  private pointers = new Map<number, Pt>();
  private blockUntilUp = false;
  private pinchDist = 1;
  private pinchStartZoom = 1;
  private lastMid = { x: 0, y: 0 };
  private panX = 0;
  private panY = 0;
  private panT = 0;
  private panMoved = 0;
  private panVx = 0;
  private panVy = 0;
  private momentum = 0;
  private lastTap = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private draft: Draft | null = null;
  private mediaDrag: {
    hit: MediaHit;
    mode: "move" | "resize";
    anchorX: number;
    anchorY: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    moved: boolean;
    snap: boolean;
  } | null = null;
  private laser: HTMLDivElement;
  private videoFocus = false;
  private paintRaf = 0;
  private scrollRaf = 0;
  private statusN = 0;
  private thumbToken = 0;
  private wheelT = 0;
  private progLast = 0;
  private lastInvert = false;

  constructor(
    private els: StageEls,
    private hooks: TeachHooks,
  ) {
    this.laser = document.createElement("div");
    this.laser.className = "laser-dot";
    document.body.appendChild(this.laser);
    const scroll = els.scroll;
    scroll.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    scroll.addEventListener("pointermove", this.onPointerMove, { capture: true });
    scroll.addEventListener("pointerup", this.onPointerUp, { capture: true });
    scroll.addEventListener("pointercancel", this.onPointerUp, { capture: true });
    scroll.addEventListener("touchmove", this.onTouchMove, { passive: false });
    scroll.addEventListener("wheel", this.onWheel, { passive: false });
    scroll.addEventListener("scroll", this.onScroll, { passive: true });
    scroll.addEventListener("contextmenu", this.onContext);
    scroll.addEventListener("gesturestart", this.blockGesture);
    scroll.addEventListener("gesturechange", this.blockGesture);
    window.addEventListener("keydown", this.onKey);
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.availableWidth();
      if (Math.abs(w - this.lastAvail) < 2) return;
      window.clearTimeout(this.resizeT);
      this.resizeT = window.setTimeout(() => this.relayoutKeepCenter(), 140);
    });
    this.resizeObserver.observe(scroll);
  }

  destroy() {
    this.alive = false;
    this.docGen++;
    this.stopMomentum();
    this.clearDoc();
    const scroll = this.els.scroll;
    scroll.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    scroll.removeEventListener("pointermove", this.onPointerMove, { capture: true });
    scroll.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    scroll.removeEventListener("pointercancel", this.onPointerUp, { capture: true });
    scroll.removeEventListener("touchmove", this.onTouchMove);
    scroll.removeEventListener("wheel", this.onWheel);
    scroll.removeEventListener("scroll", this.onScroll);
    scroll.removeEventListener("contextmenu", this.onContext);
    scroll.removeEventListener("gesturestart", this.blockGesture);
    scroll.removeEventListener("gesturechange", this.blockGesture);
    window.removeEventListener("keydown", this.onKey);
    this.resizeObserver.disconnect();
    this.laser.remove();
  }

  flash(text: string) {
    this.say(text);
  }

  notePrefs() {
    const invert = this.hooks.getPrefs().invert;
    if (invert !== this.lastInvert) {
      this.lastInvert = invert;
      if (this.doc?.kind === "pdf") this.mountVisible(true);
    }
    if (this.hooks.getPrefs().tool !== "hand") this.clearVideoFocus();
    this.syncHistory();
  }

  async openFiles(files: File[]) {
    const list = [...files];
    if (!list.length) return;
    const htmls = list.filter(isHtml);
    const pdfs = list.filter(isPdf);
    const media = list.filter(isMedia);
    try {
      if (htmls.length) {
        const main =
          htmls.find((f) => /(^|\/)index\.html?$/i.test(f.webkitRelativePath || f.name)) ?? htmls[0];
        await this.openHtmlFile(
          main,
          list.filter((f) => f !== main),
        );
        return;
      }
      if (pdfs.length && media.length === 0) {
        await this.openPdfFile(pdfs[0]);
        return;
      }
      if (media.length) {
        await this.openGallery(media);
        return;
      }
      this.say("Use a PDF, an HTML file, or a picture / GIF / video.");
    } catch (err) {
      console.error(err);
      this.patch({ progress: null });
      this.say(err instanceof Error ? err.message : "Could not open that file", 3600);
    }
  }

  async openPdfFile(file: File) {
    const gen = ++this.docGen;
    this.progress("Reading PDF…", 0, true);
    const bytes = await readBytes(file, (n) => {
      if (gen === this.docGen) this.progress("Reading PDF…", n, false);
    });
    if (gen !== this.docGen || !this.alive) return;
    this.progress("Opening PDF…", 1, false);
    const pdfjs = await loadPdfjs();
    if (gen !== this.docGen || !this.alive) return;
    const task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      disableAutoFetch: true,
      verbosity: 0,
    });
    const pdf = (await task.promise) as unknown as PdfDocProxy;
    if (gen !== this.docGen || !this.alive) {
      await pdf.destroy();
      return;
    }
    this.clearDoc();
    this.pdf = pdf;
    this.pdfBlob = file;
    this.docName = file.name.replace(/\.pdf$/i, "") || "lesson";
    this.doc = { kind: "pdf", pages: [] };
    this.userZoom = 1;
    this.committedZoom = 1;
    this.visualRatio = 1;
    for (let i = 1; i <= pdf.numPages; i++) {
      if (gen !== this.docGen) return;
      const proxy = await pdf.getPage(i);
      const vp = proxy.getViewport({ scale: 1 });
      this.doc.pages.push(this.makePage(i, vp.width, vp.height));
      proxy.cleanup();
      if (i === 1 || i % 4 === 0) {
        this.progress("Preparing pages…", i / pdf.numPages, false);
        this.layout();
        await yieldThread();
      }
    }
    this.current = 1;
    this.layout();
    this.mountVisible(true);
    this.emitDoc();
    this.patch({ progress: null });
    this.say(`${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} ready`);
    this.els.scroll.scrollTop = 0;
    this.els.scroll.scrollLeft = 0;
  }

  async openHtmlText(name: string, html: string, assets: File[] = []) {
    const gen = ++this.docGen;
    this.progress("Opening HTML…", 0.4, true);
    if (gen !== this.docGen || !this.alive) return;
    this.clearDoc();
    const packed = this.packAssets(assets);
    const source = injectFix(rewriteAssets(html, packed.map));
    if (gen !== this.docGen || !this.alive) return;
    this.clearDoc();
    this.htmlSource = source;
    this.docName = name.replace(/\.html?$/i, "") || "lesson";
    this.userZoom = 1;
    this.committedZoom = 1;
    this.visualRatio = 1;
    const layoutW = Math.max(280, Math.min(920, this.availableWidth()));
    const page = this.makePage(1, layoutW, 640);
    this.doc = { kind: "html", pages: [page] };
    const blob = new Blob([source], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    this.ownedUrls.push(url);
    const iframe = document.createElement("iframe");
    iframe.className = "html-frame";
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-modals",
    );
    iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
    iframe.referrerPolicy = "no-referrer";
    // Prevent the browser from deprioritizing the iframe during CSS animations.
    
    iframe.src = url;
    page.iframe = iframe;
    page.inner.appendChild(iframe);
    this.layout();
    this.emitDoc();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      iframe.addEventListener("load", () => window.setTimeout(finish, 60), { once: true });
      window.setTimeout(finish, 2500);
    });
    if (gen !== this.docGen || !this.alive) return;
    this.measureHtml(page, layoutW);
    this.watchHtml(page);
    this.layout();
    this.mountVisible(true);
    this.patch({ progress: null });
    this.say("HTML ready — GIFs and video stay live");
    this.els.scroll.scrollTop = 0;
  }

  undo() {
    const page = this.currentPage();
    if (!page?.past.length) {
      this.say("Nothing to undo");
      return;
    }
    page.future.push(this.serialize(page));
    const raw = page.past.pop();
    if (raw) this.restore(page, raw);
    this.syncHistory();
  }

  redo() {
    const page = this.currentPage();
    if (!page?.future.length) {
      this.say("Nothing to redo");
      return;
    }
    page.past.push(this.serialize(page));
    const raw = page.future.pop();
    if (raw) this.restore(page, raw);
    this.syncHistory();
  }

  clearPage() {
    const page = this.currentPage();
    if (!page) return;
    if (!page.objects.length && !page.media.length) {
      this.say("This page is already clear");
      return;
    }
    this.snapshot(page);
    page.objects = [];
    page.media = [];
    this.syncMedia(page);
    this.paintPage(page);
    this.say("Page cleared");
  }

  zoomIn() {
    this.zoomAround(this.userZoom * 1.2);
  }

  zoomOut() {
    this.zoomAround(this.userZoom / 1.2);
  }

  fit() {
    this.zoomAround(1);
  }

  prev() {
    this.goTo(this.current - 1);
  }

  next() {
    this.goTo(this.current + 1);
  }

  goTo(n: number) {
    const page = this.doc?.pages[n - 1];
    if (!page) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    page.shell.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  async askPage() {
    if (!this.doc) return;
    const n = await this.hooks.requestPage(this.current, this.doc.pages.length);
    if (n && n >= 1 && n <= this.doc.pages.length) this.goTo(n);
  }

  async insertMedia(file: File) {
    const page = this.currentPage();
    if (!page) {
      this.say("Open a lesson first");
      return;
    }
    if (!isMedia(file)) {
      this.say("Choose an image, GIF, or video");
      return;
    }
    const url = URL.createObjectURL(file);
    this.ownedUrls.push(url);
    this.urlFiles.set(url, file);
    const kind = mediaKind(file);
    const dims = await measureBox(url, kind);
    const maxW = page.baseW * 0.46;
    const maxH = Math.min(page.baseH * 0.34, 420);
    const k = Math.min(1, maxW / dims.w, maxH / dims.h);
    const w = Math.max(48, dims.w * k);
    const h = Math.max(48, dims.h * k);
    this.snapshot(page);
    page.media.push({
      id: uid(),
      kind,
      src: url,
      x: page.baseW * 0.08,
      y: this.visibleY(page),
      w,
      h,
    });
    this.syncMedia(page);
    this.say(kind === "video" ? "Video added" : /gif$/i.test(file.type) || /\.gif$/i.test(file.name) ? "GIF added — it keeps animating" : "Image added");
  }

  async save() {
    if (!this.doc) {
      this.say("Open a lesson first");
      return;
    }
    try {
      if (this.doc.kind === "pdf") await this.savePdf();
      else await this.saveHtml();
    } catch (err) {
      console.error(err);
      this.patch({ progress: null });
      this.say(err instanceof Error ? err.message : "Could not save", 3600);
    }
  }

  clearVideoFocus() {
    this.videoFocus = false;
    this.doc?.pages.forEach((p) => p.iframe?.classList.remove("is-live"));
    this.patch({ video: false });
  }

  async fillThumbs(host: HTMLElement) {
    const token = ++this.thumbToken;
    host.replaceChildren();
    if (!this.doc) return;
    for (const page of this.doc.pages) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb" + (page.index === this.current ? " is-on" : "");
      const canvas = document.createElement("canvas");
      canvas.width = 72;
      canvas.height = 96;
      const label = document.createElement("span");
      label.textContent = `Page ${page.index}`;
      btn.append(canvas, label);
      btn.addEventListener("click", () => {
        this.goTo(page.index);
        this.hooks.onJump();
      });
      host.append(btn);
      page.thumbBtn = btn;
    }
    if (this.doc.kind !== "pdf" || !this.pdf) return;
    for (const page of this.doc.pages) {
      if (token !== this.thumbToken || !this.pdf) return;
      try {
        const proxy = await this.pdf.getPage(page.index);
        if (token !== this.thumbToken) {
          proxy.cleanup();
          return;
        }
        const base = proxy.getViewport({ scale: 1 });
        const viewport = proxy.getViewport({ scale: 68 / base.width });
        const canvas = page.thumbBtn?.querySelector("canvas");
        if (canvas) {
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          if (ctx) await proxy.render({ canvasContext: ctx, viewport }).promise;
        }
        proxy.cleanup();
      } catch {
        /* thumbnail is optional */
      }
      await yieldThread();
    }
  }

  private async openHtmlFile(file: File, assets: File[]) {
    const gen = ++this.docGen;
    this.progress("Reading HTML…", 0, true);
    const text = await readText(file, (n) => {
      if (gen === this.docGen) this.progress("Reading HTML…", n, false);
    });
    if (gen !== this.docGen || !this.alive) return;
    await this.openHtmlText(file.name, text, assets);
  }

  private async openGallery(files: File[]) {
    const assets: File[] = [];
    const bits = files.map((file, index) => {
      const key = `teach-media-${index}-${file.name.replace(/[^\w.]+/g, "_")}`;
      assets.push(new File([file], key, { type: file.type }));
      const tag =
        mediaKind(file) === "video"
          ? `<video src="${key}" controls playsinline webkit-playsinline preload="metadata"></video>`
          : `<img src="${key}" alt="${esc(file.name)}">`;
      return `<figure>${tag}<figcaption>${esc(file.name)}</figcaption></figure>`;
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;font-family:sans-serif;background:#111;color:#eee}
      figure{margin:0;padding:16px}
      img,video{max-width:100%;height:auto;display:block;margin:0 auto;background:#000}
      figcaption{font-size:13px;opacity:.75;margin-top:6px}
    </style></head><body>${bits.join("")}</body></html>`;
    await this.openHtmlText("media-lesson.html", html, assets);
  }

  private packAssets(files: File[]) {
    const map = new Map<string, string>();
    for (const file of files) {
      const url = URL.createObjectURL(file);
      this.ownedUrls.push(url);
      this.urlFiles.set(url, file);
      map.set(file.name, url);
      const rel = file.webkitRelativePath;
      if (rel) {
        map.set(rel, url);
        map.set(rel.replace(/^\.\//, ""), url);
        const base = rel.split("/").pop();
        if (base) map.set(base, url);
      }
    }
    return { map };
  }

  private measureHtml(page: Page, layoutW: number) {
    const doc = page.iframe?.contentDocument;
    if (!doc) {
      page.baseH = 800;
      return;
    }
    // Respect a forced height if the HTML declares one.
    const meta = doc.querySelector('meta[name="teachpdf-height"]')?.getAttribute("content");
    const forced = meta ? Number(meta) : 0;
    if (forced > 0) {
      page.baseH = Math.min(MAX_HTML_HEIGHT, Math.max(480, forced));
      this.ensureTiles(page);
      return;
    }
    const sw = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0, layoutW);
    const sh = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 480);
    if (sw > layoutW + 48) page.baseW = Math.min(sw, 2400);
    page.baseH = Math.min(MAX_HTML_HEIGHT, Math.max(480, sh));
    this.ensureTiles(page);
  }

  private watchHtml(page: Page) {
    this.htmlObserver?.disconnect();
    window.clearTimeout(this.htmlTimer);
    const body = page.iframe?.contentDocument?.body;
    if (!body) return;
    let lastH = page.baseH;
    this.htmlObserver = new ResizeObserver(() => {
      // Debounce: animated HTML resizes every frame. Wait 250 ms of silence.
      window.clearTimeout(this.htmlTimer);
      this.htmlTimer = window.setTimeout(() => {
        const doc = page.iframe?.contentDocument;
        if (!doc || this.doc?.kind !== "html") return;
        const sh = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
        // Only grow — never shrink — and only by a meaningful amount.
        if (sh > lastH + 60) {
          lastH = sh;
          page.baseH = Math.min(MAX_HTML_HEIGHT, Math.max(480, sh));
          this.ensureTiles(page);
          this.layout();
        }
      }, 250);
    });
    this.htmlObserver.observe(body);
  }

  private makePage(index: number, baseW: number, baseH: number) {
    const shell = document.createElement("div");
    shell.className = "page-shell";
    shell.dataset.page = String(index);
    const inner = document.createElement("div");
    inner.className = "page-inner";
    const fill = document.createElement("div");
    fill.className = "page-fill";
    fill.textContent = `Page ${index}`;
    const mediaLayer = document.createElement("div");
    mediaLayer.className = "media-layer";
    const tilesHost = document.createElement("div");
    tilesHost.className = "tiles-host";
    inner.append(fill, mediaLayer, tilesHost);
    shell.appendChild(inner);
    this.els.stage.appendChild(shell);
    const page: Page = {
      index,
      baseW,
      baseH,
      shell,
      inner,
      mediaLayer,
      tilesHost,
      tiles: [],
      objects: [],
      media: [],
      past: [],
      future: [],
      renderGen: 0,
      mounted: false,
    };
    this.pageByEl.set(shell, page);
    this.ensureTiles(page);
    return page;
  }

  private ensureTiles(page: Page) {
    const count = Math.max(1, Math.ceil(page.baseH / TILE));
    while (page.tiles.length < count) {
      const i = page.tiles.length;
      const y0 = i * TILE;
      const h = Math.min(TILE, Math.max(1, page.baseH - y0));
      const el = document.createElement("div");
      el.className = "ink-tile";
      el.style.top = `${y0}px`;
      el.style.height = `${h}px`;
      page.tilesHost.appendChild(el);
      page.tiles.push({ y0, baseH: h, el, canvas: null, ctx: null });
    }
    const last = page.tiles[page.tiles.length - 1];
    const h = Math.min(TILE, Math.max(1, page.baseH - last.y0));
    if (Math.abs(h - last.baseH) > 1) {
      last.baseH = h;
      last.el.style.height = `${h}px`;
    }
  }

  private clearDoc() {
    this.thumbToken++;
    this.htmlObserver?.disconnect();
    this.htmlObserver = null;
    window.clearTimeout(this.htmlTimer);
    this.htmlTimer = 0;
    this.clearVideoFocus();
    try {
      this.pdf?.destroy();
    } catch {
      /* already gone */
    }
    this.pdf = null;
    this.pdfBlob = null;
    this.htmlSource = "";
    for (const url of this.ownedUrls) URL.revokeObjectURL(url);
    this.ownedUrls = [];
    this.urlFiles.clear();
    this.pageByEl.clear();
    this.doc = null;
    this.draft = null;
    this.els.stage.replaceChildren();
    this.els.stage.style.transform = "";
    this.els.sizer.style.width = "";
    this.els.sizer.style.height = "";
  }

  private availableWidth() {
    return Math.max(220, this.els.scroll.clientWidth - 24);
  }

  private displayScale() {
    const base = this.doc?.pages[0]?.baseW || 1;
    return (this.availableWidth() / base) * this.committedZoom;
  }

  private layout() {
    if (!this.doc) return;
    this.lastAvail = this.availableWidth();
    const S = this.displayScale();
    this.applyChromeSpace();
    for (const page of this.doc.pages) {
      const w = page.baseW * S;
      const h = page.baseH * S;
      page.shell.style.width = `${w}px`;
      page.shell.style.height = `${h}px`;
      page.inner.style.width = `${page.baseW}px`;
      page.inner.style.height = `${page.baseH}px`;
      page.inner.style.transform = `scale(${S})`;
      page.inner.style.setProperty("--page-scale", String(S));
    }
    if (Math.abs(this.visualRatio - 1) < 0.001) {
      this.els.stage.style.transform = "";
      this.els.sizer.style.width = "";
      this.els.sizer.style.height = "";
      this.els.sizer.style.minWidth = "";
    }
  }

  private applyChromeSpace() {
    const pad = 12 / this.visualRatio;
    this.els.stage.style.padding = `${pad}px`;
    this.els.stage.style.gap = `${pad}px`;
  }

  private applyTransform() {
    const R = this.visualRatio;
    this.applyChromeSpace();
    const idle = Math.abs(R - 1) < 0.001;
    this.els.stage.style.transform = idle ? "" : `scale(${R})`;
    this.els.stage.style.transformOrigin = "0 0";
    this.els.stage.style.willChange = idle ? "" : "transform";
    if (idle) {
      this.els.sizer.style.width = "";
      this.els.sizer.style.height = "";
      this.els.sizer.style.minWidth = "";
      return;
    }
    this.els.sizer.style.minWidth = "0px";
    this.els.sizer.style.width = `${this.els.stage.offsetWidth * R}px`;
    this.els.sizer.style.height = `${this.els.stage.offsetHeight * R + DOCK_GAP}px`;
  }

  private relayoutKeepCenter() {
    if (!this.doc || this.mode === "pinch") return;
    if (Math.abs(this.visualRatio - 1) > 0.001) this.commitZoom();
    const el = this.els.scroll;
    const fx = (el.scrollLeft + el.clientWidth / 2) / Math.max(1, this.els.sizer.scrollWidth);
    const fy = (el.scrollTop + el.clientHeight / 2) / Math.max(1, this.els.sizer.scrollHeight);
    this.layout();
    this.mountVisible(true);
    el.scrollLeft = fx * this.els.sizer.scrollWidth - el.clientWidth / 2;
    el.scrollTop = fy * this.els.sizer.scrollHeight - el.clientHeight / 2;
  }

  private zoomAround(next: number) {
    if (!this.doc) return;
    if (Math.abs(this.visualRatio - 1) > 0.001) this.commitZoom();
    const rect = this.els.scroll.getBoundingClientRect();
    this.zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  private zoomAt(next: number, clientX: number, clientY: number) {
    if (!this.doc) return;
    next = clamp(next, MIN_Z, MAX_Z);
    const old = this.committedZoom;
    if (Math.abs(next - old) < 0.001) {
      this.hooks.onZoom(this.userZoom);
      return;
    }
    const scroll = this.els.scroll;
    const rect = scroll.getBoundingClientRect();
    const ox = clientX - rect.left;
    const oy = clientY - rect.top;
    const layoutX = scroll.scrollLeft + ox;
    const layoutY = scroll.scrollTop + oy;
    const applied = next / old;
    this.userZoom = next;
    this.committedZoom = next;
    this.visualRatio = 1;
    this.layout();
    scroll.scrollLeft = layoutX * applied - ox;
    scroll.scrollTop = layoutY * applied - oy;
    this.mountVisible(true);
    this.hooks.onZoom(next);
    this.patch({ zoom: next });
  }

  private commitZoom() {
    if (!this.doc) return;
    const R = this.visualRatio;
    if (Math.abs(this.userZoom - this.committedZoom) < 0.001 && Math.abs(R - 1) < 0.001) return;
    const scroll = this.els.scroll;
    const rect = scroll.getBoundingClientRect();
    const ox = rect.width / 2;
    const oy = rect.height / 2;
    const layoutX = (scroll.scrollLeft + ox) / R;
    const layoutY = (scroll.scrollTop + oy) / R;
    const applied = this.userZoom / this.committedZoom;
    this.committedZoom = this.userZoom;
    this.visualRatio = 1;
    this.els.stage.style.willChange = "";
    this.layout();
    scroll.scrollLeft = layoutX * applied - ox;
    scroll.scrollTop = layoutY * applied - oy;
    this.mountVisible(true);
    this.hooks.onZoom(this.userZoom);
    this.patch({ zoom: this.userZoom });
  }

  private near(el: HTMLElement, margin: number) {
    const r = el.getBoundingClientRect();
    const v = this.els.scroll.getBoundingClientRect();
    return r.bottom > v.top - margin && r.top < v.bottom + margin;
  }

  private mountVisible(force: boolean) {
    if (!this.doc) return;
    const keep = this.draft?.page;
    for (const page of this.doc.pages) {
      if (page !== keep && !this.near(page.shell, 900)) {
        if (page.mounted) this.unmountPage(page);
        continue;
      }
      this.mountPage(page, force);
    }
  }

  private mountPage(page: Page, force: boolean) {
    if (!page.mounted) {
      page.mounted = true;
      if (this.doc?.kind === "pdf") {
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-layer";
        page.inner.insertBefore(canvas, page.mediaLayer);
        page.pdfCanvas = canvas;
        void this.renderPdf(page);
      }
    } else if (force && this.doc?.kind === "pdf" && page.pdfCanvas) {
      void this.renderPdf(page);
    }
    this.syncTiles(page, force);
  }

  private unmountPage(page: Page) {
    // Never unmount an HTML page — the iframe keeps animations alive.
    if (this.doc?.kind === "html") return;
    page.mounted = false;
    page.renderGen++;
    try {
      page.renderTask?.cancel();
    } catch {
      /* ignore */
    }
    page.renderTask = null;
    if (page.pdfCanvas) {
      page.pdfCanvas.width = 0;
      page.pdfCanvas.height = 0;
      page.pdfCanvas.remove();
      page.pdfCanvas = undefined;
    }
    page.pdfPage?.cleanup();
    page.pdfPage = undefined;
    for (const tile of page.tiles) this.dropTile(tile);
  }

  private dropTile(tile: Tile) {
    if (!tile.canvas) return;
    tile.canvas.width = 0;
    tile.canvas.height = 0;
    tile.canvas.remove();
    tile.canvas = null;
    tile.ctx = null;
  }

  private syncTiles(page: Page, force: boolean) {
    for (const tile of page.tiles) {
      if (!this.near(tile.el, 700) && page !== this.draft?.page) {
        this.dropTile(tile);
        continue;
      }
      if (!tile.canvas) {
        const canvas = document.createElement("canvas");
        tile.el.appendChild(canvas);
        tile.canvas = canvas;
        tile.ctx = canvas.getContext("2d");
      }
      const changed = this.resizeInk(page, tile);
      if (changed || force) this.paintTile(page, tile);
    }
  }

  private resizeInk(page: Page, tile: Tile) {
    const canvas = tile.canvas;
    if (!canvas) return false;
    const S = this.displayScale();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let bw = page.baseW * S * dpr;
    let bh = tile.baseH * S * dpr;
    const edge = Math.max(bw, bh);
    if (edge > MAX_EDGE) {
      const k = MAX_EDGE / edge;
      bw *= k;
      bh *= k;
    }
    const w = Math.max(1, Math.round(bw));
    const h = Math.max(1, Math.round(bh));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  private async renderPdf(page: Page) {
    if (!this.pdf || !page.pdfCanvas) return;
    const gen = ++page.renderGen;
    const docGen = this.docGen;
    try {
      page.pdfPage ??= await this.pdf.getPage(page.index);
      if (gen !== page.renderGen || docGen !== this.docGen || !page.pdfCanvas) return;
      const canvas = page.pdfCanvas;
      const S = this.displayScale();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let targetW = page.baseW * S * dpr;
      let targetH = page.baseH * S * dpr;
      const edge = Math.max(targetW, targetH);
      if (edge > MAX_EDGE) {
        const k = MAX_EDGE / edge;
        targetW *= k;
        targetH *= k;
      }
      const viewport = page.pdfPage.getViewport({ scale: targetW / page.baseW });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      try {
        page.renderTask?.cancel();
      } catch {
        /* ignore */
      }
      ctx.filter = this.hooks.getPrefs().invert ? "invert(1) hue-rotate(180deg)" : "none";
      const task = page.pdfPage.render({ canvasContext: ctx, viewport });
      page.renderTask = task;
      await task.promise;
      if (gen === page.renderGen) ctx.filter = "none";
    } catch {
      /* cancelled render */
    }
  }

  private paintPage(page: Page | null) {
    if (!page) return;
    for (const tile of page.tiles) {
      if (tile.canvas) this.paintTile(page, tile);
    }
  }

  private paintTile(page: Page, tile: Tile) {
    const ctx = tile.ctx;
    const canvas = tile.canvas;
    if (!ctx || !canvas) return;
    const sx = canvas.width / page.baseW;
    const sy = canvas.height / tile.baseH;
    ctx.setTransform(sx, 0, 0, sy, 0, -tile.y0 * sy);
    ctx.clearRect(0, tile.y0 - 4, page.baseW, tile.baseH + 8);
    const y0 = tile.y0 - 30;
    const y1 = tile.y0 + tile.baseH + 30;
    const drawIf = (obj: DrawObj) => {
      const b = boundsOf(obj);
      if (b.y1 < y0 || b.y0 > y1) return;
      drawObj(ctx, obj);
    };
    for (const obj of page.objects) drawIf(obj);
    if (this.draft?.page === page) drawIf(this.draft.obj);
  }

  private schedulePaint(page: Page) {
    if (this.paintRaf) return;
    this.paintRaf = requestAnimationFrame(() => {
      this.paintRaf = 0;
      this.paintPage(page);
    });
  }

  private currentPage() {
    return this.doc?.pages[this.current - 1] ?? null;
  }

  private emitDoc() {
    this.patch({
      docName: this.docName,
      kind: this.doc?.kind ?? null,
      page: this.current,
      pageCount: this.doc?.pages.length ?? 0,
      zoom: this.userZoom,
      ready: !!this.doc,
      canUndo: false,
      canRedo: false,
      progress: null,
    });
    this.hooks.onZoom(this.userZoom);
  }

  private syncHistory() {
    const page = this.currentPage();
    this.patch({
      canUndo: !!page?.past.length,
      canRedo: !!page?.future.length,
      page: this.current,
      pageCount: this.doc?.pages.length ?? 0,
    });
    this.doc?.pages.forEach((p) => p.thumbBtn?.classList.toggle("is-on", p.index === this.current));
  }

  private serialize(page: Page) {
    return JSON.stringify({ objects: page.objects, media: page.media });
  }

  private snapshot(page: Page) {
    page.past.push(this.serialize(page));
    if (page.past.length > HISTORY) page.past.shift();
    page.future.length = 0;
    this.syncHistory();
  }

  private restore(page: Page, raw: string) {
    const data = JSON.parse(raw) as { objects?: DrawObj[]; media?: MediaObj[] };
    page.objects = data.objects ?? [];
    page.media = data.media ?? [];
    this.syncMedia(page);
    this.paintPage(page);
  }

  private syncMedia(page: Page) {
    page.mediaLayer.replaceChildren();
    for (const media of page.media) page.mediaLayer.appendChild(this.mediaNode(media));
  }

  private mediaNode(media: MediaObj) {
    const el = document.createElement("div");
    el.className = "media-item";
    el.dataset.id = media.id;
    el.style.left = `${media.x}px`;
    el.style.top = `${media.y}px`;
    el.style.width = `${media.w}px`;
    el.style.height = `${media.h}px`;
    if (media.kind === "video") {
      const video = document.createElement("video");
      video.src = media.src;
      video.controls = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.preload = "metadata";
      el.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = media.src;
      img.alt = "";
      img.draggable = false;
      el.appendChild(img);
    }
    const handle = document.createElement("span");
    handle.className = "media-handle";
    handle.dataset.role = "handle";
    el.appendChild(handle);
    return el;
  }

  private placeMedia(el: HTMLElement, media: MediaObj) {
    el.style.left = `${media.x}px`;
    el.style.top = `${media.y}px`;
    el.style.width = `${media.w}px`;
    el.style.height = `${media.h}px`;
  }

  private visibleY(page: Page) {
    const r = page.inner.getBoundingClientRect();
    const v = this.els.scroll.getBoundingClientRect();
    const y = ((Math.max(v.top, r.top) - r.top) / Math.max(1, r.height)) * page.baseH;
    return clamp(y + 12, 0, Math.max(0, page.baseH - 80));
  }

  private styleFor(tool: Tool) {
    const prefs = this.hooks.getPrefs();
    const scale = Math.max(0.05, this.displayScale() * this.visualRatio);
    const width = (tool === "highlighter" ? Math.max(16, prefs.size * 3.3) : prefs.size) / scale;
    const opacity = tool === "highlighter" ? Math.min(0.42, prefs.opacity) : prefs.opacity;
    return { color: prefs.color, width, opacity };
  }

  private toBase(page: Page, x: number, y: number): Pt {
    const r = page.inner.getBoundingClientRect();
    return {
      x: ((x - r.left) / Math.max(1, r.width)) * page.baseW,
      y: ((y - r.top) / Math.max(1, r.height)) * page.baseH,
    };
  }

  private pageAt(x: number, y: number) {
    for (const el of document.elementsFromPoint(x, y)) {
      const shell = el.closest(".page-shell");
      if (!shell) continue;
      const page = this.pageByEl.get(shell);
      if (page) return page;
    }
    return null;
  }

  private mediaAt(x: number, y: number): MediaHit | null {
    for (const el of document.elementsFromPoint(x, y)) {
      const item = el.closest(".media-item");
      if (!item) continue;
      const shell = item.closest(".page-shell");
      const page = shell ? this.pageByEl.get(shell) : undefined;
      const media = page?.media.find((m) => m.id === (item as HTMLElement).dataset.id);
      if (!page || !media) continue;
      const isHandle = el instanceof HTMLElement && (el.dataset.role === "handle" || !!el.closest(".media-handle"));
      return { page, media, el: item as HTMLElement, isHandle };
    }
    return null;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const capture = () => {
      try {
        this.els.scroll.setPointerCapture(event.pointerId);
      } catch {
        /* pointer may belong to the iframe */
      }
    };
    if (this.blockUntilUp && this.pointers.size < 2) return;
    if (this.pointers.size >= 2) {
      this.cancelDraft();
      this.mediaDrag = null;
      this.stopMomentum();
      this.hideLaser();
      const pts = [...this.pointers.values()];
      this.mode = "pinch";
      this.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      this.pinchStartZoom = this.userZoom;
      this.lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      event.preventDefault();
      capture();
      return;
    }
    this.stopMomentum();
    if (!this.doc) return;
    const prefs = this.hooks.getPrefs();
    const media = this.mediaAt(event.clientX, event.clientY);
    if (media && prefs.tool === "eraser") {
      this.snapshot(media.page);
      media.page.media = media.page.media.filter((m) => m.id !== media.media.id);
      this.syncMedia(media.page);
      this.say("Removed");
      event.preventDefault();
      capture();
      return;
    }
    if (media?.isHandle) {
      this.beginMedia(media, event, "resize");
      event.preventDefault();
      capture();
      return;
    }
    if (media && media.media.kind === "video" && prefs.tool === "hand") {
      return;
    }
    if (media && prefs.tool === "hand" && media.media.kind === "image") {
      this.beginMedia(media, event, "move");
      event.preventDefault();
      capture();
      return;
    }
    if (prefs.tool === "hand") {
      this.beginPan(event);
      event.preventDefault();
      capture();
      return;
    }
    if (prefs.tool === "laser") {
      this.mode = "laser";
      this.moveLaser(event.clientX, event.clientY);
      event.preventDefault();
      capture();
      return;
    }
    const page = this.pageAt(event.clientX, event.clientY);
    if (!page) {
      this.beginPan(event);
      event.preventDefault();
      capture();
      return;
    }
    if (prefs.tool === "text") {
      event.preventDefault();
      const point = this.toBase(page, event.clientX, event.clientY);
      void this.addText(page, point);
      return;
    }
    if (prefs.tool === "eraser") {
      this.mode = "draw";
      this.draft = {
        page,
        origin: this.toBase(page, event.clientX, event.clientY),
        moved: true,
        obj: {
          type: "stroke",
          points: [],
          color: "#000",
          width: 1,
          opacity: 1,
        },
      };
      this.eraseAt(page, event.clientX, event.clientY);
      event.preventDefault();
      capture();
      return;
    }
    this.beginShape(page, prefs.tool, event);
    event.preventDefault();
    capture();
  };

  private onPointerMove = (event: PointerEvent) => {
    const tracked = this.pointers.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }
    if (this.mode === "pinch" && this.pointers.size >= 2) {
      event.preventDefault();
      this.movePinch();
      return;
    }
    if (this.mode === "pan") {
      event.preventDefault();
      this.movePan(event);
      return;
    }
    if (this.mode === "draw") {
      event.preventDefault();
      this.moveDraw(event);
      return;
    }
    if (this.mode === "media") {
      event.preventDefault();
      this.moveMedia(event);
      return;
    }
    if (this.mode === "laser") {
      this.moveLaser(event.clientX, event.clientY);
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.mode === "pinch") {
      if (this.pointers.size < 2) {
        this.mode = "none";
        this.blockUntilUp = this.pointers.size > 0;
        this.commitZoom();
      }
      return;
    }
    if (this.pointers.size > 0) return;
    this.blockUntilUp = false;
    if (this.mode === "pan") this.finishPan(event);
    else if (this.mode === "draw") this.finishDraw();
    else if (this.mode === "media") this.finishMedia();
    else if (this.mode === "laser") this.hideLaser();
    this.mode = "none";
  };

  private onTouchMove = (event: TouchEvent) => {
    if (
      this.mode === "pan" ||
      this.mode === "pinch" ||
      this.mode === "draw" ||
      this.mode === "media" ||
      this.mode === "laser"
    ) {
      event.preventDefault();
    }
  };

  private onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (!this.doc) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.06 : 1 / 1.06;
    const next = clamp(this.userZoom * factor, MIN_Z, MAX_Z);
    const scroll = this.els.scroll;
    const rect = scroll.getBoundingClientRect();
    const ox = event.clientX - rect.left;
    const oy = event.clientY - rect.top;
    const oldR = this.visualRatio;
    const layoutX = (scroll.scrollLeft + ox) / oldR;
    const layoutY = (scroll.scrollTop + oy) / oldR;
    this.userZoom = next;
    this.visualRatio = next / this.committedZoom;
    this.applyTransform();
    scroll.scrollLeft = layoutX * this.visualRatio - ox;
    scroll.scrollTop = layoutY * this.visualRatio - oy;
    this.hooks.onZoom(next);
    window.clearTimeout(this.wheelT);
    this.wheelT = window.setTimeout(() => this.commitZoom(), 160);
  };

  private onScroll = () => {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.updateCurrentPage();
      if (this.mode !== "pinch") this.mountVisible(false);
    });
  };

  private onContext = (event: Event) => {
    if (this.hooks.getPrefs().tool !== "hand") event.preventDefault();
  };

  private blockGesture = (event: Event) => {
    event.preventDefault();
  };

  private onKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    } else if (meta && event.key.toLowerCase() === "y") {
      event.preventDefault();
      this.redo();
    } else if (event.key === "Escape") {
      this.clearVideoFocus();
      this.hooks.onEscape();
    }
  };

  private beginPan(event: PointerEvent) {
    this.mode = "pan";
    this.panX = event.clientX;
    this.panY = event.clientY;
    this.panT = performance.now();
    this.panMoved = 0;
    this.panVx = 0;
    this.panVy = 0;
  }

  private movePan(event: PointerEvent) {
    const now = performance.now();
    const dt = Math.max(8, now - this.panT);
    const dx = event.clientX - this.panX;
    const dy = event.clientY - this.panY;
    this.els.scroll.scrollLeft -= dx;
    this.els.scroll.scrollTop -= dy;
    const svx = (-dx / dt) * 16;
    const svy = (-dy / dt) * 16;
    this.panVx = this.panVx * 0.35 + svx * 0.65;
    this.panVy = this.panVy * 0.35 + svy * 0.65;
    this.panX = event.clientX;
    this.panY = event.clientY;
    this.panT = now;
    this.panMoved += Math.hypot(dx, dy);
  }

  private finishPan(event: PointerEvent) {
    if (this.panMoved < 8) {
      const now = performance.now();
      if (now - this.lastTap < 280 && Math.hypot(event.clientX - this.lastTapX, event.clientY - this.lastTapY) < 28) {
        this.lastTap = 0;
        this.zoomAt(this.userZoom < 1.45 ? 2.2 : 1, event.clientX, event.clientY);
        return;
      }
      this.lastTap = now;
      this.lastTapX = event.clientX;
      this.lastTapY = event.clientY;
      this.tapHtml(event.clientX, event.clientY);
      return;
    }
    if (event.pointerType === "mouse") return;
    let vx = this.panVx;
    let vy = this.panVy;
    const step = () => {
      vx *= 0.92;
      vy *= 0.92;
      if (Math.hypot(vx, vy) < 0.35) {
        this.momentum = 0;
        return;
      }
      this.els.scroll.scrollLeft += vx;
      this.els.scroll.scrollTop += vy;
      this.momentum = requestAnimationFrame(step);
    };
    this.momentum = requestAnimationFrame(step);
  }

  private stopMomentum() {
    if (this.momentum) cancelAnimationFrame(this.momentum);
    this.momentum = 0;
  }

  private movePinch() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const next = clamp(this.pinchStartZoom * (dist / this.pinchDist), MIN_Z, MAX_Z);
    const scroll = this.els.scroll;
    const rect = scroll.getBoundingClientRect();
    const oldR = this.visualRatio;
    const ox = this.lastMid.x - rect.left;
    const oy = this.lastMid.y - rect.top;
    const layoutX = (scroll.scrollLeft + ox) / oldR;
    const layoutY = (scroll.scrollTop + oy) / oldR;
    this.userZoom = next;
    this.visualRatio = next / this.committedZoom;
    this.applyTransform();
    const nox = mid.x - rect.left;
    const noy = mid.y - rect.top;
    scroll.scrollLeft = layoutX * this.visualRatio - nox;
    scroll.scrollTop = layoutY * this.visualRatio - noy;
    this.lastMid = mid;
    this.hooks.onZoom(next);
  }

  private beginShape(page: Page, tool: Tool, event: PointerEvent) {
    const origin = this.toBase(page, event.clientX, event.clientY);
    const style = this.styleFor(tool);
    let obj: DrawObj;
    if (tool === "pen" || tool === "highlighter") {
      obj = { type: "stroke", points: [origin], ...style, highlight: tool === "highlighter" };
    } else if (tool === "line" || tool === "arrow") {
      obj = { type: tool, x1: origin.x, y1: origin.y, x2: origin.x, y2: origin.y, ...style };
    } else if (tool === "rect" || tool === "circle") {
      obj = { type: tool, x: origin.x, y: origin.y, w: 0, h: 0, ...style };
    } else {
      return;
    }
    this.draft = { page, obj, origin, moved: false };
    this.mode = "draw";
  }

  private moveDraw(event: PointerEvent) {
    const page = this.draft?.page;
    if (!page) return;
    if (this.hooks.getPrefs().tool === "eraser") {
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const ev of events) this.eraseAt(page, ev.clientX, ev.clientY);
      return;
    }
    if (!this.draft) return;
    const events = event.getCoalescedEvents?.() ?? [event];
    const obj = this.draft.obj;
    if (obj.type === "stroke") {
      const min = 0.4 / Math.max(0.05, this.displayScale() * this.visualRatio);
      for (const ev of events) {
        const q = this.toBase(page, ev.clientX, ev.clientY);
        const prev = obj.points[obj.points.length - 1];
        if (!prev || Math.hypot(q.x - prev.x, q.y - prev.y) >= min) obj.points.push(q);
      }
      this.draft.moved = obj.points.length > 1;
    } else {
      const q = this.toBase(page, event.clientX, event.clientY);
      if (obj.type === "line" || obj.type === "arrow") {
        obj.x2 = q.x;
        obj.y2 = q.y;
        this.draft.moved = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) > 1.5;
      } else if (obj.type === "rect" || obj.type === "circle") {
        obj.x = this.draft.origin.x;
        obj.y = this.draft.origin.y;
        obj.w = q.x - this.draft.origin.x;
        obj.h = q.y - this.draft.origin.y;
        this.draft.moved = Math.hypot(obj.w, obj.h) > 1.5;
      }
    }
    this.schedulePaint(page);
  }

  private finishDraw() {
    const tool = this.hooks.getPrefs().tool;
    if (tool === "eraser") {
      this.draft = null;
      return;
    }
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    if (!draft.moved || (draft.obj.type === "stroke" && draft.obj.points.length < 2)) {
      this.paintPage(draft.page);
      return;
    }
    this.snapshot(draft.page);
    draft.page.objects.push(draft.obj);
    this.paintPage(draft.page);
  }

  private cancelDraft() {
    const page = this.draft?.page ?? null;
    this.draft = null;
    if (page) this.paintPage(page);
    this.hideLaser();
  }

  private eraseAt(page: Page, x: number, y: number) {
    const p = this.toBase(page, x, y);
    const radius = Math.max(16, this.hooks.getPrefs().size * 2.6) / Math.max(0.05, this.displayScale());
    for (let i = page.media.length - 1; i >= 0; i--) {
      const media = page.media[i];
      if (p.x < media.x - radius || p.x > media.x + media.w + radius || p.y < media.y - radius || p.y > media.y + media.h + radius) {
        continue;
      }
      this.snapshot(page);
      page.media.splice(i, 1);
      this.syncMedia(page);
      return;
    }
    for (let i = page.objects.length - 1; i >= 0; i--) {
      if (!hitObj(page.objects[i], p.x, p.y, radius)) continue;
      this.snapshot(page);
      page.objects.splice(i, 1);
      this.schedulePaint(page);
      return;
    }
  }

  private async addText(page: Page, point: Pt) {
    const text = await this.hooks.requestText({
      title: "Write on the page",
      placeholder: "Lesson note",
    });
    if (!text?.trim() || this.docGen === 0 || !page.shell.isConnected) return;
    const scale = Math.max(0.05, this.displayScale());
    const fontSize = Math.max(16, this.hooks.getPrefs().size * 3.1) / scale;
    this.snapshot(page);
    page.objects.push({
      type: "text",
      text: text.trim(),
      x: point.x,
      y: point.y,
      fontSize,
      color: this.hooks.getPrefs().color,
      opacity: this.hooks.getPrefs().opacity,
    });
    this.paintPage(page);
  }

  private beginMedia(hit: MediaHit, event: PointerEvent, mode: "move" | "resize") {
    const p = this.toBase(hit.page, event.clientX, event.clientY);
    this.mode = "media";
    this.mediaDrag = {
      hit,
      mode,
      anchorX: p.x,
      anchorY: p.y,
      startX: hit.media.x,
      startY: hit.media.y,
      startW: hit.media.w,
      startH: hit.media.h,
      moved: false,
      snap: false,
    };
    hit.el.classList.add("is-on");
  }

  private moveMedia(event: PointerEvent) {
    const drag = this.mediaDrag;
    if (!drag) return;
    const p = this.toBase(drag.hit.page, event.clientX, event.clientY);
    if (!drag.snap && Math.hypot(p.x - drag.anchorX, p.y - drag.anchorY) > 1) {
      this.snapshot(drag.hit.page);
      drag.snap = true;
    }
    drag.moved = true;
    if (drag.mode === "move") {
      drag.hit.media.x = clamp(drag.startX + (p.x - drag.anchorX), -20, drag.hit.page.baseW - 20);
      drag.hit.media.y = clamp(drag.startY + (p.y - drag.anchorY), -20, drag.hit.page.baseH - 20);
    } else {
      const scale = Math.max(0.05, this.displayScale());
      drag.hit.media.w = Math.max(28 / scale, drag.startW + (p.x - drag.anchorX));
      drag.hit.media.h = Math.max(28 / scale, drag.startH + (p.y - drag.anchorY));
    }
    this.placeMedia(drag.hit.el, drag.hit.media);
  }

  private finishMedia() {
    this.mediaDrag?.hit.el.classList.remove("is-on");
    if (this.mediaDrag && !this.mediaDrag.snap && this.mediaDrag.hit.page.past.length) {
      /* no snapshot was stored */
    }
    this.mediaDrag = null;
  }

  private moveLaser(x: number, y: number) {
    this.laser.style.display = "block";
    this.laser.style.left = `${x}px`;
    this.laser.style.top = `${y}px`;
  }

  private hideLaser() {
    this.laser.style.display = "none";
  }

  private tapHtml(x: number, y: number) {
    const page = this.pageAt(x, y);
    const iframe = page?.iframe;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;
    const rect = iframe.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const ix = ((x - rect.left) / rect.width) * iframe.clientWidth;
    const iy = ((y - rect.top) / rect.height) * iframe.clientHeight;
    let el: Element | null = null;
    try {
      el = doc.elementFromPoint(ix, iy);
    } catch {
      return;
    }
    if (!el) return;
    const video = el.closest("video");
    if (video instanceof HTMLVideoElement) {
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.controls = true;
      if (video.paused) void video.play().catch(() => this.say("Tap the video controls to play"));
      else video.pause();
      iframe.classList.add("is-live");
      this.videoFocus = true;
      this.patch({ video: true });
      this.say("Video controls on");
      return;
    }
    const audio = el.closest("audio");
    if (audio instanceof HTMLAudioElement) {
      if (audio.paused) void audio.play().catch(() => undefined);
      else audio.pause();
      return;
    }
    const button = el.closest("a,button,summary");
    if (button instanceof HTMLElement) button.click();
  }

  private updateCurrentPage() {
    const pages = this.doc?.pages;
    if (!pages?.length) return;
    const view = this.els.scroll.getBoundingClientRect();
    const mid = (view.top + view.bottom) / 2;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const m = Math.floor((lo + hi) / 2);
      const rect = pages[m].shell.getBoundingClientRect();
      if (rect.bottom < mid) lo = m + 1;
      else hi = m;
    }
    const next = lo + 1;
    if (next !== this.current) {
      this.current = next;
      this.syncHistory();
    }
  }

  private async savePdf() {
    if (!this.pdfBlob || !this.doc) return;
    this.progress("Saving PDF…", 0.02, true);
    const { PDFDocument, rgb } = await import("pdf-lib");
    const bytes = await this.pdfBlob.arrayBuffer();
    const src = await PDFDocument.load(bytes);
    const total = src.getPageCount();
    for (let i = 0; i < total; i++) {
      const page = this.doc.pages[i];
      const pg = src.getPage(i);
      if (!page) continue;
      this.progress(`Saving page ${i + 1} of ${total}…`, (i + 1) / total, false);
      const W = pg.getWidth();
      const H = pg.getHeight();
      const sx = W / page.baseW;
      const sy = H / page.baseH;
      for (const obj of page.objects) {
        const [r, g, b] = hexRgb(objColor(obj));
        const color = rgb(r, g, b);
        const opacity = "opacity" in obj ? obj.opacity : 1;
        if (obj.type === "stroke") {
          for (let j = 1; j < obj.points.length; j++) {
            const a = obj.points[j - 1];
            const c = obj.points[j];
            pg.drawLine({
              start: { x: a.x * sx, y: H - a.y * sy },
              end: { x: c.x * sx, y: H - c.y * sy },
              thickness: obj.width * sx,
              color,
              opacity,
            });
          }
        } else if (obj.type === "line" || obj.type === "arrow") {
          pg.drawLine({
            start: { x: obj.x1 * sx, y: H - obj.y1 * sy },
            end: { x: obj.x2 * sx, y: H - obj.y2 * sy },
            thickness: obj.width * sx,
            color,
            opacity,
          });
          if (obj.type === "arrow") {
            const ang = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
            const len = Math.max(14, obj.width * 4);
            const ax = obj.x2 - len * Math.cos(ang - 0.42);
            const ay = obj.y2 - len * Math.sin(ang - 0.42);
            const bx = obj.x2 - len * Math.cos(ang + 0.42);
            const by = obj.y2 - len * Math.sin(ang + 0.42);
            pg.drawLine({
              start: { x: obj.x2 * sx, y: H - obj.y2 * sy },
              end: { x: ax * sx, y: H - ay * sy },
              thickness: obj.width * sx,
              color,
              opacity,
            });
            pg.drawLine({
              start: { x: obj.x2 * sx, y: H - obj.y2 * sy },
              end: { x: bx * sx, y: H - by * sy },
              thickness: obj.width * sx,
              color,
              opacity,
            });
          }
        } else if (obj.type === "rect") {
          const x = Math.min(obj.x, obj.x + obj.w);
          const y = Math.min(obj.y, obj.y + obj.h);
          pg.drawRectangle({
            x: x * sx,
            y: H - (y + Math.abs(obj.h)) * sy,
            width: Math.abs(obj.w) * sx,
            height: Math.abs(obj.h) * sy,
            borderColor: color,
            borderWidth: obj.width * sx,
            opacity,
          });
        } else if (obj.type === "circle") {
          pg.drawEllipse({
            x: (obj.x + obj.w / 2) * sx,
            y: H - (obj.y + obj.h / 2) * sy,
            xScale: Math.abs(obj.w / 2) * sx,
            yScale: Math.abs(obj.h / 2) * sy,
            borderColor: color,
            borderWidth: obj.width * sx,
            opacity,
          });
        } else if (obj.type === "text") {
          const safe = obj.text.replace(/[^\x20-\x7E]/g, "?");
          try {
            pg.drawText(safe, {
              x: obj.x * sx,
              y: H - obj.y * sy,
              size: Math.max(8, obj.fontSize * sx),
              color,
              opacity,
            });
          } catch {
            /* skip text the standard font cannot encode */
          }
        }
      }
      for (const media of page.media) {
        try {
          const blob = await fetch(media.src).then((res) => res.blob());
          let image;
          if (blob.type === "image/png") image = await src.embedPng(await blob.arrayBuffer());
          else if (blob.type === "image/jpeg") image = await src.embedJpg(await blob.arrayBuffer());
          else {
            const bmp = await createImageBitmap(blob);
            const c = document.createElement("canvas");
            c.width = bmp.width;
            c.height = bmp.height;
            c.getContext("2d")?.drawImage(bmp, 0, 0);
            image = await src.embedPng(c.toDataURL("image/png"));
          }
          pg.drawImage(image, {
            x: media.x * sx,
            y: H - (media.y + media.h) * sy,
            width: media.w * sx,
            height: media.h * sy,
          });
        } catch (err) {
          console.warn(err);
        }
      }
      if (i % 2 === 1) await yieldThread();
    }
    const out = await src.save();
    downloadBlob(new Blob([out], { type: "application/pdf" }), `${this.docName}_annotated.pdf`);
    this.patch({ progress: null });
    this.say("PDF saved");
  }

  private async saveHtml() {
    const page = this.doc?.pages[0];
    if (!page) return;
    this.progress("Saving HTML…", 0.3, true);
    let html = this.htmlSource.replace(
      /<style id="teachpdf-annot-style">[\s\S]*?<\/style>|<div id="teachpdf-annot">[\s\S]*?<!--teachpdf-annot-end-->/g,
      "",
    );
    html = await this.inlineBlobs(html);
    const svg = page.objects.map((obj) => objSvg(obj)).join("");
    const clips: string[] = [];
    for (const media of page.media) {
      let src = media.src;
      const file = this.urlFiles.get(media.src);
      if (file && file.size <= 12 * 1024 * 1024) src = await blobToData(file);
      else if (src.startsWith("blob:")) continue;
      const tag = media.kind === "video" ? "video" : "img";
      const extra = media.kind === "video" ? " controls playsinline" : "";
      clips.push(
        `<${tag} src="${src}"${extra} style="position:absolute;left:${media.x}px;top:${media.y}px;width:${media.w}px;height:${media.h}px"></${tag}>`,
      );
    }
    const block = `<style id="teachpdf-annot-style">#teachpdf-annot{position:absolute;left:0;top:0;width:${page.baseW}px;height:${page.baseH}px;pointer-events:none;z-index:2147483000}</style><div id="teachpdf-annot"><svg width="${page.baseW}" height="${page.baseH}" viewBox="0 0 ${page.baseW} ${page.baseH}">${svg}</svg>${clips.join("")}</div><!--teachpdf-annot-end-->`;
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${block}</body>`);
    else html += block;
    downloadBlob(new Blob([html], { type: "text/html" }), `${this.docName}_annotated.html`);
    this.patch({ progress: null });
    this.say(clips.length < page.media.length ? "HTML saved. A very large clip was left out so the phone stays stable." : "HTML saved — animation kept");
  }

  private async inlineBlobs(html: string) {
    const found = html.match(/blob:[^"' )\s]+/g) ?? [];
    let out = html;
    let skipped = false;
    for (const url of [...new Set(found)]) {
      const file = this.urlFiles.get(url);
      if (!file) continue;
      if (file.size > 12 * 1024 * 1024) {
        skipped = true;
        continue;
      }
      const data = await blobToData(file);
      out = out.split(url).join(data);
    }
    if (skipped) this.say("A very large attachment was left out of the download");
    return out;
  }

  private progress(label: string, ratio: number, force: boolean) {
    if (!force && ratio < 1 && ratio - this.progLast < 0.05) return;
    this.progLast = ratio;
    this.patch({ progress: { label, ratio } });
  }

  private patch(p: TeachPatch) {
    if (this.alive) this.hooks.patch(p);
  }

  private say(text: string, ms = 1700) {
    const n = ++this.statusN;
    this.patch({ status: text });
    window.setTimeout(() => {
      if (this.statusN === n) this.patch({ status: "" });
    }, ms);
  }
}

function objColor(obj: DrawObj) {
  return obj.color;
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function blobToData(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function measureBox(url: string, kind: "image" | "video") {
  return new Promise<{ w: number; h: number }>((resolve) => {
    if (kind === "video") {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => resolve({ w: video.videoWidth || 320, h: video.videoHeight || 180 });
      video.onerror = () => resolve({ w: 320, h: 180 });
      video.src = url;
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 240, h: img.naturalHeight || 180 });
    img.onerror = () => resolve({ w: 240, h: 180 });
    img.src = url;
  });
}