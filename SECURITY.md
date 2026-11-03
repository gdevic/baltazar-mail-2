# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/gdevic/baltazar-mail-2/security/advisories/new). Do not open a public issue for them. Include what you found, how to reproduce it, which extension (Yahoo or Gmail) and which version you used.

This is a one-person project; expect an acknowledgement within a few days and a fix as fast as its severity warrants. Reports are credited in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives fixes. Store installs are updated by the browser; for a ZIP install, put the new release's files into the same folder and click Reload on the extensions page (the README explains how).

## What is in scope

Baltazar Mail runs with your Yahoo Mail session, and Baltazar Mail for Gmail with a Google sign-in that can read, write and delete your mail, so the most important problems are anything that lets a message, an attachment or a web page read your mail, act as you, or send data anywhere other than your mail service. Problems in Yahoo's or Google's own services are out of scope; report those to them.

## How the extensions are protected

The two extensions are the same code with one module swapped, the adapter that speaks to the mail service, so everything below applies to both unless it names one.

- **Network.** Each extension's Content Security Policy in its `manifest.json` lets its pages connect (`connect-src`: fetch and the like) only to its mail service (`mail.yahoo.com` and its subdomains; `gmail.googleapis.com` and `oauth2.googleapis.com`), plus `api.github.com` for the daily release check of ZIP installs. The browser enforces this, so even faulty code cannot send a request with a body, or read an answer, from a third party. Host permissions are limited to the same hosts. Images are the exception: the Yahoo extension loads them only from Yahoo's image proxy, never from Yahoo's mail hosts; the Gmail extension's pages (the app, the reader frame and the print page) may load an image from any `https:` host (`img-src https:`), because Gmail's API hands over the sender's HTML with its original image addresses. An image request can carry data in its address, so in the Gmail extension a message, or code running in the app, could reach any host that way; the protections below keep script from running in messages, and the privacy notice says what a loaded image tells its sender.
- **Sign-in.** The Yahoo extension reuses the browser's Yahoo session and never sees a password. The Gmail extension signs in through Google's own page and holds only an access token, in session storage, that lasts an hour and is renewed silently, for the signed-in account only: Google is told which account, and a token for any other is refused. The token never appears in a URL the extension requests. Sign out revokes it at Google, which withdraws the permission, and forgets the token, the account and the address book, so nothing signs in again until the button is pressed; when Google does not confirm the revocation, the user is told and stays signed in. The extension never opens Google's window except when the sign-in button is clicked.
- **Message content.** Message HTML is cleaned with DOMPurify, whether or not the service cleaned it first (Yahoo does, Gmail does not), and shown in a sandboxed frame where scripts cannot run, both by the sandbox and by the frame's content security policy. The frame shares the app's origin only so that keyboard shortcuts work while a message has focus; it may load images only from where the extension allows (Yahoo's image proxy, or for Gmail any `https:` host) and data: URLs. No extension page may load an image from Yahoo's mail hosts at all, and quoted replies, reopened drafts and printed copies keep to the reader's image rules, so mail cannot make a request that carries your Yahoo cookies. Where the reader blocks remote images (Spam, Trash, or the setting), quotes in replies and printed copies block them too. Printed messages are kept in their own section, so their styles cannot change the printed header.
- **Attachments.** Attachment files are parsed (PDF.js, docx-preview, SheetJS, ZIP listings, text) in `render.html`, a sandbox page with an opaque origin, no cookies, no extension APIs and no network access beyond its own files. Links and keys it reports back are checked before the extension acts on them.
- **Outgoing mail.** Messages the Gmail extension sends are built by its own RFC 822 writer from the composer's fields; display names, subjects and file names are encoded, so no header can be injected through them. Addresses are written as the composer holds them; their form is not checked.
- **Bundled libraries.** Every third-party file is recorded with its source and SHA-256 in `ext/vendor/vendor.json`. A GitHub Actions workflow compares each file with its published original and looks up known vulnerabilities in the OSV database on every change to the libraries and weekly; the tests check the recorded hashes on every push to main, on pull requests and before each release.
- **Code scanning.** CodeQL scans the extensions and the workflows on every push to main, on pull requests and weekly.
- **Releases.** Release ZIPs are built by GitHub Actions from a tagged commit, never on a personal machine, and carry a signed build provenance. Verify one with `gh attestation verify baltazar-mail-yahoo-<version>.zip -R gdevic/baltazar-mail-2` (or `baltazar-mail-gmail-<version>.zip`).

## Reviews

An independent review on 31 October 2026 found six issues, none allowing script to run; all are fixed. The summary is in [docs/security-review.md](docs/security-review.md). A second review on 1 November 2026 found no way for mail, attachments or GitHub to run script or reach your session; its medium findings (quoted content in reply drafts, images and styles in quotes and print) are fixed. Both reviews covered the Yahoo extension; the Gmail extension shares that code and adds the adapter, the sign-in module and the RFC 822 writer.

## Known limits

Each extension acts with your mail session; the protections above keep your data from leaving for a third party, but they cannot stop misuse through the mail service itself, such as sending mail as you, if the extension's own code were compromised. That is why the extensions' own code is plain, unminified JavaScript (each extension is assembled by copying the shared files and its edition's files, with no transformation; only the manifest is written, to add the version and, for Gmail, the OAuth client id), and the bundled libraries are their published releases, checked byte for byte: what is in this repository is exactly what runs.
