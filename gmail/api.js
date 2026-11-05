// Protocol adapter for the Gmail REST API, with the same exports as the Yahoo adapter
// (yahoo/api.js). Every endpoint and payload shape lives here; nothing else in the client knows
// the wire format. See docs/gmail-api.md.
//
// Gmail has labels where the client has folders: the system labels become the system folders, a
// user label is a folder named by its path, and "All Mail" stands in for the archive. A message
// moves by losing the label of the folder it is shown in (and Inbox, Spam or Trash) and gaining
// the target's; its other labels stay. Drafts keep a draft id across saves while their message id
// changes, so the client's csid is the draft id.

import { getToken, forget, signOut as revoke, NotSignedIn } from "./auth.js";
import { build, parseAddresses, messageIdOf } from "./rfc822.js";
import { sniffImage } from "./bytes.js";
import { remember } from "./cache.js";
import { clean, isoDate } from "./query.js";
import { esc } from "./text.js";

export { NotSignedIn };

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const ALL = "ALL";                       // the All Mail pseudo folder: every message without a label filter
const SYSTEM = { INBOX: ["INBOX", "Inbox"], DRAFT: ["DRAFT", "Drafts"], SENT: ["SENT", "Sent"], SPAM: ["BULK", "Spam"], TRASH: ["TRASH", "Trash"] };
const FOLDER_LABELS = new Set(["INBOX", "SPAM", "TRASH"]);   // system labels that act as a message's folder
const HIDDEN = /^(STARRED|UNREAD|IMPORTANT|CHAT|CATEGORY_.*)$/;
const PAGE_MAX = 500;

export class ApiError extends Error {
  constructor(msg, detail) { super(msg); this.name = "ApiError"; this.detail = detail; }
}
export const TIMEOUTS = { page: 30000, batch: 60000, perMB: 10000, raw: 120000 };
export class Timeout extends Error {
  constructor(what, ms) { super(`Gmail did not answer within ${Math.round(ms / 1000)} s (${what})`); this.name = "Timeout"; }
}

export const PROVIDER = {
  id: "gmail", name: "Gmail",
  signIn: { text: "Sign in with your Google account to read and write your Gmail here. The permission can be withdrawn at any time in your Google account's security settings.", link: null, button: "Sign in with Google" },
};
// Gmail's API returns the sender's own HTML, so remote images load straight from their hosts.
export const IMAGE_SRC = "https:";
// messageBytes: Gmail's send limit for attachments; scanMax: rows per folder a full address-book
// scan reads, since every row costs API quota.
export const LIMITS = { messageBytes: 25 * 1048576, scanMax: 2000 };

// An image still addressed as cid: (a part that could not be inlined) could not load for anyone.
export const isStrayImage = src => /^cid:/i.test(String(src || "").trim());

export const isMessageId = id => (typeof id === "string" || typeof id === "number") && /^[A-Za-z0-9_-]{1,64}$/.test(String(id));
function checkIds(ids) {
  const bad = ids.find(id => !isMessageId(id));
  if (bad !== undefined) throw new ApiError(`refusing malformed id ${JSON.stringify(String(bad).slice(0, 40))}`);
}
export const isGone = e => e instanceof ApiError && e.detail?.status === 404;

// Every folder with a string id, a name and a types list, whatever shape was given.
export function normalizeFolders(list) {
  return (Array.isArray(list) ? list : []).filter(f => f && f.id != null).map(f => ({
    ...f, id: String(f.id), name: typeof f.name === "string" && f.name ? f.name : `Folder ${f.id}`,
    types: Array.isArray(f.types) ? f.types.filter(t => typeof t === "string") : [],
  }));
}

// ---------- queries ----------
const bareAddress = email => String(email).replace(/["()\\\s]/g, "");
// A query() string that names labels as well as a search: query() reads it back.
const OPAQUE = "\u0000";
const opaque = o => OPAQUE + JSON.stringify(o);
export const queries = {
  starred: (unreadOnly = false) => `is:starred${unreadOnly ? " is:unread" : ""}`,
  unreadIn: folderId => opaque({ labelIds: folderId === ALL ? [] : [String(folderId)], q: "is:unread" }),
  person: email => { const e = bareAddress(email); return `(from:${e} OR to:${e} OR cc:${e})`; },
};

// ---------- search terms ----------
// Gmail's search takes any boolean query, so the whole parsed search is written out (compile);
// atom writes one term, and refuses a value its field does not know.
const quoted = v => /[\s:()]/.test(v) ? `"${v}"` : v;
function atom(term, neg = false) {
  const v = clean(term.value), lv = v.toLowerCase(), n = neg ? "-" : "";
  switch (term.field) {
    case null: return `${n}${quoted(v)}`;
    case "from": case "to": case "subject": return `${n}${term.field}:${quoted(v)}`;
    case "has":
      if (/^attachments?$/.test(lv)) return `${n}has:attachment`;
      throw new Error(`has:${v} is not a search term; has:attachment is`);
    case "is":
      if (lv === "starred" || lv === "flagged") return `${n}is:starred`;
      if (lv === "unread") return neg ? "is:read" : "is:unread";
      if (lv === "read") return neg ? "is:unread" : "is:read";
      throw new Error(`is:${v} is not a search term; is:starred, is:unread and is:read are`);
    case "after": case "before": {
      const d = isoDate(v);
      if (!d) throw new Error(`${term.field}:${v} is not a date; write it as YYYY-MM-DD`);
      const f = (term.field === "after") !== neg ? "after" : "before";
      return `${f}:${d.replaceAll("-", "/")}`;
    }
  }
  return null;
}
// within: the operator of the group around this node ("and", "or" or null at the top); a group
// is bracketed only where its own operator differs from that.
function compile(node, neg = false, within = null) {
  if (!node) return "";
  if (node.t === "term") return atom(node, neg);
  if (node.t === "not") return compile(node.kid, !neg, within);
  const op = (node.t === "and") !== neg ? "and" : "or";
  const parts = node.kids.map(k => compile(k, neg, op)).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const s = parts.join(op === "and" ? " " : " OR ");
  return within && within !== op ? `(${s})` : s;
}
export const dialect = { atom, compile: ast => compile(ast) };

// ---------- sign-in ----------
let session = null;
export async function bootstrap(force = false) {
  const t = await getToken({ force });
  session = { email: t.email, at: Date.now() };
  return session;
}
export async function signIn() {
  const t = await getToken({ interactive: true });
  session = { email: t.email, at: Date.now() };
  return session;
}
// Ends the sign-in at Google, then forgets everything learnt about the mailbox.
export async function signOut() {
  await revoke();
  session = null; historyId = null; profileCache = null; labelList = []; draftsLoadedAt = 0;
  for (const m of [modseq, lastCounts, knownCounts, labelName, labelsOf, rowCache, draftOf, knownDrafts, cursors, partRefs, bytesCache, thumbCache, inlineCache, originals]) m.clear();
}

// ---------- transport ----------
async function timed(what, url, init, ms, read) {
  const signal = AbortSignal.timeout(ms);
  try {
    const resp = await fetch(url, { ...init, signal });
    return { resp, body: await read(resp) };
  } catch (e) { throw signal.aborted && e.name === "TimeoutError" ? new Timeout(what, ms) : e; }
}

// Quota: a Google Cloud project gives each user 6,000 units a minute by default (Gmail's documents
// say 15,000; a project gets what its quota page shows). Every call is paced under a sliding
// minute: what the user does may use up to FOREGROUND, background work (the address-book build)
// only up to BACKGROUND, so it never takes the room browsing needs.
const FOREGROUND = 5500, BACKGROUND = 2500;
const spent = [];            // [time, units] of the calls of the last minute, oldest first
let blockedUntil = 0;        // Gmail refused for quota: nothing goes before its minute is over
async function quota(units, cap = FOREGROUND) {
  for (;;) {
    const now = Date.now();
    if (now < blockedUntil) { await sleep(blockedUntil - now); continue; }
    while (spent.length && now - spent[0][0] >= 60000) spent.shift();
    const used = spent.reduce((n, s) => n + s[1], 0);
    if (!spent.length || used + units <= cap) { spent.push([now, units]); return; }
    // wait until enough of the oldest spending is a minute old
    let over = used + units - cap, at = now;
    for (const [t, u] of spent) { at = t; over -= u; if (over <= 0) break; }
    await sleep(at + 60000 - now + 50);
  }
}
// A refusal for quota names the minute it counted in (ErrorInfo window_start_time, in seconds):
// how long until that minute is over, or 0 for a refusal that does not say.
function quotaWait(doc) {
  const info = (doc?.error?.details || []).find(d => d?.metadata?.window_start_time);
  if (!info) return 0;
  return Math.min(61000, Math.max(1000, (Number(info.metadata.window_start_time) + 60) * 1000 - Date.now() + 500));
}
// The pause before asking again after a refusal. A quota refusal holds every call until Gmail's
// minute is over (quota() waits for it); anything else waits Retry-After or a growing backoff.
function pauseFor(resp, doc, left) {
  const w = quotaWait(doc);
  if (w) { blockedUntil = Math.max(blockedUntil, Date.now() + w); spent.length = 0; return 0; }
  return Number(resp?.headers.get("retry-after")) * 1000 || backoff(left);
}

const RETRIABLE = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const reasonOf = doc => doc?.error?.errors?.[0]?.reason || doc?.error?.status || "";
// Rate limits (429, or a 403 that says so) and server errors pass; they are asked again.
const retriable = (status, doc) => RETRIABLE.has(status) || (status === 403 && /rateLimit|userRateLimit/i.test(reasonOf(doc)));
const backoff = left => Math.min(8000, 500 * 2 ** (3 - left)) + Math.random() * 300;
// URL parameters; a list (labelIds) is repeated, as Gmail reads it; null and undefined are left out.
function addQuery(url, query) {
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
}
// One call to Gmail. json: a JSON body; body: raw bytes with their content type; query: URL
// parameters (null and undefined left out). A 401 gets one silent token renewal; rate limits and
// server errors a few retries. units: its quota cost; cap: the pace it keeps (BACKGROUND for
// background work). Returns the parsed JSON (null for an empty answer).
async function call(method, path, opts = {}, tries = { auth: true, again: 3 }) {
  const { query = null, json = null, body = null, type = null, base = API, timeout = TIMEOUTS.batch, units = 1, cap = FOREGROUND } = opts;
  await quota(units, cap);
  const t = await getToken();
  const url = new URL(base + path);
  addQuery(url, query);
  const headers = { Authorization: `Bearer ${t.access_token}` };
  let payload;
  if (json != null) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(json); }
  else if (body != null) { headers["Content-Type"] = type; payload = body; }
  const what = `${method} ${path}`;
  const { resp, body: text } = await timed(what, url, { method, headers, body: payload }, timeout, r => r.text());
  if (resp.status === 401 && tries.auth) { await forget(); await getToken({ force: true }); return call(method, path, opts, { ...tries, auth: false }); }
  if (resp.status === 401) { await forget(); throw new NotSignedIn(); }
  let doc = null;
  if (text) { try { doc = JSON.parse(text); } catch { doc = null; } }
  const reason = reasonOf(doc);
  if (retriable(resp.status, doc) && tries.again > 0) {
    await sleep(pauseFor(resp, doc, tries.again));
    return call(method, path, opts, { ...tries, again: tries.again - 1 });
  }
  if (resp.status === 403 && reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") { await forget(); throw new NotSignedIn("the sign-in lacks the needed permission; sign in again"); }
  if (!resp.ok) throw new ApiError(`${what}: HTTP ${resp.status} ${String(doc?.error?.message || text).slice(0, 160)}`, { status: resp.status, error: doc?.error || text.slice(0, 300) });
  // Gmail leaves empty fields out, so an answer with nothing to say (a list with no entries under
  // a fields mask, a 204) has no body at all: an empty object, read like any other answer.
  return doc ?? {};
}

// Several calls in one HTTP round trip (multipart/mixed). reqs: [{ method, path, query, json }];
// returns [{ status, json }] in the same order. Gmail caps a batch at 100 and rate-limits big
// ones, so 50 go at a time. Gmail may refuse single items of a batch that itself succeeds (rate
// limits, server errors): those are asked again, after a pause, in a batch of their own.
const BATCH_SIZE = 50, ITEM_TRIES = 3;
async function batch(reqs, units = 5, cap = FOREGROUND) {
  const out = new Array(reqs.length);
  let todo = reqs.map((r, i) => i);
  for (let left = ITEM_TRIES; ; left--) {
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const idx = todo.slice(i, i + BATCH_SIZE);
      const got = await batchOnce(idx.map(k => reqs[k]), units, cap);
      idx.forEach((k, j) => { out[k] = got[j]; });
    }
    todo = todo.filter(k => out[k].status === 0 || retriable(out[k].status, out[k].json));
    if (!todo.length || left === 0) return out;
    await sleep(Math.max(...todo.map(k => pauseFor(null, out[k].json, left))));
  }
}
async function batchOnce(reqs, units, cap, tries = { auth: true, again: 3 }) {
  if (!reqs.length) return [];
  await quota(units * reqs.length, cap);
  const t = await getToken();
  const boundary = `batch_${crypto.randomUUID()}`;
  const body = encodeBatch(reqs, boundary);
  const { resp, body: text } = await timed("batch", BATCH_URL, { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` }, body }, TIMEOUTS.batch, r => r.text());
  if (resp.status === 401 && tries.auth) { await forget(); await getToken({ force: true }); return batchOnce(reqs, units, cap, { ...tries, auth: false }); }
  if (resp.status === 401) { await forget(); throw new NotSignedIn(); }
  if (!resp.ok && tries.again > 0) {
    let doc = null; try { doc = JSON.parse(text); } catch { doc = null; }
    if (retriable(resp.status, doc)) { await sleep(pauseFor(resp, doc, tries.again)); return batchOnce(reqs, units, cap, { ...tries, again: tries.again - 1 }); }
  }
  if (!resp.ok) throw new ApiError(`batch: HTTP ${resp.status} ${text.slice(0, 160)}`, { status: resp.status, error: text.slice(0, 300) });
  const m = (resp.headers.get("content-type") || "").match(/boundary="?([^";]+)"?/);
  if (!m) throw new ApiError("batch: no boundary in the answer", text.slice(0, 300));
  return decodeBatch(text, m[1], reqs.length);
}
export function encodeBatch(reqs, boundary) {
  return reqs.map((r, i) => {
    const url = new URL(API + r.path);
    addQuery(url, r.query);
    const head = `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\n${r.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    return r.json != null ? `${head}Content-Type: application/json\r\n\r\n${JSON.stringify(r.json)}\r\n` : `${head}\r\n`;
  }).join("") + `--${boundary}--\r\n`;
}
// The answers come back as parts in request order, each naming its item in Content-ID.
export function decodeBatch(text, boundary, n) {
  const out = Array.from({ length: n }, () => ({ status: 0, json: null }));
  const parts = text.split(`--${boundary}`).slice(1, -1);
  parts.forEach((p, i) => {
    const id = Number((p.match(/Content-ID:\s*<response-item(\d+)>/i) || [])[1] ?? i);
    const http = p.slice(p.search(/\r?\n\r?\n/)).replace(/^\r?\n\r?\n/, "");
    const status = Number((http.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || 0);
    const bodyAt = http.search(/\r?\n\r?\n/);
    const body = bodyAt < 0 ? "" : http.slice(bodyAt).trim();
    let json = null; if (body) { try { json = JSON.parse(body); } catch { json = null; } }
    if (id >= 0 && id < n) out[id] = { status, json };
  });
  return out;
}

// ---------- folders (labels) ----------
const labelName = new Map();       // label id -> name shown as the folder's path
const labelsOf = new Map();        // message id -> its labelIds, from every row and body seen
let labelList = [];                // the last labels.list answer
let profileCache = null;

async function profile() {
  profileCache = await call("GET", "/profile");
  return profileCache;
}

// Changes since the last look, as Gmail's history reports them: each label named in a record
// gets a new stamp, which the client compares as a folder's highestModSeq. A history Gmail no
// longer has (404) stamps every folder once.
let historyId = null;
const modseq = new Map();
const lastCounts = new Map();       // label id -> "total/unread" last reported, to notice a change
const knownCounts = new Map();      // label id -> the last counts Gmail answered
async function noteHistory(ids, current) {
  const stampAll = h => { for (const id of ids) modseq.set(id, `${h}:all`); };
  if (!historyId) { historyId = current; stampAll(historyId); return; }
  try {
    const dirty = new Set();
    let token = null, latest = historyId;
    do {
      const r = await call("GET", "/history", { query: { startHistoryId: historyId, maxResults: PAGE_MAX, pageToken: token }, units: 2 });
      for (const h of r.history || []) {
        for (const k of ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) for (const x of h[k] || []) {
          for (const l of x.message?.labelIds || []) dirty.add(l);
          for (const l of x.labelIds || []) dirty.add(l);
          if (x.message?.id && x.message.labelIds) labelsOf.set(x.message.id, x.message.labelIds);
          if (k === "messagesDeleted" && x.message?.id) { rowCache.delete(x.message.id); labelsOf.delete(x.message.id); }
        }
        dirty.add(ALL);
      }
      if (r.historyId) latest = r.historyId;
      token = r.nextPageToken || null;
    } while (token);
    for (const l of dirty) modseq.set(l, latest);
    historyId = latest;
  } catch (e) {
    if (!isGone(e)) throw e;
    // what changed meanwhile is not known, so no kept labels or rows are trusted
    historyId = current;
    stampAll(historyId);
    rowCache.clear(); labelsOf.clear();
  }
}

export async function folders() {
  const t0 = performance.now();
  const [r, p] = await Promise.all([call("GET", "/labels"), profile()]);
  labelList = r.labels || [];
  labelName.clear();
  const shown = [];
  for (const l of labelList) {
    if (l.type === "system") { if (SYSTEM[l.id]) { labelName.set(l.id, SYSTEM[l.id][1]); shown.push(l); } continue; }
    labelName.set(l.id, l.name);
    shown.push(l);
  }
  const counts = await batch(shown.map(l => ({ method: "GET", path: `/labels/${l.id}`, query: { fields: "id,messagesTotal,messagesUnread" } })), 1);
  const ids = [...shown.map(l => l.id), ALL];
  await noteHistory(ids, p.historyId);
  const list = shown.map((l, i) => {
    // a label whose counts did not come keeps the ones it had, which is no change
    const got = counts[i].status === 200 && counts[i].json;
    if (got) knownCounts.set(l.id, got);
    const c = knownCounts.get(l.id) || {};
    const key = `${c.messagesTotal}/${c.messagesUnread}`;
    if (got && lastCounts.get(l.id) !== key) { lastCounts.set(l.id, key); modseq.set(l.id, `${modseq.get(l.id) || 0}+${key}`); }
    const types = l.type === "system" ? [SYSTEM[l.id][0]] : l.labelListVisibility === "labelHide" ? ["USER", "INVISIBLE"] : ["USER"];
    return { id: l.id, name: labelName.get(l.id), types, unread: c.messagesUnread || 0, total: c.messagesTotal || 0, highestModSeq: modseq.get(l.id) || 0, acctId: "1" };
  });
  labelName.set(ALL, "All Mail");
  list.push({ id: ALL, name: "All Mail", types: ["ARCHIVE"], unread: 0, total: p.messagesTotal || 0, highestModSeq: modseq.get(ALL) || 0, acctId: "1" });
  return { folders: normalizeFolders(list), accounts: [], ms: Math.round(performance.now() - t0) };
}

// How many messages are starred: the count Gmail keeps for its STARRED label, one unit, where a
// search would fetch every starred message.
export async function starredCount() {
  const r = await call("GET", "/labels/STARRED", { query: { fields: "messagesTotal" } });
  return r?.messagesTotal || 0;
}

const LABEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
function checkLabel(id) { if (!LABEL_ID.test(String(id)) || id === ALL) throw new ApiError(`refusing malformed folder id ${JSON.stringify(String(id).slice(0, 20))}`); }
const isSpamOrTrash = id => id === "SPAM" || id === "TRASH";

export async function createFolder(name) {
  const t0 = performance.now();
  const result = await call("POST", "/labels", { json: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
  return { result, ms: Math.round(performance.now() - t0) };
}
// A rename sets the folder's whole path, so it also moves it. Gmail does not rename the labels
// nested under it, so each of them is renamed as well.
export async function renameFolder(id, name) {
  checkLabel(id);
  const t0 = performance.now();
  const old = labelName.get(id) || labelList.find(l => l.id === id)?.name || "";
  const result = await call("PATCH", `/labels/${id}`, { json: { name } });
  if (old) for (const l of labelList) if (l.type !== "system" && l.name.startsWith(old + "/")) await call("PATCH", `/labels/${l.id}`, { json: { name: name + l.name.slice(old.length) } });
  return { result, ms: Math.round(performance.now() - t0) };
}
export async function deleteFolder(id) {
  checkLabel(id);
  const t0 = performance.now();
  await call("DELETE", `/labels/${id}`);
  return { result: null, ms: Math.round(performance.now() - t0) };
}
// Every id in a label, a page at a time; forEach may change the label, so each page is asked for afresh.
async function eachPage(params, fn) {
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const r = await call("GET", "/messages", { query: { ...params, maxResults: PAGE_MAX }, units: 5 });
    const ids = (r.messages || []).map(m => m.id);
    if (!ids.length) return n;
    await fn(ids);
    n += ids.length;
    if (!r.nextPageToken) return n;
  }
  return n;
}
// Every message in a folder, permanently deleted.
export async function emptyFolder(id) {
  checkLabel(id);
  const t0 = performance.now();
  const n = await eachPage({ labelIds: id, includeSpamTrash: true }, ids => call("POST", "/messages/batchDelete", { json: { ids }, units: 50 }));
  for (const [m, l] of labelsOf) if (l.includes(id)) { labelsOf.delete(m); rowCache.delete(m); }
  return { result: null, changed: n, ms: Math.round(performance.now() - t0) };
}
export async function markFolderRead(id) {
  const t0 = performance.now();
  const params = id === ALL ? { q: "is:unread" } : { labelIds: [id, "UNREAD"], ...(isSpamOrTrash(id) ? { includeSpamTrash: true } : {}) };
  const n = await eachPage(params, ids => call("POST", "/messages/batchModify", { json: { ids, removeLabelIds: ["UNREAD"] }, units: 50 }));
  return { result: null, changed: n, ms: Math.round(performance.now() - t0) };
}

// ---------- rows ----------
const headerMap = list => { const h = {}; for (const x of list || []) { const k = String(x.name || "").toLowerCase(); if (!(k in h)) h[k] = x.value || ""; } return h; };
const partHeader = (p, name) => (p.headers || []).find(h => String(h.name).toLowerCase() === name)?.value || "";
const contentIdOf = p => partHeader(p, "content-id").replace(/^\s*<|>\s*$/g, "").trim();
// The leaves of a payload tree, depth first, each with Gmail's own partId.
function leaves(payload, out = []) {
  if (!payload) return out;
  if (payload.parts?.length) { for (const p of payload.parts) leaves(p, out); return out; }
  out.push(payload);
  return out;
}
const isFile = p => !!(p.filename || contentIdOf(p));
// A part is inline only when the text shows it: its Content-ID is a cid: source in the HTML.
// Content-Disposition does not decide it, since some mailers mark every attachment inline.
const dispositionOf = (p, html) => contentIdOf(p) && html.toLowerCase().includes(`cid:${contentIdOf(p).toLowerCase()}`) ? "inline" : "attachment";
// A row has no HTML to look in; there a Content-ID part inside multipart/related (the text's own
// images) counts as inline.
function rowFiles(node, related = false, out = []) {
  if (!node) return out;
  if (node.parts?.length) {
    const r = related || /^multipart\/related$/i.test(node.mimeType || "");
    for (const p of node.parts) rowFiles(p, r, out);
  } else if (isFile(node)) out.push({ disposition: related && contentIdOf(node) ? "inline" : "attachment", filename: node.filename || "" });
  return out;
}

// The folder a message is shown in: the listed label, else Trash, Spam, Drafts, Inbox, its first
// user label, Sent, and All Mail for a message with none of those.
function folderOf(labelIds = [], listed = null) {
  const has = l => labelIds.includes(l);
  const id = listed && (listed === ALL || has(listed)) ? listed
    : has("TRASH") ? "TRASH" : has("SPAM") ? "SPAM" : has("DRAFT") ? "DRAFT" : has("INBOX") ? "INBOX"
    : labelIds.find(l => labelName.has(l) && !SYSTEM[l] && !HIDDEN.test(l)) || (has("SENT") ? "SENT" : ALL);
  return { id, name: labelName.get(id) || id };
}

const ROW_FIELDS = "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(mimeType,filename,headers,parts(partId,mimeType,filename,headers,body/size,parts(partId,mimeType,filename,headers,body/size,parts(partId,mimeType,filename,headers,body/size))))";
function toRow(m, listed = null) {
  const h = headerMap(m.payload?.headers);
  const labels = m.labelIds || [];
  labelsOf.set(m.id, labels);
  const files = rowFiles(m.payload);
  return {
    id: m.id, immutableid: m.id, threadId: m.threadId, size: m.sizeEstimate || 0, labelIds: labels, snippet: m.snippet || "",
    flags: { read: !labels.includes("UNREAD"), flagged: labels.includes("STARRED") },
    attachments: files, attachmentCount: files.filter(a => a.disposition !== "inline").length,
    folder: folderOf(labels, listed),
    headers: {
      subject: h.subject || "", from: parseAddresses(h.from), to: parseAddresses(h.to), cc: parseAddresses(h.cc), bcc: parseAddresses(h.bcc), replyTo: parseAddresses(h["reply-to"]),
      date: String(Math.floor(Number(m.internalDate || 0) / 1000)), mimeType: m.payload?.mimeType || "",
      messageId: messageIdOf(h["message-id"]), inReplyTo: messageIdOf(h["in-reply-to"]), references: h.references || "",
    },
  };
}

// Rows for ids, in the order given; a message gone meanwhile (404) is left out. Any other failure
// fails the list, since a row left out would end the paging early.
// A message's headers and parts never change (a draft saved again is a new message), so each row
// is fetched once and kept; its labels, which do change, come from labelsOf, which every change
// made here and every change Gmail's history reports keeps current. A refresh, or a folder opened
// again, then fetches only the messages it has not seen.
const rowCache = new Map();        // message id -> the message as Gmail answered it for a row
const ROW_CACHE = 5000;
async function rows(ids, listed = null, cap = FOREGROUND) {
  const need = ids.filter(id => !rowCache.has(id));
  const got = need.length ? await batch(need.map(id => ({ method: "GET", path: `/messages/${id}`, query: { format: "full", fields: ROW_FIELDS } })), 5, cap) : [];
  const bad = got.findIndex(r => r.status !== 404 && !(r.status === 200 && r.json));
  if (bad >= 0) throw new ApiError(`GET /messages/${need[bad]}: HTTP ${got[bad].status} ${String(got[bad].json?.error?.message || "").slice(0, 160)}`, { status: got[bad].status, error: got[bad].json?.error || null });
  got.forEach((r, i) => { if (r.status === 200) { remember(rowCache, need[i], r.json, ROW_CACHE); labelsOf.set(need[i], r.json.labelIds || []); } });
  const out = ids.filter(id => rowCache.has(id)).map(id => { const m = rowCache.get(id); return toRow({ ...m, labelIds: labelsOf.get(id) || m.labelIds }, listed); });
  if (out.some(m => m.labelIds.includes("DRAFT"))) { await loadDrafts(false); for (const m of out) if (m.labelIds.includes("DRAFT")) m.csid = draftOf.get(m.id) || undefined; }
  return out;
}

// Listing pages with tokens; the client asks by offset in order, so each query keeps the token of
// where its last page ended, and any other offset is walked to from the start (ids only).
const cursors = new Map();
// Background work keeps cursors of its own, so it does not move the ones the user pages with.
async function listIds(params, count, offset, cap = FOREGROUND) {
  const key = JSON.stringify([params, cap]);
  let cur = cursors.get(key);
  if (offset === 0 || !cur || cur.nextOffset !== offset) {
    cur = { nextOffset: 0, token: null };
    while (cur.nextOffset < offset) {
      const r = await call("GET", "/messages", { query: { ...params, maxResults: Math.min(PAGE_MAX, offset - cur.nextOffset), pageToken: cur.token }, units: 5, cap });
      cur.nextOffset += (r.messages || []).length;
      cur.token = r.nextPageToken || null;
      if (!r.nextPageToken) break;
    }
    if (cur.nextOffset < offset) { cursors.set(key, cur); return { ids: [], estimate: 0 }; }
  }
  // Gmail answers at most 500 ids a page; a longer list (a refresh of many loaded rows) takes several
  const want = Math.max(1, count), ids = [];
  let token = cur.token, estimate = 0;
  do {
    const r = await call("GET", "/messages", { query: { ...params, maxResults: Math.min(PAGE_MAX, want - ids.length), pageToken: token }, units: 5, cap });
    ids.push(...(r.messages || []).map(m => m.id));
    token = r.nextPageToken || null;
    estimate = r.resultSizeEstimate || estimate;
  } while (token && ids.length < want);
  cursors.set(key, { nextOffset: offset + ids.length, token });
  return { ids, estimate };
}
const listParams = ({ labelIds = [], q = "", includeSpamTrash = false }) => ({ ...(labelIds.length ? { labelIds } : {}), ...(q ? { q } : {}), ...(includeSpamTrash || labelIds.some(isSpamOrTrash) ? { includeSpamTrash: true } : {}) });

async function listRows(spec, count, offset, listed = null, cap = FOREGROUND) {
  const t0 = performance.now();
  const { ids } = await listIds(listParams(spec), count, offset, cap);
  const messages = await rows(ids, listed, cap);
  return { messages, query: {}, ms: Math.round(performance.now() - t0) };
}

// background: work the user is not waiting for (the address-book build), paced to leave room.
export function list(folderId, count = 100, offset = 0, { background = false } = {}) {
  const id = String(folderId);
  return listRows({ labelIds: id === ALL ? [] : [id] }, count, offset, id, background ? BACKGROUND : FOREGROUND);
}

// raw: term is already in Gmail's search language; otherwise words to find.
export function search(term, folderId = null, count = 100, offset = 0, raw = false) {
  const q = raw ? term : String(term || "").trim();
  return listRows({ labelIds: folderId && folderId !== ALL ? [String(folderId)] : [], q }, count, offset, folderId ? String(folderId) : null);
}

// Search limited to a scope or to everything outside it. scope: { ids: [folderId...] } for a
// folder and its subfolders, or { starred: true }. Returns what searchScoped() reads back.
export function scopeFilter({ include = null, exclude = null } = {}) { return { include, exclude }; }

// A label named in a query, as Gmail's search writes it: in quotes, spaces as hyphens.
const labelTerm = id => `label:"${(labelName.get(id) || id).replace(/"/g, "").replace(/ /g, "-")}"`;
export async function searchScoped(term, { raw = null, include = null, exclude = null } = {}, count = 100, offset = 0) {
  let q = raw || String(term || "").trim();
  if (include?.starred) return listRows({ q: `is:starred ${q}` }, count, offset);
  if (include?.ids?.length) {
    const ids = include.ids.map(String);
    if (ids.length === 1) return listRows({ labelIds: ids[0] === ALL ? [] : ids, q }, count, offset, ids[0]);
    // a folder with its subfolders: any of their labels, through the search itself
    return listRows({ q: `(${ids.map(labelTerm).join(" OR ")}) ${q}`, includeSpamTrash: ids.some(isSpamOrTrash) }, count, offset);
  }
  if (exclude?.starred) q = `-is:starred ${q}`;
  const ids = (exclude?.ids || []).map(String).filter(id => id !== ALL);
  if (ids.length) q = `${ids.map(id => `-${labelTerm(id)}`).join(" ")} ${q}`;
  const r = await listRows({ q }, count, offset);
  // what the search still answered with one of those labels stays out
  r.messages = r.messages.filter(m => !ids.some(id => m.labelIds.includes(id)));
  return r;
}

// One query in Gmail's search language, or an opaque label query from queries.*.
export function query(qs, count = 100, offset = 0) {
  if (String(qs).startsWith(OPAQUE)) { const o = JSON.parse(qs.slice(1)); return listRows({ labelIds: o.labelIds || [], q: o.q || "" }, count, offset, o.labelIds?.[0] || null); }
  return listRows({ q: qs }, count, offset);
}

// ---------- body, parts ----------
const fromB64url = s => { const b = atob(String(s || "").replace(/-/g, "+").replace(/_/g, "/")); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };
const charsetOf = p => (partHeader(p, "content-type").match(/charset="?([^";\s]+)"?/i) || [])[1] || "utf-8";
function decodeText(p, bytes) {
  let dec; try { dec = new TextDecoder(charsetOf(p)); } catch { dec = new TextDecoder(); }
  return dec.decode(bytes);
}
// Plain text as HTML: escaped, links made clickable, line breaks kept.
const textAsHtml = t => `<div style="white-space:pre-wrap">${esc(t).replace(/\bhttps?:\/\/[^\s<>"']+/g, u => `<a href="${u}">${u}</a>`)}</div>`;
const partKey = (msgId, partId) => `${msgId}/${partId}`;
const partRefs = new Map();        // msgId/partId -> { attachmentId, data, type, filename }
const BODY_FIELDS = "id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload";

// The parts that make up the text a reader shows, in order: an alternative gives its preferred
// branch (HTML when html, else plain text), related its root, and any other multipart every text
// part it holds, so text after an attachment is shown too. Named parts and attachments are files.
function textParts(node, html) {
  if (!node || node.filename) return [];
  const type = String(node.mimeType || "").toLowerCase();
  if (node.parts?.length) {
    if (type === "multipart/alternative") {
      const kind = html ? "text/html" : "text/plain";
      const branches = node.parts.map(k => textParts(k, html)).filter(b => b.length).reverse();
      return branches.find(b => b.some(p => p.mimeType === kind)) || branches[0] || [];
    }
    if (type === "multipart/related") return textParts(node.parts[0], html);
    return node.parts.flatMap(k => textParts(k, html));
  }
  if ((type !== "text/plain" && type !== "text/html") || /^\s*attachment/i.test(partHeader(node, "content-disposition"))) return [];
  return [node];
}
async function partData(msgId, p) {
  if (p.body?.data != null) return fromB64url(p.body.data);
  if (!p.body?.attachmentId) return new Uint8Array(0);
  return fromB64url((await call("GET", `/messages/${msgId}/attachments/${p.body.attachmentId}`, { timeout: TIMEOUTS.raw, units: 5 })).data);
}

export async function body(msgId) {
  checkIds([msgId]);
  const t0 = performance.now();
  const m = await call("GET", `/messages/${msgId}`, { query: { format: "full", fields: BODY_FIELDS }, units: 5 });
  const parts = leaves(m.payload);
  for (const p of parts) if (p.partId != null) partRefs.set(partKey(msgId, p.partId), { attachmentId: p.body?.attachmentId, data: p.body?.size <= 1 << 20 ? p.body?.data : undefined, type: p.mimeType, filename: p.filename || "" });
  const forHtml = textParts(m.payload, true), forText = textParts(m.payload, false);
  const decoded = new Map();
  for (const p of new Set([...forHtml, ...forText])) decoded.set(p, decodeText(p, await partData(msgId, p)));
  const text = forText.filter(p => p.mimeType === "text/plain").map(p => decoded.get(p)).join("\n");
  const html = forHtml.map(p => p.mimeType === "text/html" ? decoded.get(p) : textAsHtml(decoded.get(p))).join("\n");
  const attachments = parts.filter(p => !decoded.has(p) && (isFile(p) || p.body?.attachmentId)).map(p => {
    const [type, subtype] = String(p.mimeType || "application/octet-stream").split("/");
    return { partId: String(p.partId), filename: p.filename || "", size: p.body?.size || 0, type, subtype: subtype || "", contentId: contentIdOf(p) || undefined, disposition: dispositionOf(p, html) };
  });
  const message = toRow({ ...m, payload: { ...m.payload } });
  message.attachments = attachments.map(a => ({ disposition: a.disposition, filename: a.filename }));
  if (message.labelIds.includes("DRAFT")) {
    await loadDrafts(!draftOf.has(msgId));
    message.csid = draftOf.get(msgId) || undefined;
    const ref = message.headers.inReplyTo;
    if (ref) {
      const r = await call("GET", "/messages", { query: { q: `rfc822msgid:${ref}`, maxResults: 1, includeSpamTrash: true }, units: 5 }).catch(() => null);
      const orig = r?.messages?.[0]?.id;
      const fwd = /^\s*fwd?:/i.test(message.headers.subject);
      if (orig) message.inReplyTo = { messageReference: { id: orig }, replied: !fwd, forwarded: fwd };
    }
  }
  return { message, html, text, attachments, ms: Math.round(performance.now() - t0) };
}

// { bytes, type, filename } of one attachment: Gmail's attachments.get by the part's attachment
// id, which body() noted; a part not seen yet is looked up first. The newest parts stay cached.
const bytesCache = new Map();
export async function partBytes(msgId, a) {
  checkIds([msgId]);
  const key = partKey(msgId, a.partId);
  if (bytesCache.has(key)) return bytesCache.get(key);
  let ref = partRefs.get(key);
  if (!ref) {
    const m = await call("GET", `/messages/${msgId}`, { query: { format: "full", fields: "payload" }, units: 5 });
    for (const p of leaves(m.payload)) if (p.partId != null) partRefs.set(partKey(msgId, p.partId), { attachmentId: p.body?.attachmentId, data: p.body?.data, type: p.mimeType, filename: p.filename || "" });
    ref = partRefs.get(key) || [...partRefs.entries()].find(([k, v]) => k.startsWith(msgId + "/") && a.filename && v.filename === a.filename)?.[1];
    if (!ref) throw new ApiError("attachment not found in the message");
  }
  const bytes = ref.data != null ? fromB64url(ref.data) : await partData(msgId, { body: { attachmentId: ref.attachmentId } });
  const out = { bytes, type: ref.type, filename: ref.filename };
  remember(bytesCache, key, out, 20);
  return out;
}

// Gmail has no download link of its own; the viewer saves the fetched bytes instead.
export const originalUrl = () => null;

const toDataUrl = (bytes, type) => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(new Blob([bytes], { type })); });

// A thumbnail of an image attachment: the image itself, when it is small enough to fetch for that.
const THUMB_MAX = 2 * 1048576;
const thumbCache = new Map();
export async function thumbnail(msgId, a) {
  if (!/^image$/i.test(a.type || "") || (a.size || 0) > THUMB_MAX) return null;
  const key = partKey(msgId, a.partId);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const p = partBytes(msgId, a).then(({ bytes }) => { const t = sniffImage(bytes); return t ? toDataUrl(bytes, t) : null; }).catch(() => null);
  remember(thumbCache, key, p, 100);
  return p;
}

// Inline images are cid: references to the message's own parts.
export const isInlineRef = src => /^cid:/i.test(String(src || "").trim());
const inlineCache = new Map();
export async function inlineSource(src, body) {
  const message = body?.message;
  if (!message?.id || !isInlineRef(src)) return null;
  let cid = String(src).trim().slice(4); try { cid = decodeURIComponent(cid); } catch { /* as written */ }
  const a = (body.attachments || []).find(x => x.contentId && x.contentId.toLowerCase() === cid.toLowerCase());
  if (!a) return null;
  const key = partKey(message.id, a.partId);
  if (inlineCache.has(key)) return inlineCache.get(key);
  const p = partBytes(message.id, a).then(({ bytes }) => { const t = sniffImage(bytes); return t ? toDataUrl(bytes, t) : null; }).catch(() => null);
  remember(inlineCache, key, p, 200);
  return p;
}

// ---------- mutations ----------
// Label changes. A few ids go one message each (messages.modify, 5 units, together in one batch),
// each answered on its own, with its labels; more go through batchModify, 50 units for up to a
// thousand, which answers for all of them or for none.
const FEW = 10;
async function modify(ids, add, remove) {
  checkIds(ids);
  const t0 = performance.now();
  if (ids.length <= FEW) {
    const got = await batch(ids.map(id => ({ method: "POST", path: `/messages/${id}/modify`, json: { addLabelIds: add, removeLabelIds: remove } })), 5);
    const ok = ids.filter((id, i) => got[i].status === 200), failed = ids.filter((id, i) => got[i].status !== 200);
    if (!ok.length) { const g = got[0]; throw new ApiError(`modify: HTTP ${g.status} ${String(g.json?.error?.message || "").slice(0, 160)}`, { status: g.status, error: g.json?.error || null }); }
    ids.forEach((id, i) => { if (got[i].status === 200 && got[i].json?.labelIds) labelsOf.set(id, got[i].json.labelIds); });
    return { ms: Math.round(performance.now() - t0), ok, failed };
  }
  for (let i = 0; i < ids.length; i += 1000) await call("POST", "/messages/batchModify", { json: { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove }, units: 50 });
  for (const id of ids) { const l = labelsOf.get(id); if (l) labelsOf.set(id, [...new Set([...l.filter(x => !remove.includes(x)), ...add])]); }
  return { ms: Math.round(performance.now() - t0), ok: ids.slice(), failed: [] };
}
export function setRead(ids, read) { return modify(ids, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []); }
export function setStarred(ids, flagged) { return modify(ids, flagged ? ["STARRED"] : [], flagged ? [] : ["STARRED"]); }

// Label changes for ids, grouped so ids with the same change share one call. changes: id ->
// { add, remove }. Returns the ids changed and the ids that failed.
async function relabel(ids, changes) {
  const groups = new Map();
  for (const id of ids) {
    const c = changes.get(id), key = `${c.add.join(",")}|${c.remove.join(",")}`;
    if (!groups.has(key)) groups.set(key, { ...c, ids: [] });
    groups.get(key).ids.push(id);
  }
  const ok = [], failed = [];
  let error = null;
  for (const g of groups.values()) {
    if (!g.add.length && !g.remove.length) { ok.push(...g.ids); continue; }
    try { const r = await modify(g.ids, g.add, g.remove); ok.push(...r.ok); failed.push(...r.failed); }
    catch (e) { error = e; failed.push(...g.ids); }
  }
  return { ok, failed, error };
}

// A move takes away Inbox, Spam and Trash, and the user label of the folder the message is shown
// in (from: id -> folder id, as the client shows it), and adds the target's label; All Mail adds
// nothing, which is Gmail's archive. Its other user labels stay, as Gmail keeps them, also in
// Trash and Spam, whose messages no label's list shows. The answer's undo() takes back exactly
// what the move changed.
export async function move(ids, folderId, { from = {} } = {}) {
  checkIds(ids);
  const to = String(folderId);
  if (to !== ALL) checkLabel(to);
  const t0 = performance.now();
  const missing = ids.filter(id => !labelsOf.has(id));
  if (missing.length) {
    const got = await batch(missing.map(id => ({ method: "GET", path: `/messages/${id}`, query: { format: "minimal", fields: "id,labelIds" } })));
    got.forEach((r, i) => { if (r.status === 200 && r.json) labelsOf.set(missing[i], r.json.labelIds || []); });
  }
  const isUser = l => labelName.has(l) && !SYSTEM[l] && l !== ALL;
  const keepUser = isSpamOrTrash(to);
  const changes = new Map();
  for (const id of ids) {
    const labels = labelsOf.get(id);
    if (!labels) continue;
    const origin = String(from[id] ?? "");
    const remove = labels.filter(l => l !== to && (FOLDER_LABELS.has(l) || (!keepUser && l === origin && isUser(l)))).sort();
    const add = to !== ALL && !labels.includes(to) ? [to] : [];
    changes.set(id, { add, remove });
  }
  const r = await relabel(ids.filter(id => changes.has(id)), changes);
  const failed = [...ids.filter(id => !changes.has(id)), ...r.failed];
  if (!r.ok.length) throw r.error || new ApiError(`move: all ${ids.length} failed`);
  const back = new Map(r.ok.map(id => [id, { add: changes.get(id).remove, remove: changes.get(id).add }]));
  const undo = async () => {
    const t1 = performance.now();
    const u = await relabel(r.ok, back);
    if (!u.ok.length) throw u.error || new ApiError(`undo: all ${r.ok.length} failed`);
    return { ms: Math.round(performance.now() - t1), ok: u.ok, failed: u.failed };
  };
  return { ms: Math.round(performance.now() - t0), ok: r.ok, failed, undo };
}

// Permanent removal: messages in Trash, and the saved copy of a draft being discarded.
export async function deleteForever(ids) {
  checkIds(ids);
  const t0 = performance.now();
  await loadDrafts(ids.some(id => !draftOf.has(id)));
  const drafts = ids.filter(id => draftOf.has(id)), others = ids.filter(id => !draftOf.has(id));
  const ok = [], failed = [];
  for (const id of drafts) {
    try { await call("DELETE", `/drafts/${draftOf.get(id)}`, { units: 10 }); ok.push(id); knownDrafts.delete(draftOf.get(id)); draftOf.delete(id); }
    catch (e) { if (isGone(e)) ok.push(id); else failed.push(id); }
  }
  if (others.length) {
    try { for (let i = 0; i < others.length; i += 1000) await call("POST", "/messages/batchDelete", { json: { ids: others.slice(i, i + 1000) }, units: 50 }); ok.push(...others); }
    catch (e) { if (!ok.length) throw e; failed.push(...others); }
  }
  for (const id of ok) { labelsOf.delete(id); rowCache.delete(id); }
  if (!ok.length) throw new ApiError(`delete: all ${ids.length} failed`);
  return { ms: Math.round(performance.now() - t0), ok, failed };
}

// ---------- accounts ----------
export async function accounts() {
  const t0 = performance.now();
  const [p, s] = await Promise.all([profile(), call("GET", "/settings/sendAs").catch(() => ({ sendAs: [] }))]);
  let list = (s.sendAs || []).map(a => ({
    email: a.sendAsEmail, sendingName: a.displayName || "", isPrimary: !!a.isPrimary, isSending: a.verificationStatus !== "pending",
    type: a.isPrimary ? "PRIMARY" : "ALIAS", signature: a.signature || "", signatureActive: !!a.signature, replyToAddress: a.replyToAddress || "",
  }));
  if (!list.length) list = [{ email: p.emailAddress, sendingName: "", isPrimary: true, isSending: true, type: "PRIMARY", signature: "", signatureActive: false, replyToAddress: "" }];
  return { accounts: list, ms: Math.round(performance.now() - t0) };
}

// ---------- drafts, send ----------
const draftOf = new Map();         // message id -> draft id
const knownDrafts = new Set();     // draft ids seen, created or listed
let draftsLoadedAt = 0;
async function loadDrafts(force) {
  if (!force && Date.now() - draftsLoadedAt < 10000) return;
  draftsLoadedAt = Date.now();
  let token = null;
  const seen = new Map();
  do {
    const r = await call("GET", "/drafts", { query: { maxResults: PAGE_MAX, pageToken: token, fields: "drafts(id,message/id),nextPageToken" }, units: 5 });
    for (const d of r.drafts || []) if (d.message?.id) { seen.set(d.message.id, d.id); knownDrafts.add(d.id); }
    token = r.nextPageToken || null;
  } while (token);
  draftOf.clear();
  for (const [m, d] of seen) draftOf.set(m, d);
}

// What a reply needs from the original: its thread, and the headers that chain the reply to it.
const originals = new Map();
async function original(id) {
  if (originals.has(id)) return originals.get(id);
  const m = await call("GET", `/messages/${id}`, { query: { format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject"], fields: "id,threadId,payload/headers" }, units: 5 });
  const h = headerMap(m.payload?.headers);
  const o = { threadId: m.threadId, messageId: messageIdOf(h["message-id"]), references: h.references || "", subject: h.subject || "" };
  originals.set(id, o);
  return o;
}
const bareSubject = s => String(s || "").replace(/^(\s*(re|fwd?|fw)\s*:)+/i, "").trim().toLowerCase();

// The raw message for d (see compose.js collect()), with forwarded attachments fetched and
// embedded, and the threading headers of the message it answers.
async function rawFor(d) {
  checkIds([...(d.inReplyTo ? [d.inReplyTo.id] : []), ...(d.refs || []).map(r => r.messageId)]);
  const orig = d.inReplyTo ? await original(d.inReplyTo.id) : null;
  const extra = await Promise.all((d.refs || []).map(async r => { const b = await partBytes(r.messageId, { partId: r.partId, filename: r.filename }); return { name: r.filename || b.filename || "attachment", type: b.type, bytes: b.bytes }; }));
  const raw = await build({
    from: d.from, replyTo: d.replyTo, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.html, text: d.text, inline: d.inline, files: d.files, extra,
    inReplyTo: orig?.messageId || undefined, references: orig ? [orig.references, orig.messageId].filter(Boolean).join(" ") : undefined,
  });
  const threadId = orig && bareSubject(orig.subject) === bareSubject(d.subject) ? orig.threadId : null;
  return { raw, threadId };
}

// Uploads a draft or a send as multipart: the JSON part names the draft and thread, the second
// part is the message itself. A thread Gmail refuses (400) is tried once without.
async function upload(method, path, meta, raw, what) {
  const boundary = `rel_${crypto.randomUUID()}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`;
  const body = new Blob([head, raw, `\r\n--${boundary}--\r\n`]);
  const timeout = TIMEOUTS.batch + Math.ceil(raw.length / 1048576) * TIMEOUTS.perMB;
  try {
    return await call(method, path, { query: { uploadType: "multipart" }, body, type: `multipart/related; boundary=${boundary}`, base: UPLOAD, timeout, units: 10 });
  } catch (e) {
    if (e instanceof ApiError && e.detail?.status === 400 && meta.message?.threadId) return upload(method, path, { ...meta, message: {} }, raw, what);
    if (e instanceof Timeout && what === "send") e.message += "; it may still have been sent, so check Sent before sending it again";
    throw e;
  }
}

// Saves the message to Drafts: a new draft the first time, then the same draft again (its draft
// id is the csid the client keeps). The answer names no stored parts, so the client uploads the
// files again with every save, which keeps the draft whole.
export async function saveDraft(d) {
  const t0 = performance.now();
  const { raw, threadId } = await rawFor(d);
  const meta = { message: threadId ? { threadId } : {} };
  const id = knownDrafts.has(d.csid) ? d.csid : null;
  // a draft deleted or sent elsewhere (404) is saved as a new one
  const r = (id ? await upload("PUT", `/drafts/${id}`, { id, ...meta }, raw, "save").catch(e => { if (!isGone(e)) throw e; dropDraft(id); return null; }) : null)
    || await upload("POST", "/drafts", meta, raw, "save");
  knownDrafts.add(r.id);
  for (const [m, dr] of draftOf) if (dr === r.id) draftOf.delete(m);
  draftOf.set(r.message.id, r.id);
  labelsOf.set(r.message.id, r.message.labelIds || ["DRAFT"]);
  return { message: { id: r.message.id, csid: r.id, attachments: [] }, partial: false, ms: Math.round(performance.now() - t0) };
}

// Sends the message: the draft it was saved as, updated with what is sent now, or a message of
// its own. Gmail files the copy in Sent and removes the draft. The folder for sent mail is Gmail's
// own, so sentFolderId is not needed.
export async function send(d) {
  const t0 = performance.now();
  const { raw, threadId } = await rawFor(d);
  const meta = { message: threadId ? { threadId } : {} };
  const id = knownDrafts.has(d.csid) ? d.csid : null;
  // a draft deleted or sent elsewhere (404) leaves the message to be sent on its own
  const r = (id ? await upload("POST", "/drafts/send", { id, ...meta }, raw, "send").catch(e => { if (!isGone(e)) throw e; return null; }) : null)
    || await upload("POST", "/messages/send", meta.message, raw, "send");
  if (id) dropDraft(id);
  return { message: { id: r.id, csid: d.csid }, ms: Math.round(performance.now() - t0) };
}
function dropDraft(id) {
  knownDrafts.delete(id);
  for (const [m, dr] of draftOf) if (dr === id) draftOf.delete(m);
}
