// Print page: receives the messages to print from the main page through chrome.storage.session.
import { esc, noBidi } from "./text.js";
import { IMAGE_SRC } from "./api.js";
const fmt = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const fmtList = l => (l || []).map(fmt).join(", ");
// A message without a usable date prints without the line, not as "Invalid Date".
const when = d => { const t = new Date(Number(d) * 1000); return d && !isNaN(t) ? t.toLocaleString() : ""; };
const BODY_CSS = ":host{display:block}img{max-width:100%;height:auto}blockquote{border-left:2px solid #bbb;margin:6px 0;padding-left:10px;color:#444}pre{white-space:pre-wrap}";

(async () => {
  // Only a print job's own key: any other would read, and then remove, someone else's entry.
  const key = new URLSearchParams(location.search).get("job") || "";
  const job = /^print:\d+$/.test(key) ? (await chrome.storage.session.get(key))[key] : null;
  if (!job) { document.getElementById("info").textContent = "Nothing to print (the job has expired)."; return; }
  chrome.storage.session.remove(key);
  // The reader's image policy, before any message is added: images from where the provider allows
  // only when every message may load them (not one from Spam or Trash), otherwise embedded ones
  // only. Nothing else, so no style, SVG or media element can request an address with the session.
  const csp = Object.assign(document.createElement("meta"), { httpEquiv: "Content-Security-Policy",
    content: `img-src data:${job.images ? ` ${IMAGE_SRC}` : ""}; media-src 'none'` });
  document.head.prepend(csp);
  const pages = document.getElementById("pages");
  for (const m of job.messages) {
    const h = m.headers || {};
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<div class="hdr"><h1>${esc(h.subject || "(no subject)")}</h1><table>
      <tr><td>From</td><td>${esc(fmtList(h.from))}</td></tr>
      <tr><td>To</td><td>${esc(fmtList(h.to))}</td></tr>
      ${h.cc?.length ? `<tr><td>Cc</td><td>${esc(fmtList(h.cc))}</td></tr>` : ""}
      ${when(h.date) ? `<tr><td>Date</td><td>${esc(when(h.date))}</td></tr>` : ""}</table>
      ${m.attachments?.length ? `<div class="att">Attachments: ${m.attachments.map(a => esc(a)).join(", ")}</div>` : ""}</div>
      <div class="body"></div>`;
    // Body HTML was sanitised by the main page; scripts are additionally blocked by the extension
    // CSP. It goes into a shadow root so its style sheets reach only the message itself, and the
    // body box paints nothing outside itself, so neither can hide or fake the header above.
    const shadow = el.querySelector(".body").attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${BODY_CSS}</style>${m.html}`;
    pages.appendChild(el);
  }
  document.title = job.messages.length === 1 ? noBidi(job.messages[0].headers?.subject || "Print") : `${job.messages.length} messages`;
  document.getElementById("info").textContent = `${job.messages.length} message${job.messages.length === 1 ? "" : "s"}; Save as PDF is in the print dialog.`;
  document.getElementById("print").onclick = () => print();
  const imgs = [...pages.querySelectorAll(".body")].flatMap(b => [...b.shadowRoot.querySelectorAll("img")]);
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 4000); })));
  if (job.auto && !navigator.webdriver) print();
})();
