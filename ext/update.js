// Release check: at most once a day, ask GitHub for this project's newest release number, so
// Settings can say when an update is available. No cookies and nothing about the user or the
// mailbox is sent; the answer is only compared with the installed version. Nothing is downloaded.

const REPO_PATH = "gdevic/baltazar-mail-2";
export const REPO = `https://github.com/${REPO_PATH}`;
export const RELEASES = `${REPO}/releases/latest`;
const LATEST = `https://api.github.com/repos/${REPO_PATH}/releases/latest`;
const DAY = 86400e3, RETRY = 3600e3;
const TAG = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

// true when version a ("x.y.z") is newer than b
export function newer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Newest released version, or null if unknown. Asks GitHub only when the last answer is a day
// old; a failed request is retried after an hour.
let inFlight = null;
export function latest(now = Date.now()) { return inFlight ||= ask(now).finally(() => { inFlight = null; }); }
async function ask(now) {
  const c = (await chrome.storage.local.get("updateCheck")).updateCheck;
  if (c && c.next > now && c.at <= now) return c.version || null;
  let version = c?.version || null, ok = false;
  try {
    const r = await fetch(LATEST, { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
    if (r.ok) { const m = TAG.exec(String((await r.json()).tag_name || "")); if (m) { version = m.slice(1).map(Number).join("."); ok = true; } }
  } catch { /* offline or blocked: keep the last answer */ }
  await chrome.storage.local.set({ updateCheck: { at: now, next: now + (ok ? DAY : RETRY), version } });
  return version;
}
