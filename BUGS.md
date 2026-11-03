# Known bugs and problems

Findings from a review of the uncommitted Gmail port and shared-code refactor on 2026-11-02. Four independent reviewers worked in parallel: Gmail adapter correctness, regressions in the Yahoo edition, security of the Gmail edition, and build, tests, CI and docs. Their findings were deduplicated, checked against the code, and ranked here. Line numbers refer to the working tree at the time of the review. The high and medium findings are fixed, each with a test where a test can show it (see Status under each); C1 and the low findings are open.

Confidence: **confirmed** means the failing code path was read end to end; **likely** means the code path is confirmed but depends on Gmail or browser behaviour that was not tested live; **speculative** means plausible but unverified.

## Summary

| # | Severity | Area | Finding | Confidence | Status |
|---|---|---|---|---|---|
| C1 | Critical | Release | Gmail release and store ZIPs ship the placeholder OAuth client id and no `key`; sign-in is impossible | confirmed | open |
| H1 | High | Gmail adapter | Moves strip user labels, and undo cannot restore them; archive drops every label | confirmed | fixed |
| H2 | High | Gmail adapter | Attachments marked `Content-Disposition: inline` but not shown in the body vanish; text after the first text part is dropped | confirmed | fixed |
| H3 | High | Gmail adapter | `metadataHeaders` sent comma-joined; replies may lose In-Reply-To, References and their thread | likely | fixed |
| H4 | High | Gmail sign-in | A 401 renewal drops `login_hint` and can silently switch to another Google account | confirmed (code), likely (Google) | fixed |
| M1 | Medium | Shared compose | Sending while the first draft save is in flight leaves an orphan Gmail draft; a cancelled send makes a second one | confirmed | fixed |
| M2 | Medium | Gmail adapter | A refresh with more than 500 rows shown cuts the list to 500 and loses "Load more" | confirmed | fixed |
| M3 | Medium | Gmail adapter | Failed items inside a batch are treated as gone or as zero counts; rows vanish, paging stops, false new-mail dot | confirmed (code), likely (Gmail) | fixed |
| M4 | Medium | Gmail adapter | A draft deleted or sent elsewhere makes every later save and send of it fail | confirmed | fixed |
| M5 | Medium | Gmail sign-in | Sign out is best effort: revoke failures are silent, data and caches outlive it, a pending renewal can write the token back | confirmed | fixed |
| M6 | Medium | Docs | SECURITY.md and PRIVACY.md claims the Gmail edition does not meet | confirmed | fixed |
| M7 | Medium | Release | A `key` in the manifest also goes into the store ZIP, which stores may reject | speculative | fixed |
| L1 to L20 | Low | various | see below | | open, except L4 and L18 (fixed) and L15 and L16 (partly fixed) |

## Critical

### C1. The Gmail release and store ZIPs cannot sign in

- **Where:** `gmail/manifest.json:28`, `tools/build.js:27-33`, `.github/workflows/release.yml` (Gmail package step), `README.md` (Install, "Gmail and Google's sign-in"), `docs/google-setup.md:3`, `store/LISTING-gmail.md:3`.
- **Failure:** `gmail/local.json` is gitignored and CI provides nothing, so every built `manifest.json` carries `"client_id": "CLIENT_ID.apps.googleusercontent.com"` and no `key`. Sign in with Google fails with `invalid_client`. Even with a real client id, a ZIP without `key` gets an extension id derived from the user's unzip folder, so no redirect URI registered by the project can match it. A hand edit of `manifest.json` is lost on the next update, since updates unzip over the same folder. The README says a release ZIP "carries the project's client id", which is false today, and `build.js` does not complain about the placeholder.
- **Fix:** inject the client id from a repository secret in `release.yml` and commit the public `key` (or supply it the same way); make `build.js` fail on the placeholder in a release build (for example `--release`); correct the README until then.

## High

### H1. Moves strip user labels, and undo cannot restore them

- **Where:** `gmail/api.js:613-626` (`placing`, `remove`), `ext/mail.js` `doMove` undo (`api.move(g, o.from)`), `gmail/api.js:382` (`folderOf`).
- **Failure:** a message in Inbox with the user labels Work and Receipts is deleted: the move removes `INBOX`, `Receipts`, `Work` and adds `TRASH`. Undo moves it back to `INBOX` only, so Work and Receipts are lost for good. Archive (a move to All Mail) strips every user label too, which Gmail's own archive never does. Deleting from All Mail or a search result and undoing loses Inbox as well, because the row's folder is `ALL`, and undoing to `ALL` adds nothing.
- **Fix:** have `move()` return, per id, the labels it removed, and make undo restore exactly those. Alternatively, make Trash, Spam and Archive touch only `TRASH`, `SPAM` and `INBOX`, and keep user labels, as Gmail does.
- **Status:** fixed. `move()` takes away Inbox, Spam, Trash and only the user label of the folder the message is shown in (the client passes each message's folder as `from`); other user labels stay, also through Trash and Spam. Its answer carries `undo()`, which reverses exactly the labels added and removed, and `mail.js` uses it when present (Yahoo keeps the move back to the origin folder). Tests: `tools/gmail-test.mjs` (Trash, Archive, label to label, delete from All Mail, each undone).

### H2. Inline-disposition attachments vanish; text after the first text part is lost

- **Where:** `gmail/api.js:376` (`dispositionOf`, used at 393 and 517); consumers that drop inline parts: `ext/viewer.js:77`, `ext/mail.js` (`fileCount`, print), `ext/compose.js:261` (forward refs). `gmail/api.js:499` (`bodyLeaf`).
- **Failure:** Apple Mail and others send PDFs and images as `Content-Disposition: inline; filename="x.pdf"` with no `cid:` reference in the body. They are classed inline, so they are missing from the attachment strip, from the row's attachment count, and from forwards; in a plain-text message they are never shown at all. Separately, `bodyLeaf` takes only the first `text/plain` or `text/html` leaf, so in a `multipart/mixed` of text, PDF, text, the text after the attachment is not shown.
- **Fix:** class a part as inline only when its Content-ID is referenced as `cid:` in the HTML shown; join consecutive text leaves of a mixed message.
- **Status:** fixed. A part is inline only when its Content-ID is a `cid:` source in the HTML; a row counts a Content-ID part inside `multipart/related` as inline. The text is read from the MIME tree: alternative gives its preferred branch, related its root, any other multipart every text part in order. Test: an Apple-style message with text, an inline-marked PDF and more text.

### H3. `metadataHeaders` is sent comma-joined; replies may lose their thread

- **Where:** `gmail/api.js:687` (`original()`), `tools/gmail-mock.js:154` (the mock splits on commas, so tests pass).
- **Failure:** the Gmail API declares `metadataHeaders` a repeated parameter (as `docs/gmail-api.md` itself says of `labelIds`). If Gmail reads the joined value as one header name, `original()` gets no Message-ID, References or Subject, so replies carry no In-Reply-To or References, and `threadId` is never set because the empty subject never matches. Every reply and forward would start a new thread.
- **Fix:** pass `metadataHeaders: ["Message-ID", "References", "Subject"]` (`addQuery` already repeats arrays); make the mock read `q.getAll("metadataHeaders")`.
- **Status:** fixed. `metadataHeaders` is a list, repeated in the URL; the mock reads it with `getAll`, so the reply-threading test fails on the comma-joined form.

### H4. A 401 renewal can silently switch to another Google account

- **Where:** `gmail/auth.js:61-62` and `72-75` (`forget()` clears `token`, so `flow(false, token?.email)` has no hint), `gmail/api.js:177` and `208`.
- **Failure:** a call gets a 401 (token revoked, password changed). `forget()` sets `token = null`, then the forced silent flow runs with `prompt=none` and no `login_hint`. With several Google accounts in the browser, Google either refuses (the user is sent to the sign-in page on any 401) or issues a token for another account that consented earlier. Nothing compares the new account with the signed-in one, so the client keeps showing account A while acting on account B; system label ids are the same in every mailbox, so Empty Trash, Empty Spam and Mark all read hit B's folders, and Empty is permanent.
- **Fix:** keep the expected email across `forget()` and always pass it as `login_hint`; after any silent renewal, compare the profile email with the signed-in one and throw `NotSignedIn` if it differs.
- **Status:** fixed. The signed-in address is kept in local storage (`gmAccount`) until Sign out and survives `forget()`; every silent renewal sends it as `login_hint` and checks the profile address, refusing a token for any other account. With no account kept, nothing is renewed. Tests: the hint on a 401 renewal, a renewal answered for another account.

## Medium

### M1. Send during the first draft save leaves an orphan draft

- **Where:** `ext/compose.js:896` and `901` (`d` and the snapshot are captured before the save settles), `908` (`await saved()` runs later), `870` (`mine.csid` updated after the save); `gmail/api.js` `send()` (`knownDrafts.has(d.csid)`).
- **Failure:** autosave starts the first `drafts.create` while `draft.csid` is still the `Date.now()` placeholder, and the user presses Send during the upload. `d.csid` stays the placeholder, the adapter does not find the draft, and calls `messages.send`: the mail goes out and the new draft stays in Drafts for good. `forgetFormat(d.csid)` clears the wrong key, and a cancelled send restores the stale csid, so the next save creates a second draft. Yahoo is unaffected, since its csid never changes.
- **Fix:** in `run`, after `await saved()`, refresh `d.csid` (and the snapshot's) from the draft object; or let the adapter map the placeholder csid to the new draft id.
- **Status:** fixed. `send()` in `compose.js` waits for a save in flight before the send runs and before a cancelled send reopens the composer, then takes the csid and saved id from the draft object, which the save updated.

### M2. A refresh past 500 rows cuts the list and loses "Load more"

- **Where:** `gmail/api.js:431` (`maxResults: Math.min(PAGE_MAX, count)`, one call), `ext/mail.js` `loadList` (refresh asks for `shown + 1` from offset 0).
- **Failure:** the user has loaded 1000 rows; a poll refreshes with `count = 1001`. Gmail returns 500 ids, so the list shrinks to 500 and `state.more` becomes false; the rest cannot be loaded without reopening the folder.
- **Fix:** in `listIds`, follow `nextPageToken` until `count` ids are collected.
- **Status:** fixed. `listIds` follows `nextPageToken` until it has `count` ids. Test: a 511-row list over 520 messages takes two pages.

### M3. Failed batch items are treated as gone messages or as zero counts

- **Where:** `gmail/api.js:410` (`filter(r => r.status === 200)`), `300` (`counts[i].json || {}`), `batchOnce` (no per-item retry; 403 `rateLimitExceeded` and `Retry-After` ignored at batch level); `tools/gmail-mock.js` (never fails an item); `docs/gmail-api.md` (claims rate limits are retried).
- **Failure:** Gmail often answers single items of a batch with 429 or 5xx while the batch itself is 200. The row is silently dropped; the page then has fewer than 100 rows, so `state.more` turns false and the folder cannot be paged further, and the cursor has already passed the dropped id. A failed `labels.get` reports 0 unread and 0 total, which changes the counts, stamps a spurious change, and can light the new-mail dot falsely when Inbox drops to 0 and comes back.
- **Fix:** retry 429 and 5xx items with backoff in a smaller batch; treat only 404 as gone; keep a label's previous counts when its get fails; add per-item failure injection to the mock.
- **Status:** fixed. Batch items refused with 429, 5xx or a 403 rate limit are asked again (three rounds, backoff, in a batch of their own), and a refused batch honours `Retry-After` and 403 rate limits. A row that still fails fails the list (only 404 means gone); a label whose counts fail keeps its last counts and is not stamped. The mock injects per-item failures (`failItems`). Tests for each.

### M4. A draft removed elsewhere blocks every later save and send

- **Where:** `gmail/api.js:719` (only a 400 with a thread is retried), `732-733`, `748-749`.
- **Failure:** the open draft is discarded or sent from Gmail on the web or a phone. Its id is still in `knownDrafts`, so `PUT /drafts/{id}` answers 404 and every autosave fails, and closing the composer refuses because the draft cannot be saved; Send through `drafts.send` also gets 404 and reopens the composer, which fails again.
- **Fix:** on 404 from `drafts.update`, drop the id and create a new draft; on 404 from `drafts.send`, fall back to `messages.send`.
- **Status:** fixed. A 404 from `drafts.update` drops the id and creates a new draft; a 404 from `drafts.send` sends with `messages.send`. Tests for both.

### M5. Sign out is best effort and leaves data behind

- **Where:** `gmail/auth.js:80` (revoke errors swallowed, `resp.ok` unchecked), `gmail/api.js` `signOut()` (clears only some caches), `ext/contacts.js:8` (one IndexedDB for every account), `ext/mail.js` start-up (`bootstrap()` on every load).
- **Failure:** if the revoke fails (offline, timeout, error answer), the user still sees the sign-in page; on the next load, `bootstrap()` signs in again silently with no click, possibly to a different default account (see H4). The address book and its scan bookmarks are never cleared, so after signing in as another account the composer suggests the first account's correspondents and the incremental scan stops at the first account's newest date. `partRefs`, `bytesCache`, `thumbCache`, `inlineCache`, `originals`, `labelName` and `profileCache` survive sign-out. A silent renewal already pending when Sign out runs writes a fresh token back after `forget()`.
- **Fix:** check the revoke answer and report a failure; clear or key the address book by account; clear all module caches; ignore a flow that started before sign-out; after an explicit sign-out, do not sign in on load until the button is pressed.
- **Status:** fixed. Sign out waits for a renewal in flight, posts the token in the form body (also L4), and throws, still signed in, unless Google answers 200 or 400; then it forgets token and account, ignores any flow begun before it, and the adapter clears every cache. `mail.js` refuses while a send is pending, closes the composer first, clears the address book and reloads the page. The address book records its account (`contacts.useAccount`) and starts afresh when another account signs in. Tests: a refused revoke, the token in the body, no renewal after sign-out; `gmail-runtime.js` signs out through the button.

### M6. SECURITY.md and PRIVACY.md claims the Gmail edition does not meet

- **Where:** `SECURITY.md` (Network, Sign-in, Message content, Outgoing mail bullets), `PRIVACY.md` (closing sentence of "Where your data goes", storage table).
- **Failure:** "the browser enforces this, so even faulty code cannot send data to a third party" and "these are the only places each extension can send anything" are false for Gmail: its `img-src 'self' data: blob: https:` lets any extension page (mail.html, print.html, the reader frame) request any https host through an image or CSS `url()`. "The token never appears in a URL the extension requests" is false (see L4). "Sign out revokes it" is best effort (see M5). "No header can be injected" is true, but addresses themselves are not validated (see L5). The storage table does not say that the address book outlives sign-out and is shared between Google accounts.
- **Fix:** scope the network claims to `connect-src` and say that Gmail's `img-src https:` allows requests to any host; correct the other sentences or fix the code they describe.
- **Status:** fixed. SECURITY.md scopes the network claim to `connect-src` and says what Gmail's `img-src https:` allows, describes the sign-in as it now works, and no longer claims that addresses are checked; PRIVACY.md qualifies the closing sentence, adds the account address to the storage table, and says when the address book is cleared.

### M7. A `key` in the manifest goes into the store ZIP too

- **Where:** `tools/build.js:32`, `release.yml` (one build output feeds both Gmail ZIPs).
- **Failure:** when a `key` is supplied (as C1's fix suggests), the `-store.zip` carries it too; the Chrome Web Store has been known to reject or mishandle uploaded manifests that contain `key`.
- **Fix:** delete `key` from the manifest before zipping the store package.
- **Status:** fixed. `node tools/build.js --store` leaves `key` out, and the release workflow builds the store package that way and checks that its manifest has no key.

## Low

### L1. The insufficient-scope check never matches
`gmail/api.js:181`, `187`. Google's 403 for a missing scope has `errors[0].reason = "insufficientPermissions"` and `status = "PERMISSION_DENIED"`; `ACCESS_TOKEN_SCOPE_INSUFFICIENT` appears only in `error.details[].reason`, which is not read. A token without mail scope (granular consent, or the scope withdrawn) shows repeated errors instead of the sign-in page. Fix: also check `details[].reason` and `insufficientPermissions`. Likely.

### L2. The retry without a thread never runs for `messages.send`
`gmail/api.js:719` with `749`. For `messages.send` the metadata is `{ threadId }` itself, so `meta.message?.threadId` is undefined and a send Gmail refuses because of its thread fails instead of being retried without it. Fix: check `meta.threadId ?? meta.message?.threadId` and strip whichever is present. Confirmed.

### L3. Archive does nothing in the All Mail view
`gmail/api.js:382`. Listed from All Mail, every row's folder is `ALL`, so archiving an Inbox message says "already in All Mail" and leaves `INBOX` in place. Fix: when listing All Mail, take the row's folder from its labels (`folderOf(labels, null)`). Confirmed.

### L4. The token is sent in the revoke URL
`gmail/auth.js:80` posts to `https://oauth2.googleapis.com/revoke?token=<access token>`, so the token lands in URL-level logs (proxies, net-export), contrary to SECURITY.md. Fix: send `token=` in the form body, which the Content-Type header already declares. Confirmed. Status: fixed with M5.

### L5. Addresses are not validated; one chip can hold several recipients
`gmail/rfc822.js:160-161` (`parseAddresses`), `53-56` (`formatAddress` writes the address verbatim). `Reply-To: Boss <boss@corp.com,attacker@evil.com>` parses as one entry, `{ name: "Boss", email: "boss@corp.com,attacker@evil.com" }`; a reply shows one "Boss" chip and sends `To: Boss <boss@corp.com,attacker@evil.com>`; the string is also stored in the address book. Whether Gmail delivers to both is untested. Fix: accept one addr-spec per entry when parsing and again when formatting; reject or split anything else. Parsing confirmed, delivery speculative.

### L6. A sender address can inject search operators into the contact card search
`gmail/api.js:65`, `72` (`bareAddress` keeps `{ } : - |`). An address such as `a@x{from:bank.com}` makes the card's recent messages and the person search list unrelated mail. It misleads only; nothing leaves the browser. Fix: quote the address in the query or allow only addr-spec characters. Confirmed.

### L7. Remote image requests may send the extension id as Referer
`ext/mail.js` `setFrame` and `bodyDoc`, `ext/print.html`. The iframe's `referrerpolicy` covers only its own navigation, not the srcdoc document's subresources, so senders' image servers likely see `chrome-extension://<id>/`; for a ZIP install that id is derived from the folder path, a stable identifier across senders. Fix: add `<meta name="referrer" content="no-referrer">` to the reader document and the print page, then check with a test server. Likely, untested.

### L8. The 60-image cap now counts other messages' images (Yahoo)
`ext/mail.js` `inlineImages`. The cap used to apply after filtering to the message's own parts; now `isInlineRef` checks only the address shape and ownership is checked later in `inlineSource`, so a message with many foreign part addresses ahead of its own images gets fewer of its own inlined. Fix: pass the body to `isInlineRef`, or keep asking until 60 sources are accepted. Confirmed, rare.

### L9. The strip shows Yahoo attachments without an https download link
`ext/viewer.js:77`. Attachments without an https `downloadUrl` used to be hidden; now they show, and if such a part is also missing from the raw source, preview says "attachment not found in message source" and Download only reports "could not fetch the attachment". Fix: keep the filter as an adapter predicate, or accept the change. Confirmed change; whether Yahoo sends such entries is speculative.

### L10. Attachment limit counts duplicates; drop status overstates
`ext/compose.js:752-757` and `153`. A file already attached is counted against the 25 MB limit before `withFiles` skips it as a duplicate, giving a false "Not attached" near the limit; a drop on the editor always says "attached N files" even when the limit refused some. Fix: skip duplicates before the size check and have `addFiles` return the number attached. Confirmed.

### L11. Doubled "no preview" message
`ext/viewer.js` (`showText` throws "no preview available", the catch writes "No preview available for this file (no preview available)"). The Gmail runtime test asserts the doubled text (`tools/gmail-runtime.js:307`). Fix: throw a reason that reads well in the sentence, or omit the parenthesis for it, and update the test. Confirmed.

### L12. A huge References header is copied whole into replies
`gmail/api.js:689`, `703`; `gmail/rfc822.js:116`. An attacker's References of any size is copied into the reply, which Gmail may then reject. Not an injection: every white-space run becomes a fold. Fix: keep the first id and the last few, as mail clients do. Confirmed copy, size limit untested.

### L13. Weak or vacuous test assertions
- `tools/gmail-test.mjs:156` "counts through one batch": the mock does not record the outer `/batch` call, so separate GETs would pass too.
- `tools/gmail-runtime.js:161`: `waitForFunction(() => ... || true)` returns at once.
- `tools/harness.js` (Gmail section): the `accounts.google.com` route records nothing and is routed, so it never shows in `unexpectedHosts`; nothing asserts that no sign-in window opened.
- `tools/gmail-runtime.js:342`: drops every CSP violation that mentions `gmail.googleapis.com/`, not only the sandbox's deliberate fetch.
- `tools/gmail-test.mjs:323`: asserts that silent renewal succeeds after sign-out; the mock ignores revocation, while real Google may require consent again.
- The mock answers every batch item 200 or 404 (see M3) and splits `metadataHeaders` on commas (see H3).

Fix: record batch calls and Google sign-in hits in the mock and assert on them, remove the `|| true`, narrow the CSP filter to `render.html`, and model revocation and per-item failures.

### L14. google-setup.md section 6: key versus id, CASA tier
`docs/google-setup.md:47`. "Use the published copy's id for `key`" is wrong: `key` is a public key (the store dashboard's "View public key"), not an id. "CASA Tier 2" is stated as fact, but Google assigns the tier. Fix: reword both. Confirmed (key), likely (tier).

### L15. Doc numbers and wording
- `docs/gmail-api.md` says Empty Trash and Spam delete "a thousand at a time"; `eachPage` uses pages of 500 and stops silently after 200 pages (100,000 messages).
- `docs/gmail-api.md` says a poll costs "1 + labels + 2" units; `folders()` also calls `getProfile`.
- `README.md` ("nothing is transformed") and `SECURITY.md` ("no transformation"): `build.js` rewrites `manifest.json` (version, client id, key).
- `store/LISTING-gmail.md` says "Your mail goes only between your browser and Google", yet remote images go to senders' hosts.

Fix: correct the numbers, report the 100,000 cap, soften the wording. Confirmed. Status: partly fixed. README.md and SECURITY.md say that the build writes the manifest (version, client id, key) and copies everything else; the numbers and the listing's wording are open.

### L16. Build robustness
- `tools/gmail-test.mjs:83` runs the build with `stdio: "ignore"`, so a build failure shows only "Command failed".
- `tools/build.js:16` deletes `dist/baltazar-mail-gmail` first; a concurrent run (unit test while a browser suite has that folder loaded) or a Windows lock breaks the running suite.
- `tools/build.js:37-47`: the Yahoo-address check can be fooled (comment-stripping regexes eat code between `"/*"` and `"*/"` strings; `"ya" + "hoo"` slips through) and ignores HTML comments, which could fail spuriously. Its `api.js` and `rules.js` existence checks are vacuous since `ext/` has both. The overlay allow-list is checked only at the top level, so a future `gmail/icons/` would merge into `ext/icons` unchecked.
- The release job has no `setup-node`, so `build.js` runs on the runner's default Node.

Fix: show build output on failure, build into a temporary folder and swap, tighten the checks, pin Node in the release job. Status: partly fixed. The build empties its output folder instead of removing it, so a folder Windows holds open no longer stops it. Each edition (`yahoo/`, `gmail/`) must give `manifest.json`, `api.js` and `rules.js`, the shared `ext/` may hold none of them, and any other edition file (a subfolder included) is refused unless it is listed as added, so the existence checks mean something. Open: the hidden build output, concurrent runs, the host check's comment stripping, and Node in the release job.

### L17. Quoted-printable and RFC 2231 details
`gmail/rfc822.js`: a trailing space before a hard break becomes `=20` after the 75-character check, so a line can reach 77 characters; RFC 2231 `filename*` leaves `'()*` unescaped (`encodeURIComponent` does not escape them). Fix: account for the escape in the length check; escape those characters. Confirmed.

### L18. Quota pacing undercounts
`gmail/api.js` `quota()`: every waiter resets `quotaUsed` to 0 when it wakes, so after a pause several bulk calls each believe they start a fresh minute. Fix: reset once per window and add the waiter's units after the reset. Confirmed. Status: fixed. `quota()` keeps a sliding minute of what every call spent, sized for the 6,000 units a minute a project gives each user by default (5,500 for what the user does, 2,500 for the background address-book build), and a quota refusal holds every call until the minute Gmail names is over.

### L19. Full sender CSS and `img-src https:` in the Gmail reader
`gmail/manifest.json:34`, `ext/mail.js` `cleanHtml`. Gmail returns the sender's HTML with `<style>` blocks intact (Yahoo pre-filtered it), and with images on, CSS attribute selectors and `:has()` can make image requests that depend on the message's own content. This matters only if a third party can inject a style block into someone else's mail that holds a secret (for example an HTML-injection bug in a service's password-reset mail). Gmail's own web UI filters CSS and proxies images. Fix: consider dropping `<style>` blocks or attribute and `:has()` selectors in Gmail HTML, or defaulting Gmail to load images when asked. Confirmed mechanism.

### L20. SVG attachments open as SVG blobs
`ext/viewer.js` (`MIME.svg = image/svg+xml`). Inert inside the viewer's `<img>`, but "Open image in new tab" makes it a top-level document at the extension origin; the CSP still blocks inline script. Fix: type SVG as `application/octet-stream` or render it in `render.html`. Speculative.

## Checked and found sound

- Yahoo edition: every moved piece of code behaves as before (inline images and their raw-source fallback, thumbnails, viewer fallbacks, downloads, mark-all-read fallback, the Starred and person queries, reader and print CSP, sign-in panel text and retry, the service worker's rule registration); no remaining calls to removed functions; no import cycles or import-time side effects. All suites pass: unit tests, smoke, runtime, review (74 scenarios), Gmail unit and Gmail runtime.
- Gmail: batch framing and the `response-itemN` mapping; the multipart upload format and endpoints for drafts and sends; `labelIds` AND semantics and repetition; history handling with the full re-stamp on 404; search compilation precedence; OAuth state check; no header injection through names, subjects, file names, Content-IDs or References; no way for mail to run script, read the token, or steer API requests (message and label ids are validated, other path segments come from Gmail's own answers, `cid:` resolves only against the message's own parts); images handed to the page are sniffed raster types only.
- Packaging: `release-check.sh` still holds, both editions' versions are stamped from `VERSION`, and the attestation paths and release glob match the new ZIP names.
