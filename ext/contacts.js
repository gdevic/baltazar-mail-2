import * as api from "./api.js";
import { noBidi } from "./text.js";

// Address book built from the user's own Inbox and Sent headers, kept in IndexedDB.
// One entry per lowercase address: the display names seen, when mail last went either way, and
// when the user last wrote to it. Nothing is counted; recency is all the ranking needs.

const DB = "baltazar-mail", STORE = "contacts", META = "meta";
let db = null;
let own = new Set();
let cache = null;          // Map email -> entry, loaded once; writes go through to IndexedDB
const SCAN_PAGE = 100;

function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { const d = req.result; d.createObjectStore(STORE, { keyPath: "email" }); d.createObjectStore(META, { keyPath: "key" }); };
    req.onsuccess = () => ok(db = req.result);
    req.onerror = () => no(req.error);
  });
}

const tx = (store, mode, fn) => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(store, mode), s = t.objectStore(store);
  const r = fn(s);
  t.oncomplete = () => ok(r && r.result !== undefined ? r.result : r);
  t.onerror = () => no(t.error);
}));

// Tabs share the store: after a write, the others drop their copy and read it again when next
// needed. Writes merge into what is stored, inside one transaction, so no tab undoes another's.
let bc = null;
function channel() {
  if (!bc && typeof BroadcastChannel !== "undefined") { bc = new BroadcastChannel("baltazar-contacts"); bc.onmessage = () => { cache = null; }; bc.unref?.(); }
  return bc;
}
const changed = () => channel()?.postMessage("changed");
// mutate(stored or undefined, email) -> the row to store, or null to leave it; returns the rows written.
const updateRows = (emails, mutate) => openDb().then(d => new Promise((ok, no) => {
  const t = d.transaction(STORE, "readwrite"), s = t.objectStore(STORE), out = [];
  for (const email of emails) {
    const r = s.get(email);
    r.onsuccess = () => { const row = mutate(r.result, email); if (row) { s.put(row); out.push(row); } };
  }
  t.oncomplete = () => { for (const row of out) cache?.set(row.email, row); changed(); ok(out); };
  t.onerror = () => no(t.error);
}));

async function loadAll() {
  channel();
  if (cache) return cache;
  const rows = await tx(STORE, "readonly", s => s.getAll());
  cache = new Map((rows || []).map(r => [r.email, r]));
  return cache;
}

export function setOwnAddresses(list) { own = new Set(list.map(e => e.toLowerCase())); }

// Machine senders, recognized from the address alone (no network, no headers):
//  1. the local part says noreply anywhere, has an unambiguous machine word anywhere
//     (auto-reply, automated, newsletter, info...), or its first word names a role (news,
//     receipts, support...)
//  2. the local part is a generated token: 20+ characters with 6+ digits (bounce/VERP ids)
//  3. the domain is a bulk-mail subdomain (email.x.com, t.x.com, appmail.x.com), a sending
//     domain (x-mail.com, infos-x.com, xemail.com) or under the .email TLD
// Only applied to addresses never written to, so a wrong guess costs one unsuggested stranger.
const NO_REPLY = /no-?reply|do-?not-?reply|dont-?reply/;
const MACHINE_WORD = /-(auto-?reply|auto-?responder|automated|newsletters?|mailer-?daemon|notifications?|bounces?|info)\d*(?=-)/;
const ROLE_WORD = /^(bounces?|notifications?|notify|notices?|alerts?|automated|newsletters?|news|marketing|updates?|mailer|mail|sendmail|reply|postmaster|promo(tions?)?|offers?|deals|messages?|messenger|receipts?|transactions?|orders?|invoices?|billing|statements?|accounts?|edelivery|surveys?|websurvey|membership|rewards|tickets?|info|information|sales|support|service|services|hello|team)\d*$/;
const BULK_LABEL = /mail|^([etom]|em|ma|m\d|msg|txn|news|newsletter|info|infos|update|updates|mkt|marketing|send|bounces?|notify|notifications?|notice|alerts?|reply|promo|offers?|campaign|comms|communications|comunicaciones|messaging|orders?|print)\d*$/;
const BULK_WORD = /^(e?mails?|info|infos|news|notice|notify|surveys?|alerts?|promo|offers?)$/;
const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|ne|or|go|gob|gen|ltd|plc|nic|mil)$/;
export function machineAddress(email) {
  email = email.toLowerCase();
  const at = email.lastIndexOf("@"), local = email.slice(0, at), labels = email.slice(at + 1).split(".");
  // The registrable domain is two labels, or three under a country's second level (hotmail.co.uk)
  const n = labels.length, sld = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.test(labels[n - 2]) ? 3 : 2;
  const dashed = `-${local.replace(/[._+]/g, "-")}-`;
  if (NO_REPLY.test(dashed) || MACHINE_WORD.test(dashed) || ROLE_WORD.test(local.split(/[._+-]/)[0])) return true;
  if (local.length >= 20 && (local.match(/\d/g) || []).length >= 6) return true;
  const name = labels[n - sld] || "";
  const academic = labels[n - 1] === "edu" || labels.includes("ac");  // mail.uni.edu is a person
  return labels[n - 1] === "email" || (!academic && labels.slice(0, -sld).some(l => BULK_LABEL.test(l))) ||
    (name.includes("-") && name.split("-").some(w => BULK_WORD.test(w))) || (name.length > 5 && name.endsWith("email"));
}
const machineMemo = new Map();
const isMachine = email => { let m = machineMemo.get(email); if (m === undefined) machineMemo.set(email, m = machineAddress(email)); return m; };

// hidden: true or false once the user decides; unset, a machine sender never written to is hidden.
export const isHidden = e => e.hidden ?? (!e.lastSent && isMachine(e.email));

// A display name is only as good as whoever wrote it. Names are kept by source, best first: the
// user's own (recipients of mail they sent), the person's own (the From of mail they sent), and
// anyone else's (other recipients of received mail, which any sender can label as they like).
// The shown name is the most frequent of the best source that has one. names holds names recorded
// before sources were kept, and counts as anyone else's.
const SOURCES = ["mine", "self", "others"];
const NAMES_KEPT = 8, NAME_MAX = 100;
export function noteName(e, raw, source) {
  const n = noBidi(raw).trim().slice(0, NAME_MAX);
  if (!n) return;
  const m = ((e.nameBy ||= {})[source] ||= {});
  m[n] = (m[n] || 0) + 1;
  const keys = Object.keys(m);
  if (keys.length > NAMES_KEPT) delete m[keys.reduce((lo, k) => m[k] < m[lo] ? k : lo)];
}
export function bestName(e) {
  for (const s of SOURCES) {
    const m = { ...(s === "others" ? e.names : null), ...e.nameBy?.[s] };
    const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
  }
  return "";
}

// Record one message's addresses. direction: "sent" (we wrote it) or "received".
async function record(m, direction, pending) {
  const h = m.headers || {}; const when = Number(h.date) || 0;
  const lists = direction === "sent" ? [h.to, h.cc, h.bcc] : [h.from, h.to, h.cc];
  for (const list of lists) for (const a of list || []) {
    const email = (a.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || own.has(email)) continue;
    const e = pending.get(email) || { email, nameBy: {}, last: 0, lastSent: 0 };   // what this scan adds
    noteName(e, a.name, direction === "sent" ? "mine" : list === h.from ? "self" : "others");
    if (direction === "sent") e.lastSent = Math.max(e.lastSent, when);
    e.last = Math.max(e.last, when);
    pending.set(email, e);
  }
}

// Adds what a scan saw to the stored entries.
async function flush(pending) {
  if (!pending.size) return;
  const adds = new Map(pending); pending.clear();
  await updateRows([...adds.keys()], (stored, email) => {
    const d = adds.get(email);
    const e = stored || { email, name: "", nameBy: {}, last: 0, lastSent: 0 };
    delete e.sent; delete e.received;            // no message counts are kept
    e.last = Math.max(e.last || 0, d.last); e.lastSent = Math.max(e.lastSent || 0, d.lastSent);
    for (const [src, names] of Object.entries(d.nameBy)) for (const [n, c] of Object.entries(names)) for (let i = 0; i < c; i++) noteName(e, n, src);
    e.name = bestName(e);
    return e;
  });
}

// A full build reads every message again, so it starts from nothing; the user's hide choices stay.
async function resetRows() {
  const emails = [...(await loadAll()).keys()];
  await updateRows(emails, stored => {
    if (!stored) return stored;
    for (const k of ["sent", "received", "names"]) delete stored[k];
    return Object.assign(stored, { last: 0, lastSent: 0, nameBy: {}, name: "" });
  });
}

async function getMeta(key) { const r = await tx(META, "readonly", s => s.get(key)); return r ? r.value : null; }
async function setMeta(key, value) { await tx(META, "readwrite", s => s.put({ key, value })); }

// One message of a newest-first scan: whether to stop, whether to record it, and the bookmark (the
// newest date recorded). A date more than a day ahead (a sender's wrong clock) never moves the
// bookmark, or every later scan would stop at its first message; incremental scans pass over such
// a message, so only a full scan records it, once.
export function scanStep(when, newest, { full, newestSeen, now }) {
  if (when > now + 86400) return { stop: false, record: full, newest };
  if (!full && when <= newestSeen) return { stop: true, record: false, newest };
  return { stop: false, record: true, newest: Math.max(newest, when) };
}

// Walk a folder newest-first. full: everything the provider lets a full scan read
// (api.LIMITS.scanMax rows); otherwise stop at messages older than the last scan.
async function scanFolder(folderId, direction, full, progress) {
  await loadAll();
  const metaKey = `scan:${folderId}`;
  const prev = full ? null : await getMeta(metaKey);
  const newestSeen = prev?.newest || 0;
  let offset = 0, newest = newestSeen, done = false, seen = 0;
  const pending = new Map(), now = Date.now() / 1000;
  while (!done) {
    // background: a provider with a request quota (Gmail) paces the scan to leave room for browsing
    const r = await api.list(folderId, SCAN_PAGE, offset, { background: true });
    for (const m of r.messages) {
      const step = scanStep(Number(m.headers?.date) || 0, newest, { full, newestSeen, now });
      if (step.stop) { done = true; break; }
      if (step.record) { await record(m, direction, pending); seen++; }
      newest = step.newest;
    }
    offset += r.messages.length;
    if (r.messages.length < SCAN_PAGE || (full && offset >= api.LIMITS.scanMax)) done = true;
    if (pending.size >= 300) await flush(pending);
    progress?.(folderId, seen);
  }
  await flush(pending);
  await setMeta(metaKey, { newest, at: Date.now() });
  return seen;
}

// Initial build (first run) or incremental refresh. inbox/sent are folder ids.
export async function sync({ inbox, sent, full = false, progress } = {}) {
  await loadAll();
  const built = await getMeta("built");
  const doFull = full || !built;
  if (doFull) await resetRows();
  let n = 0;
  if (sent) n += await scanFolder(sent, "sent", doFull, progress);
  if (inbox) n += await scanFolder(inbox, "received", doFull, progress);
  if (doFull) await setMeta("built", Date.now());
  return n;
}

export async function isBuilt() { return !!(await getMeta("built")); }

// Everything learnt, scan bookmarks and hide choices included, gone (signing out).
export async function clear() {
  await openDb();
  await new Promise((ok, no) => {
    const t = db.transaction([STORE, META], "readwrite");
    t.objectStore(STORE).clear(); t.objectStore(META).clear();
    t.oncomplete = ok; t.onerror = () => no(t.error);
  });
  cache = null;
  changed();
}

// The address book is one account's: when another account signs in, it starts afresh. The first
// account seen is simply noted.
export async function useAccount(email) {
  const who = String(email).toLowerCase(), was = await getMeta("account");
  if (was === who) return;
  if (was) await clear();
  await setMeta("account", who);
}

// Called after the user sends a message, so new recipients rank at once.
export async function noteSent(recipients) {
  await loadAll();
  const pending = new Map();
  await record({ headers: { to: recipients, date: String(Math.floor(Date.now() / 1000)) } }, "sent", pending);
  await flush(pending);
}

// Recency ranks: the last exchange either way, and above it the last time the user wrote to the
// person, so people the user writes to stay above senders of similar age.
function score(e, now) {
  const fade = t => t ? Math.exp(-Math.max(0, (now - t) / 86400) / 120) : 0;
  return fade(e.last) + (e.lastSent ? 0.5 + 2 * fade(e.lastSent) : 0) - (e.hidden === undefined && isMachine(e.email) ? 1e6 : 0);
}

// Addresses the user never wants suggested (newsletters and the like). Still recorded, never shown.
export async function hide(email, hidden = true) { await hideMany([email], hidden); }

// Every entry, for the address book manager.
export async function all() {
  await loadAll();
  return [...cache.values()].map(e => ({ name: e.name, email: e.email, last: e.last || 0, hidden: isHidden(e) }));
}

export async function hideMany(emails, hidden = true) {
  const keys = emails.map(x => String(x).toLowerCase());
  const c = await loadAll();
  for (const k of keys) { const e = c.get(k); if (e) e.hidden = hidden; }   // shown at once; stored below
  await updateRows(keys, stored => stored && Object.assign(stored, { hidden }));
}

export async function hiddenList() {
  await loadAll();
  return [...cache.values()].filter(isHidden).sort((a, b) => a.email.localeCompare(b.email)).map(e => ({ name: e.name, email: e.email }));
}

export async function suggest(query, limit = 8, exclude = new Set()) {
  await loadAll();
  const q = (query || "").trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const e of cache.values()) {
    if (exclude.has(e.email) || isHidden(e)) continue;
    if (q) {
      const name = e.name.toLowerCase();
      const words = name.split(/\s+/);
      const hit = e.email.startsWith(q) || name.startsWith(q) || words.some(w => w.startsWith(q)) || e.email.slice(e.email.indexOf("@") + 1).startsWith(q) || e.email.includes(q);
      if (!hit) continue;
    }
    rows.push(e);
  }
  rows.sort((a, b) => (q ? score(b, now) - score(a, now) : b.last - a.last) || (b.lastSent || 0) - (a.lastSent || 0));
  return rows.slice(0, limit).map(e => ({ name: e.name, email: e.email }));
}

export async function count() { await loadAll(); return cache.size; }

export async function lookup(email) {
  await loadAll();
  const e = cache.get(String(email || "").toLowerCase());
  return e ? { name: e.name, email: e.email, last: e.last, lastSent: e.lastSent, hidden: isHidden(e) } : null;
}
