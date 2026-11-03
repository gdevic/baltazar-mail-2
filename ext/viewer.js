// Attachment strip under the message body and the viewer. Attachment bytes come from the provider
// adapter. Images and media play in native elements here; everything else is parsed and drawn in
// the sandboxed render.html (PDF.js, docx-preview, SheetJS, ZIP listings, text). Formats with no
// renderer there use the provider's document converter and extracted text, when it has them.

import { asText, hexDump } from "./bytes.js";
import { esc, noBidi } from "./text.js";

const $ = id => document.getElementById(id);
const sizeStr = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
const extOf = n => (String(n || "").match(/\.([a-z0-9]{1,6})$/i)?.[1] || "").toLowerCase();

const TEXT = new Set(["txt", "log", "md", "markdown", "ini", "cfg", "conf", "yaml", "yml", "toml", "ics", "vcf", "eml", "csv", "tsv", "json", "xml", "srt", "diff", "patch"]);
const CODE = new Set(["c", "h", "cpp", "hpp", "cc", "cs", "java", "py", "js", "ts", "go", "rs", "sh", "bat", "ps1", "pl", "rb", "php", "sql", "v", "sv", "vh", "vhd", "vhdl", "asm", "s", "inc", "mk", "cmake", "tcl", "qsf", "sdc", "ucf", "xdc", "lua", "kt", "swift"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const OFFICE_DOC = new Set(["doc", "docx", "rtf", "odt", "pages"]);
const OFFICE_SHEET = new Set(["xls", "xlsx", "ods", "numbers"]);
const OFFICE_SLIDE = new Set(["ppt", "pptx", "odp", "key"]);
const ZIP = new Set(["zip", "jar", "apk", "docm"]);

function kindOf(a) {
  const ext = extOf(a.filename), sub = (a.subtype || "").toLowerCase(), type = (a.type || "").toLowerCase();
  if (ext === "pdf" || sub === "pdf") return "pdf";
  if (IMAGE.has(ext) || type === "image") return "image";
  if (ext === "html" || ext === "htm" || sub === "html") return "html";
  if (AUDIO.has(ext) || type === "audio") return "audio";
  if (VIDEO.has(ext) || type === "video") return "video";
  if (ZIP.has(ext) || sub === "zip" || sub === "x-zip-compressed") return "zip";
  if (OFFICE_DOC.has(ext) || /wordprocessing|msword/.test(sub)) return "doc";
  if (OFFICE_SHEET.has(ext) || /spreadsheet|excel/.test(sub)) return "sheet";
  if (OFFICE_SLIDE.has(ext) || /presentation|powerpoint/.test(sub)) return "slide";
  if (CODE.has(ext)) return "code";
  if (TEXT.has(ext) || type === "text") return "text";
  return "other";
}
const LABEL = { pdf: "PDF", image: "IMG", html: "HTML", audio: "AUD", video: "VID", zip: "ZIP", doc: "DOC", sheet: "XLS", slide: "PPT", code: "CODE", text: "TXT", other: "FILE" };
const CLASS = { pdf: "k-pdf", image: "k-image", html: "k-html", audio: "k-audio", video: "k-video", zip: "k-zip", doc: "k-doc", sheet: "k-sheet", slide: "k-slide", code: "k-code", text: "k-text", other: "k-other" };

// { thumb(msgId, a) -> data URL | null, bytes(msgId, a) -> { bytes, type, filename }, docPages?(docId, start, end, retry),
//   extractText?(a) -> string, originalUrl?(a) -> url | null, cleanHtml(html), status(msg), providerName }
let hooks = null;
let items = [], index = 0, msgId = null;
let objectUrls = [];

export function init(h) {
  hooks = h;
  $("v-close").onclick = close;
  $("v-prev").onclick = () => show(index - 1);
  $("v-next").onclick = () => show(index + 1);
  $("v-dl").onclick = () => download(items[index]);
  $("v-open").onclick = () => openInTab(items[index]);
  $("viewer").onclick = e => { if (e.target.id === "viewer") close(); };
  $("v-zin").onclick = () => current?.zoom?.(1);
  $("v-zout").onclick = () => current?.zoom?.(-1);
  $("v-fit").onclick = () => current?.zoom?.(0);
}

export function isOpen() { return !$("viewer").classList.contains("hidden"); }

export function onKey(e) {
  if (e.key === "Escape") close();
  else if (e.key === "ArrowLeft") show(index - 1);
  else if (e.key === "ArrowRight") show(index + 1);
  else if (current?.zoom && (e.key === "+" || e.key === "=")) current.zoom(1);
  else if (current?.zoom && e.key === "-") current.zoom(-1);
  else if (current?.zoom && e.key === "0") current.zoom(0);
  else return false;
  e.preventDefault();
  return true;
}

// ---------- strip ----------
export function renderStrip(message, attachments, isCurrent) {
  const box = $("r-attach");
  items = attachments.filter(a => a.disposition !== "inline");
  msgId = message.id;
  box.classList.toggle("hidden", !items.length);
  if (!items.length) { box.innerHTML = ""; return; }
  const total = items.reduce((s, a) => s + (a.size || 0), 0);
  box.innerHTML = `<div class="att-head"><b>${items.length} attachment${items.length === 1 ? "" : "s"}</b>${sizeStr(total)}</div>` +
    items.map((a, i) => {
      const k = kindOf(a);
      return `<div class="att-card" data-i="${i}" title="${esc(a.filename || "attachment")}: click to preview">
        <span class="att-thumb ${CLASS[k]}" data-i="${i}">${(k === "text" || k === "code") && extOf(a.filename) ? esc(extOf(a.filename).toUpperCase().slice(0, 4)) : LABEL[k]}</span>
        <span class="att-info"><span class="att-name">${esc(a.filename || "Untitled")}</span><span class="att-size">${sizeStr(a.size)}</span></span></div>`;
    }).join("");
  box.onclick = e => { const c = e.target.closest(".att-card"); if (c) show(Number(c.dataset.i)); };
  items.forEach(async (a, i) => {
    if (kindOf(a) !== "image") return;
    const src = await hooks.thumb(message.id, a).catch(() => null);
    if (!src || !isCurrent(message.id)) return;
    const slot = box.querySelector(`.att-thumb[data-i="${i}"]`);
    if (slot) slot.replaceChildren(Object.assign(document.createElement("img"), { src, alt: "" }));
  });
}

// ---------- fetching ----------
// The provider hands over an attachment's bytes (hooks.bytes). The blob's type comes from the
// file name. The sender's header is used only for an image, audio or video type the name does
// not settle; anything else is untyped, since an image opened in a tab from the viewer would
// otherwise show the sender's HTML at the extension's address.
const MEDIA_TYPE = /^(image\/(png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;
async function fetchBlob(a, id = msgId) {
  const { bytes, type } = await hooks.bytes(id, a);
  return new Blob([bytes], { type: MIME[extOf(a.filename)] || (MEDIA_TYPE.test(type || "") ? type : "application/octet-stream") });
}

function objectUrl(blob, type) {
  const u = URL.createObjectURL(type && blob.type !== type ? new Blob([blob], { type }) : blob);
  objectUrls.push(u);
  return u;
}

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  avif: "image/avif", ico: "image/x-icon", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  opus: "audio/ogg", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg" };

// ---------- viewer ----------
let current = null;   // { cleanup(), zoom(dir) } for the renderer on screen

function teardown() {
  try { current?.cleanup?.(); } catch {}
  current = null;
  $("v-zoom").classList.add("hidden");
}

function close() {
  teardown();
  $("viewer").classList.add("hidden");
  $("v-body").innerHTML = "";
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

const center = html => `<div class="v-center">${html}</div>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Office formats that have a renderer here; the rest go to the provider's converter.
const isDocx = a => extOf(a.filename) === "docx" || /wordprocessingml/.test(a.subtype || "");
const isSheet = a => ["xlsx", "xlsm", "xls", "ods", "numbers"].includes(extOf(a.filename)) || /spreadsheetml|ms-excel/.test(a.subtype || "");

async function show(i) {
  if (!items.length) return;
  teardown();
  index = (i + items.length) % items.length;
  const a = items[index], k = kindOf(a), id = msgId, at = index;
  $("viewer").classList.remove("hidden");
  $("v-name").textContent = noBidi(a.filename || "Untitled");
  const meta = extra => { $("v-meta").textContent = `${sizeStr(a.size)} · ${LABEL[k]}${extra ? ` · ${extra}` : ""}${items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}`; };
  meta("");
  $("v-prev").disabled = $("v-next").disabled = items.length < 2;
  const body = $("v-body");
  body.innerHTML = center("Loading...");
  const stale = () => msgId !== id || index !== at || !isOpen();
  const ctx = { a, k, body, stale, meta };
  const bytes = async () => (await fetchBlob(a)).arrayBuffer();
  try {
    if (k === "pdf") return await sandboxed(ctx, { kind: "pdf", bytes: await bytes() });
    if (k === "doc" && isDocx(a)) return await sandboxed(ctx, { kind: "docx", bytes: await bytes() });
    if (k === "sheet" && isSheet(a)) return await sandboxed(ctx, { kind: "sheet", bytes: await bytes() });
    if (k === "doc" || k === "sheet" || k === "slide" || k === "other") return await showConverted(ctx);
    const blob = await fetchBlob(a);
    if (stale()) return;
    const ext = extOf(a.filename);
    if (k === "image") {
      body.innerHTML = `<img class="v-img" alt="">`;
      const img = body.querySelector("img");
      img.src = objectUrl(blob, MIME[ext]);
      img.onclick = () => img.classList.toggle("full");
    } else if (k === "audio" || k === "video") {
      body.innerHTML = center(`<${k} controls autoplay></${k}>`);
      body.querySelector(k).src = objectUrl(blob, MIME[ext]);
    } else if (k === "html") {
      const html = hooks.cleanHtml(await blob.text());
      body.innerHTML = `<iframe sandbox="" referrerpolicy="no-referrer" title="HTML"></iframe>`;
      body.querySelector("iframe").srcdoc = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${html}`;
    } else if (k === "zip") {
      await sandboxed(ctx, { kind: "zip", bytes: await blob.arrayBuffer() });
    } else {
      if (blob.size > 3 * 1048576) { body.innerHTML = center(`Too large to preview (${sizeStr(blob.size)}). <button id="v-dl2">Download</button>`); $("v-dl2").onclick = () => download(a); return; }
      await sandboxed(ctx, { kind: "text", text: await blob.text(), ext });
    }
  } catch (e) {
    if (stale()) return;
    // The renderer or the bytes failed: the provider's converter, then its plain text, then give up.
    try { if (k !== "image" && k !== "audio" && k !== "video" && k !== "zip") return await showConverted(ctx); } catch {}
    if (stale()) return;
    // A small file nothing could preview can still be read: as text when it looks like text,
    // otherwise as a hex dump.
    let raw = null;
    if ((a.size || 0) <= RAW_VIEW_MAX) {
      try { raw = new Uint8Array(await (await fetchBlob(a)).arrayBuffer()); } catch {}
      if (raw && raw.length > RAW_VIEW_MAX) raw = null;
    }
    if (stale()) return;
    const text = raw && asText(raw);
    body.innerHTML = center(`No preview available for this file (${esc(e.message)}). ` +
      (raw ? `<button id="v-raw">${text != null ? "View as text" : "View as binary"}</button> ` : "") + `<button id="v-dl2">Download</button>`);
    $("v-dl2").onclick = () => download(a);
    if (raw) $("v-raw").onclick = () => showRaw(ctx, raw, text);
  }
}

const RAW_VIEW_MAX = 100 * 1024;
async function showRaw(ctx, raw, text) {
  const { a, body, stale, meta } = ctx;
  body.innerHTML = center("Loading...");
  meta(text != null ? "as text" : "as binary");
  try {
    if (text != null) await sandboxed(ctx, { kind: "text", text: text.replace(/[\x00-\x08\x0b\x0e-\x1a\x1c-\x1f\x7f]/g, "\u00b7"), ext: "txt" });
    else await sandboxed(ctx, { kind: "text", text: hexDump(raw), ext: "txt", source: "hex", size: raw.length });
  } catch (e) {
    if (stale()) return;
    body.innerHTML = center(`Could not show the file (${esc(e.message)}). <button id="v-dl2">Download</button>`);
    $("v-dl2").onclick = () => download(a);
  }
}

// ---------- sandboxed rendering ----------
// Files are parsed and drawn by render.html, a manifest sandbox page: opaque origin, no cookies,
// no extension APIs, no network beyond its own files (see render.js). Messages from it are
// treated as untrusted: only known types are acted on, and links are checked before opening.
const SAFE_LINK = /^(https?:|mailto:)/i;
const CHUNK = 3;

function sandboxed(ctx, request) {
  const { a, body, stale, meta } = ctx;
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.className = "v-box";
    frame.title = "Preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.visibility = "hidden";
    const send = (m, transfer) => frame.contentWindow?.postMessage(m, "*", transfer || []);
    // 30 s for the sandbox to start, then 2 minutes to render; a preview that fails takes its
    // frame with it, so a fallback never sits next to a frame still drawing.
    const fail = message => { clearTimeout(timer); window.removeEventListener("message", onMessage); frame.remove(); reject(new Error(message)); };
    let timer = setTimeout(() => fail("the preview did not start"), 30000);
    const onMessage = async e => {
      if (e.source !== frame.contentWindow || stale()) return;
      const m = e.data || {};
      switch (m.type) {
        case "ready":
          clearTimeout(timer);
          timer = setTimeout(() => fail("the preview took too long"), 120000);
          send({ type: "render", ...request }, request.bytes ? [request.bytes] : []);
          break;
        case "done":
          clearTimeout(timer);
          frame.style.visibility = "";
          body.querySelector(".v-center")?.remove();
          frame.focus();
          resolve();
          break;
        case "error":
          fail(String(m.message || "preview failed").slice(0, 200));
          break;
        case "meta":
          meta(String(m.text || "").slice(0, 120));
          break;
        case "zoomable":
          $("v-zoom").classList.remove("hidden");
          if (current) current.zoom = dir => send({ type: "zoom", dir });
          break;
        case "link":
          if (typeof m.href === "string" && SAFE_LINK.test(m.href.trim())) window.open(m.href.trim(), "_blank", "noopener,noreferrer");
          break;
        case "key":
          if (["Escape", "ArrowLeft", "ArrowRight"].includes(m.key)) onKey({ key: m.key, preventDefault() {} });
          break;
        case "more":
          if (request.kind !== "pages" || !Number.isInteger(m.next) || m.next < 1 || m.next > request.total) break;
          try {
            const r = await fetchPages(a.documentId, m.next, Math.min(request.total, m.next + CHUNK - 1), stale);
            if (r && !stale()) send({ type: "pages", pages: r.pages.map(p => ({ html: p.html, css: p.css })) });
          } catch (err) { send({ type: "pages", error: err.message }); }
          break;
      }
    };
    window.addEventListener("message", onMessage);
    current = { cleanup: () => { clearTimeout(timer); window.removeEventListener("message", onMessage); } };
    frame.src = "render.html";
    body.appendChild(frame);
  });
}

// ----- Formats with no renderer here: the provider's converter (pages load as you scroll), then its text -----
const PENDING = new Set([605, 612, 621, 814]);

async function fetchPages(docId, s, e, stale) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await hooks.docPages(docId, s, e, attempt);
    if (r.code === 800 && r.pages.length && r.pages.every(p => p.ok)) return r;
    if (r.code !== 800 && !PENDING.has(r.code) && r.pages.length === 0 && attempt > 0) throw new Error(`converter code ${r.code}`);
    if (stale()) return null;
    await sleep(700 * (attempt + 1));
  }
  throw new Error("converter did not finish");
}

async function showConverted(ctx) {
  const { a, stale } = ctx;
  if (!a.documentId || !hooks.docPages) return showText(ctx);
  const first = await fetchPages(a.documentId, 1, CHUNK, stale);
  if (!first || stale()) return;
  const total = first.total || first.pages.length;
  await sandboxed(ctx, { kind: "pages", total, pages: first.pages.map(p => ({ html: p.html, css: p.css })), provider: hooks.providerName });
}

async function showText(ctx) {
  const { a, k, stale } = ctx;
  if (!hooks.extractText) throw new Error("no preview available");
  const text = await hooks.extractText(a);
  if (stale()) return;
  await sandboxed(ctx, { kind: "text", text, ext: extOf(a.filename), source: k === "text" || k === "code" ? "stored" : "extracted", provider: hooks.providerName });
}

// ---------- download / open ----------
async function download(a) {
  try {
    const blob = await fetchBlob(a);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = noBidi(a.filename || "attachment");
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  } catch {
    // The provider's own link, when it has one: a background tab follows it and saves the original.
    const u = hooks.originalUrl?.(a);
    if (u) chrome.tabs.create({ url: u, active: false }); else hooks.status("could not fetch the attachment");
  }
}

// A blob opened in a tab is shown under the extension's own address, so only types the browser
// displays inertly are opened that way, and the type comes from the file name, never from the
// sender's MIME header. Anything else is downloaded instead.
const OPEN_SAFE = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4" };

async function openInTab(a) {
  const k = kindOf(a), ext = extOf(a.filename);
  const type = OPEN_SAFE[ext] || (k === "text" || k === "code" ? "text/plain;charset=utf-8" : null);
  if (!type) return download(a);
  try {
    const blob = await fetchBlob(a);
    const u = URL.createObjectURL(new Blob([blob], { type }));
    window.open(u, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch {
    const u = hooks.originalUrl?.(a);
    if (u) chrome.tabs.create({ url: u }); else hooks.status("could not fetch the attachment");
  }
}
