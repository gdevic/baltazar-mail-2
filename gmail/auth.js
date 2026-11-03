// Google sign-in for the Gmail adapter: OAuth 2.0 implicit grant through chrome.identity's web
// auth flow, which works in Chrome and in Edge alike. The access token lasts an hour; it is renewed
// silently (prompt=none, which succeeds while the browser holds a Google session) and kept in
// session storage, so a reload does not ask again. Only signIn() may open Google's window.
//
// A silent renewal is only ever for the account the user signed in with: Google is told which
// one (login_hint), and a token for any other account is refused, so the client never shows one
// mailbox while acting on another. The account is kept in local storage until Sign out; without
// it nothing is renewed, and the sign-in panel asks.
//
// A silent renewal fails in two ways that must not look alike. When Google answers it with a
// refusal (login_required and the like, or a page that needs the user), the session is gone and
// NotSignedIn sends the user to the sign-in panel. When Google was never reached (the page could
// not be loaded, a timeout, a profile check the server failed), it is an ordinary Error carrying
// the browser's reason, which the client reports like any connection failure and tries again.

const SCOPE = "https://mail.google.com/";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const KEY = "gmToken", ACCOUNT = "gmAccount";
const RENEW_AHEAD = 5 * 60e3;

export class NotSignedIn extends Error {
  constructor(why) { super(why || "Not signed in to Google"); this.name = "NotSignedIn"; }
}

let token = null;       // { access_token, expires, email }, or { email } once the token is forgotten
let pending = null, pendingInteractive = false;
let epoch = 0;          // counts sign-outs: a flow begun before one does not sign back in

const clientId = () => chrome.runtime.getManifest().oauth2?.client_id || "";
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function authUrl(interactive, email) {
  const state = crypto.randomUUID();
  const p = new URLSearchParams({ client_id: clientId(), redirect_uri: chrome.identity.getRedirectURL(), response_type: "token", scope: SCOPE, state, include_granted_scopes: "true" });
  if (interactive) p.set("prompt", "select_account consent");
  else { p.set("prompt", "none"); p.set("login_hint", email); }
  return { url: `${AUTH}?${p}`, state };
}

// Runs the flow and reads the token out of the redirect's fragment.
async function flow(interactive, email) {
  const { url, state } = authUrl(interactive, email);
  let redirect;
  try { redirect = await chrome.identity.launchWebAuthFlow({ url, interactive }); }
  catch (e) {
    if (interactive) throw new NotSignedIn(`Google sign-in did not complete (${e.message})`);
    if (/interaction|approve|not signed in/i.test(e.message)) throw new NotSignedIn();
    throw new Error(`Google's sign-in could not be reached (${e.message})`);
  }
  const q = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (q.get("state") !== state) throw new NotSignedIn("the sign-in answer did not match the request");
  if (q.get("error")) throw new NotSignedIn(interactive ? `Google answered: ${q.get("error")}` : undefined);
  const access = q.get("access_token");
  if (!access) throw new NotSignedIn("no token in the sign-in answer");
  return { access_token: access, expires: Date.now() + (Number(q.get("expires_in")) || 3600) * 1000 };
}

async function profileEmail(access) {
  const resp = await fetch(PROFILE, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30000) });
  if (resp.status === 401 || resp.status === 403) throw new NotSignedIn(`Google did not confirm the account (HTTP ${resp.status})`);
  if (!resp.ok) throw new Error(`Google could not confirm the account (HTTP ${resp.status})`);
  return (await resp.json()).emailAddress || "";
}

// The account the user signed in with, or "" when nobody is.
async function account() {
  return (await chrome.storage.local.get(ACCOUNT))[ACCOUNT] || token?.email || "";
}

// The token to use now. interactive: ask the user (the sign-in button only). force: renew even
// if the stored one has time left (after a 401). Callers that ask at the same time share one
// flow, except that an interactive request waits for a silent one to settle, then runs its own.
export async function getToken({ interactive = false, force = false } = {}) {
  if (pending && (pendingInteractive || !interactive)) return pending;
  if (pending) await pending.catch(() => {});
  const began = epoch;
  const p = (async () => {
    if (!token) token = (await chrome.storage.session.get(KEY))[KEY] || null;
    let want = "";
    if (!interactive) {
      want = await account();
      if (!want) throw new NotSignedIn();
      if (!force && token?.access_token && same(token.email, want) && token.expires - Date.now() > RENEW_AHEAD) return token;
    }
    const t = await flow(interactive, want);
    const email = await profileEmail(t.access_token);
    if (epoch !== began) throw new NotSignedIn();
    if (want && !same(email, want)) throw new NotSignedIn(`Google renewed the sign-in for ${email}, not ${want}; sign in again`);
    token = { ...t, email };
    await chrome.storage.session.set({ [KEY]: token });
    await chrome.storage.local.set({ [ACCOUNT]: email });
    return token;
  })().finally(() => { if (pending === p) pending = null; });
  pending = p; pendingInteractive = interactive;
  return p;
}

// Forgets the token here and in session storage, keeping the account; the next call renews the
// token silently for that account.
export async function forget() {
  token = token?.email ? { email: token.email } : null;
  await chrome.storage.session.remove(KEY);
}

// Tells Google the token is no longer wanted, which withdraws the permission, then forgets the
// token and the account, so nothing signs in again until the sign-in button is pressed. Throws,
// still signed in, when Google cannot confirm it; a token Google no longer knows (400) counts as
// ended.
export async function signOut() {
  if (pending) await pending.catch(() => {});
  const t = token?.access_token || (await chrome.storage.session.get(KEY))[KEY]?.access_token;
  if (t) {
    let resp;
    try {
      resp = await fetch(REVOKE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }).toString(), signal: AbortSignal.timeout(15000) });
    } catch (e) { throw new Error(`Google could not be reached to end the sign-in (${e.message}); you are still signed in`); }
    if (!resp.ok && resp.status !== 400) throw new Error(`Google did not end the sign-in (HTTP ${resp.status}); you are still signed in`);
  }
  epoch++;
  token = null;
  await chrome.storage.session.remove(KEY);
  await chrome.storage.local.remove(ACCOUNT);
}
