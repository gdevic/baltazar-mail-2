# Privacy

Baltazar Mail for Yahoo and Baltazar Mail for Gmail are browser extensions that show your mail. They have no server, no account of their own, no analytics and no telemetry. Their author receives nothing about you or your mail. The two extensions share their code and differ only in the mail service they talk to; this page covers both, and says where they differ.

## Where your data goes

Each extension talks to its mail service and, when loaded with Load unpacked (a release ZIP or a copy built from the source), to GitHub for one thing:

| Host | Used for |
|---|---|
| `api.github.com` (both) | only for a copy loaded with Load unpacked (a release ZIP or a copy built from the source), which cannot update itself: once a day, a request for the latest release number of this project, so Settings can say when an update is available. It carries no cookies, no account or mail data and no identifier; GitHub sees only what any web request shows (IP address and browser). The answer is used only for the version comparison; nothing is downloaded or installed. An install from a browser store is updated by the browser and never contacts GitHub |

Baltazar Mail for Yahoo, using the Yahoo sign-in already in your browser:

| Host | Used for |
|---|---|
| `mail.yahoo.com` | reading the session values Yahoo's own web page uses, and every mailbox operation: folders, lists, search, reading, moving, deleting, drafts, sending |
| `apis.mail.yahoo.com` | the raw source of a message, from which attachments are taken for preview and download |
| `cloud-apis.mail.yahoo.com` | attachment thumbnails, images embedded in messages, and Yahoo's text extraction for documents |
| `*.yusercontent.com` | images in messages, which Yahoo routes through this proxy |

When a document format has no viewer in the extension (for example PowerPoint), the Yahoo extension's preview asks Yahoo's own document converter to render it. The file is already stored at Yahoo; nothing is sent elsewhere.

Baltazar Mail for Gmail, with the Google sign-in you give it:

| Host | Used for |
|---|---|
| `accounts.google.com` | Google's own sign-in page, opened in a window of its own when you click Sign in with Google, and used silently to renew the sign-in while the browser keeps your Google session |
| `gmail.googleapis.com` | every mailbox operation through the Gmail API: labels, lists, search, reading, attachments, moving, deleting, drafts, sending |
| `oauth2.googleapis.com` | revoking the sign-in when you click Sign out in Settings; the token goes in the request's body |
| the senders' own servers | images in messages, when the setting lets them load: Gmail's API hands over the message as the sender wrote it, so each image is fetched from wherever the sender put it, which tells that server your address and that the message was opened. The default is to load them automatically except in Spam and Trash; Settings can limit that to when you ask |

The extension's Content Security Policy (in its `manifest.json`) makes the browser block any other destination for the extension's own requests, so mail and everything else the extension sends goes only to these hosts. The Yahoo extension's pages may load images only from Yahoo's image proxy. The Gmail extension's pages may load images (including those a message's styles name) from any `https:` host, which is what lets a message's images load from their senders' servers. Such a request is made by the message's own HTML and styles, so it can tell that server what the message itself is able to (that it was opened, your IP address and browser); it never carries your Google sign-in.

## What is stored on your computer

| Data | Where | Why |
|---|---|---|
| Settings: layout, theme, palettes and contrast, text and row size, the message zoom, pane sizes, expanded folders, writing font, size and HTML or plain text, when images load, whether dark mode shows messages in their original colours, and the new-mail check, mark-read and undo-send intervals | the extension's local storage | so your choices persist |
| When you last looked at the mail tab | the extension's local storage | so a tab that opens in the background shows the new-mail dot for mail that arrived while the browser was closed |
| The latest release number and when it was checked | the extension's local storage | to ask GitHub once a day, or an hour later after a failed check |
| For each draft saved here, whether it was written in HTML or plain text (keyed by the draft's id, removed when it is sent or discarded, at most 200 kept) | the extension's local storage | to reopen the draft in the same format |
| Address book: names, addresses, the last date mail went either way and the last date you wrote to each, and whether you hid it from suggestions, with the address of the account it belongs to | the extension's IndexedDB; started afresh when another account signs in, and cleared by Sign out (Gmail) | address suggestions while writing; built from the headers of your own Inbox and Sent |
| Yahoo: the session values and the mailbox id | the extension's session storage, cleared when the browser closes | to call Yahoo without reloading its page |
| Gmail: the access token Google gave the extension, with its expiry and your address | the extension's session storage, cleared when the browser closes; revoked at Google by Sign out | to call the Gmail API; it is renewed silently an hour at a time |
| Gmail: the address of the Google account you signed in with | the extension's local storage, removed by Sign out | so a silent renewal asks Google for that account only, and refuses a token for any other |
| A message being printed | session storage, removed as soon as the print page reads it | to hand it to the print page |

Message contents are not stored; they are fetched from the mail service when you open a message. Removing an extension from the browser deletes all of the above for it.

## Permissions

Baltazar Mail for Yahoo:

| Permission | Why |
|---|---|
| Access to `mail.yahoo.com` and `*.mail.yahoo.com` | to call Yahoo Mail with your existing sign-in |
| `storage` | settings, the release check, the session values and print hand-off described above |
| `declarativeNetRequest` | Yahoo's servers only accept requests that come from `mail.yahoo.com`; one rule sets the `Origin` and `Referer` headers on the extension's own requests to Yahoo |

Baltazar Mail for Gmail:

| Permission | Why |
|---|---|
| Access to `gmail.googleapis.com` and `oauth2.googleapis.com` | to call the Gmail API, and to revoke the sign-in |
| `identity` | to open Google's sign-in window and receive the token it answers with |
| `storage` | settings, the release check, the token, the account address and print hand-off described above |
| The Gmail permission you grant at sign-in (`https://mail.google.com/`) | the one that lets the extension read, write and permanently delete mail, which Empty Trash, Empty Spam and Delete in Trash need; it can be withdrawn at any time in your Google account's security settings |

## Contact

Questions about privacy can be raised as an issue on https://github.com/gdevic/baltazar-mail-2. Baltazar Mail is an independent project by Baltazar Studios and is not affiliated with Yahoo or Google.
