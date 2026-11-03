// Attachment renderer for the sandboxed render.html. The viewer in the extension page sends file
// bytes, extracted text or converted pages here; everything that parses attacker-supplied files
// (PDF.js, docx-preview, SheetJS, the converter's HTML, ZIP directories) runs in this page, which
// has an opaque origin, no cookies, no extension APIs and no network access beyond its own
// files. Links and navigation keys are handed back to the viewer, which decides what to do.
"use strict";
(() => {
  const root = document.getElementById("root");
  const PARENT = new URL(location.href).origin;          // the extension's origin
  const post = (m, transfer) => parent.postMessage(m, PARENT, transfer || []);
  const esc = s => String(s ?? "").replace(/[\u202A-\u202E\u2066-\u2069]/g, "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sizeStr = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
  const note = text => `<div class="note">${esc(text)}</div>`;
  let mode = "", zoom = null;

  // ---------- libraries, loaded on first use ----------
  const loaded = new Map();
  function loadScript(path) {
    if (!loaded.has(path)) loaded.set(path, new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = path; s.onload = ok; s.onerror = () => no(new Error(`could not load ${path}`));
      document.head.appendChild(s);
    }));
    return loaded.get(path);
  }
  function loadCss(path) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = path;
    document.head.appendChild(l);
  }

  // ---------- links and keys go back to the viewer ----------
  root.addEventListener("click", e => {
    const link = e.composedPath().find(n => n.tagName === "A" && n.getAttribute?.("href"));
    if (!link) return;
    const href = link.getAttribute("href");
    if (mode === "pdf" && href.startsWith("#")) return;   // PDF.js handles its own destinations
    e.preventDefault();
    if (href.startsWith("#")) {
      const name = decodeURIComponent(href.slice(1));
      const host = e.composedPath().find(n => n instanceof ShadowRoot) || document;
      (host.getElementById?.(name) || host.querySelector(`[name="${CSS.escape(name)}"]`))?.scrollIntoView({ block: "start" });
    } else post({ type: "link", href });
  }, true);

  document.addEventListener("keydown", e => {
    if (["Escape", "ArrowLeft", "ArrowRight"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); post({ type: "key", key: e.key });
    } else if (zoom && (e.key === "+" || e.key === "=")) { e.preventDefault(); zoom(1); }
    else if (zoom && e.key === "-") { e.preventDefault(); zoom(-1); }
    else if (zoom && e.key === "0") { e.preventDefault(); zoom(0); }
  });

  // ---------- PDF: PDF.js with its text layer ----------
  // A worker cannot be started from an opaque origin, so PDF.js parses on this page's thread.
  let pdfjs = null;
  function loadPdfjs() {
    if (!pdfjs) pdfjs = (async () => {
      const lib = await import("./vendor/pdfjs/pdf.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
      globalThis.pdfjsLib = lib;          // pdf_viewer.mjs reads the core library from here
      const ui = await import("./vendor/pdfjs/pdf_viewer.mjs");
      loadCss("vendor/pdfjs/pdf_viewer.css");
      return { lib, ui };
    })();
    return pdfjs;
  }

  async function renderPdf(bytes) {
    const { lib, ui } = await loadPdfjs();
    const base = new URL("vendor/pdfjs/", location.href).href;
    const doc = await lib.getDocument({
      data: new Uint8Array(bytes), cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/", iccUrl: base + "iccs/", enableScripting: false, isEvalSupported: false,
    }).promise;
    root.className = "pdf";
    root.innerHTML = `<div class="pdfViewer"></div>`;
    const eventBus = new ui.EventBus();
    const linkService = new ui.PDFLinkService({ eventBus, externalLinkTarget: ui.LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
    const viewer = new ui.PDFViewer({ container: root, eventBus, linkService, textLayerMode: 1, annotationMode: lib.AnnotationMode.ENABLE, removePageBorders: false });
    linkService.setViewer(viewer);
    eventBus.on("pagesinit", () => { viewer.currentScaleValue = "page-width"; root.focus(); });
    const pageInfo = () => post({ type: "meta", text: `page ${viewer.currentPageNumber} of ${doc.numPages}` });
    eventBus.on("pagechanging", pageInfo);
    viewer.setDocument(doc);
    linkService.setDocument(doc);
    pageInfo();
    zoom = dir => {
      if (dir === 0) viewer.currentScaleValue = "page-width";
      else viewer.currentScale = Math.min(5, Math.max(0.25, viewer.currentScale * (dir > 0 ? 1.2 : 1 / 1.2)));
    };
    post({ type: "zoomable" });
  }

  // ---------- Word (.docx): docx-preview ----------
  async function renderDocx(bytes) {
    await loadScript("vendor/jszip.min.js");
    await loadScript("vendor/docx-preview.min.js");
    const wrap = document.createElement("div");
    await globalThis.docx.renderAsync(new Blob([bytes]), wrap, wrap, { inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, renderComments: false, experimental: true });
    root.className = "doc";
    root.replaceChildren(wrap);
  }

  // ---------- Spreadsheets: SheetJS, one tab per sheet ----------
  const colName = n => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const MAX_ROWS = 5000, MAX_COLS = 200;

  async function renderSheet(bytes) {
    await loadScript("vendor/xlsx.full.min.js");
    const XLSX = globalThis.XLSX;
    const wb = XLSX.read(new Uint8Array(bytes), { type: "array", sheetRows: MAX_ROWS + 1, cellStyles: false });
    const names = wb.SheetNames;
    root.className = "sheet";
    root.innerHTML = `<div class="grid" tabindex="-1"></div><div class="tabs">${names.map((n, i) => `<button data-i="${i}">${esc(n)}</button>`).join("")}</div>`;
    const grid = root.querySelector(".grid"), tabs = root.querySelector(".tabs");
    const show = i => {
      tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", Number(b.dataset.i) === i));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[names[i]], { header: 1, raw: false, defval: "", blankrows: true });
      const cols = Math.min(MAX_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0));
      const shown = rows.slice(0, MAX_ROWS);
      post({ type: "meta", text: `${names.length > 1 ? `sheet ${i + 1} of ${names.length} · ` : ""}${rows.length >= MAX_ROWS ? `first ${MAX_ROWS} rows` : `${rows.length} rows`}` });
      grid.innerHTML = `<table><thead><tr><th class="rn"></th>${Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join("")}</tr></thead><tbody>${
        shown.map((r, ri) => `<tr><th class="rn">${ri + 1}</th>${Array.from({ length: cols }, (_, c) => {
          const v = String(r[c] ?? "");
          return `<td${/^-?[\d.,]+%?$|^[$€£¥]/.test(v) ? ' class="num"' : ""}>${esc(v)}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table>`;
      grid.scrollTo(0, 0);
      grid.focus();
    };
    tabs.onclick = e => { const b = e.target.closest("button"); if (b) show(Number(b.dataset.i)); };
    tabs.classList.toggle("hidden", names.length < 2);
    show(0);
  }

  // ---------- Pages from the provider's document converter ----------
  const decodeEntities = s => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };
  let pageState = null;

  function addPages(pages) {
    for (const p of pages) {
      const host = document.createElement("div");
      host.className = "page";
      const shadow = host.attachShadow({ mode: "open" });
      // The page's CSS goes in as a style element's text, so nothing in it is parsed as markup.
      const css = decodeEntities(p.css || "").replace(/<\/?style[^>]*>/gi, "");
      shadow.innerHTML = DOMPurify.sanitize(decodeEntities(p.html || ""), { FORBID_TAGS: ["form", "input", "button", "textarea", "select"] });
      const sheet = text => Object.assign(document.createElement("style"), { textContent: text });
      shadow.prepend(sheet(":host{display:block} .aps-page{position:relative;overflow:auto} img{max-width:100%;height:auto}"), sheet(css));
      pageState.list.appendChild(host);
    }
  }

  function renderPages({ pages, total, provider }) {
    root.className = "pages";
    root.innerHTML = note(`Converted by ${provider || "the mail service"}. Download for the original.`) + `<div class="page-list"></div><div class="more"></div>`;
    pageState = { list: root.querySelector(".page-list"), more: root.querySelector(".more"), next: pages.length + 1, total, busy: false };
    post({ type: "meta", text: `${total} page${total === 1 ? "" : "s"}` });
    addPages(pages);
    root.focus();
    if (pageState.next > total) { pageState.more.remove(); return; }
    pageState.more.textContent = "Loading more pages...";
    pageState.io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || pageState.busy) return;
      pageState.busy = true;
      post({ type: "more", next: pageState.next });
    }, { root, rootMargin: "600px" });
    pageState.io.observe(pageState.more);
  }

  function morePages({ pages, error }) {
    if (!pageState) return;
    pageState.busy = false;
    if (error) { pageState.io.disconnect(); pageState.more.textContent = `Could not load the remaining pages (${error}).`; return; }
    addPages(pages);
    pageState.next += pages.length;
    if (pageState.next > pageState.total) { pageState.io.disconnect(); pageState.more.remove(); }
    else { pageState.io.unobserve(pageState.more); pageState.io.observe(pageState.more); }
  }

  // ---------- Text, CSV, JSON ----------
  function parseDelimited(text, sep) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"' && cell === "") q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function renderText({ text, ext, source, size, provider = "the mail service" }) {
    root.className = "";
    if (ext === "csv" || ext === "tsv") {
      const first = text.split(/\r?\n/, 1)[0];
      const sep = ext === "tsv" ? "\t" : [",", ";", "\t", "|"].map(s => [s, first.split(s).length]).sort((x, y) => y[1] - x[1])[0][0];
      const rows = parseDelimited(text, sep), shown = rows.slice(0, 2000);
      root.innerHTML = note(`${rows.length} rows${rows.length > shown.length ? `, first ${shown.length} shown` : ""}; separator “${sep === "\t" ? "tab" : sep}”.`) +
        `<table class="plain">${shown.map((r, i) => `<tr>${r.map(c => i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
      return;
    }
    if (ext === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    const label = source === "extracted" ? `Text extracted by ${provider}; layout, images and formatting are not shown. Download for the original.`
      : source === "stored" ? `Text as stored by ${provider}.`
      : source === "hex" ? `${Number(size) || 0} bytes, shown as offset, hex and ASCII.` : "";
    root.innerHTML = (label ? note(label) : "") + "<pre></pre>";
    root.querySelector("pre").textContent = text || "(no text)";
    if (source === "hex") root.querySelector("pre").className = "hex";
  }

  // ---------- ZIP: entries from the central directory, no decompression ----------
  function renderZip(bytes) {
    const all = new DataView(bytes);
    const from = Math.max(0, all.byteLength - 65557);
    let eocd = -1;
    for (let i = all.byteLength - 22; i >= from; i--) if (all.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a ZIP archive");
    const count = all.getUint16(eocd + 10, true), cdSize = all.getUint32(eocd + 12, true), cdOff = all.getUint32(eocd + 16, true);
    if (cdOff + cdSize > all.byteLength) throw new Error("damaged ZIP directory");
    const dec = new TextDecoder(), out = [];
    for (let n = 0, p = cdOff; n < count && p + 46 <= cdOff + cdSize; n++) {
      if (all.getUint32(p, true) !== 0x02014b50) break;
      const time = all.getUint16(p + 12, true), date = all.getUint16(p + 14, true);
      const packed = all.getUint32(p + 20, true), size = all.getUint32(p + 24, true);
      const nl = all.getUint16(p + 28, true), xl = all.getUint16(p + 30, true), cl = all.getUint16(p + 32, true);
      const name = dec.decode(new Uint8Array(bytes, p + 46, Math.min(nl, all.byteLength - p - 46)));
      const d = `${1980 + (date >> 9)}-${String((date >> 5) & 15).padStart(2, "0")}-${String(date & 31).padStart(2, "0")} ${String(time >> 11).padStart(2, "0")}:${String((time >> 5) & 63).padStart(2, "0")}`;
      out.push({ name, size, packed, date: d, dir: name.endsWith("/") });
      p += 46 + nl + xl + cl;
    }
    root.className = "";
    root.innerHTML = note(`${out.length} entries; download to extract.`) +
      `<table class="plain"><tr><th>Name</th><th>Size</th><th>Packed</th><th>Modified</th></tr>${out.map(e =>
        `<tr><td>${esc(e.name)}</td><td>${e.dir ? "" : sizeStr(e.size)}</td><td>${e.dir ? "" : sizeStr(e.packed)}</td><td>${esc(e.date)}</td></tr>`).join("")}</table>`;
  }

  // ---------- messages from the viewer ----------
  const RENDER = { pdf: m => renderPdf(m.bytes), docx: m => renderDocx(m.bytes), sheet: m => renderSheet(m.bytes),
    pages: m => renderPages(m), text: m => renderText(m), zip: m => renderZip(m.bytes) };

  addEventListener("message", async e => {
    if (e.source !== parent || e.origin !== PARENT) return;
    const m = e.data || {};
    if (m.type === "zoom") { zoom?.(m.dir); return; }
    if (m.type === "pages") { morePages(m); return; }
    if (m.type !== "render" || !RENDER[m.kind]) return;
    mode = m.kind;
    try { await RENDER[m.kind](m); post({ type: "done" }); }
    catch (err) { post({ type: "error", message: String(err?.message || err) }); }
  });

  root.tabIndex = -1;
  post({ type: "ready" });
})();
