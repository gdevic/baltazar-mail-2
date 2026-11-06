# Baltazar Mail for Gmail: submission kit

Everything to paste into a store listing for Baltazar Mail for Gmail. Neither edition of this project is published in a store; this page is ready for when one is. The package is the built extension with `manifest.json` at the top level; build it with the project's client id in `gmail/local.json` (`node tools/build.js gmail --store`, then zip the contents of `dist/baltazar-mail-gmail`), since the release's `-store.zip` carries only a placeholder client id. Before a store submission, Google's OAuth verification for the restricted Gmail scope must be complete (see `docs/google-setup.md`): without it, the consent screen warns and only test users can sign in, which a store reviewer cannot.

## Account

Individual account, publisher display name "Goran Devic".

## Availability

Visibility: Public. Markets: all.

## Properties

- Category: Communication if offered, otherwise Productivity.
- Website: https://github.com/gdevic/baltazar-mail-2
- Support contact: https://github.com/gdevic/baltazar-mail-2/issues
- Mature content: not checked.

## Privacy

Single purpose description:

> Baltazar Mail for Gmail is an alternative reading and writing interface for the user's own Gmail account. It shows the user's labels and messages, previews attachments, and sends mail, through the Gmail API with a Google sign-in the user grants in the extension.

Permission justifications:

- `identity`: Opens Google's own sign-in page in a window when the user clicks Sign in with Google, and receives the access token Google answers with. The extension never sees a password. The token is renewed silently while the browser keeps the user's Google session, and Sign out in Settings revokes it.
- `storage`: Keeps the user's settings (layout, theme and contrast, sizes, fonts, intervals), the time of the last release check, the format of drafts saved here, when the mail tab was last looked at (for the new-mail dot) and, until Sign out, the address of the Google account signed in, so a silent renewal asks for that account only; and, for the browser session only, the Google access token, so the extension does not ask Google for every request, and a message being printed, until the print page has read it.
- Host permission `https://gmail.googleapis.com/*`: All mailbox operations (labels, message lists, search, reading, attachments, moving, deleting, drafts and sending) go to the Gmail API on this host, with the token from the user's sign-in.
- Host permission `https://oauth2.googleapis.com/*`: Revoking the token when the user signs out.
- OAuth scope `https://mail.google.com/`: The extension reads, writes and sends mail, and permanently deletes messages when the user empties Trash or Spam or deletes a message already in Trash; the narrower Gmail scopes do not allow permanent deletion.

Remote code: No, I am not using remote code. All code ships in the package; the Content Security Policy allows scripts only from the extension itself.

Data usage, what the extension handles (recommended declarations; all of it stays on the user's computer or goes only to Google):

- Personal communications: email messages and attachments, fetched from Gmail when the user opens them and shown on screen; not stored.
- Personally identifiable information: names and email addresses from the user's own Inbox and Sent headers, kept in a local address book for suggestions while writing.
- Authentication information: the Google access token, kept in the browser's session storage and cleared when the browser closes, and the address of the Google account signed in, kept in local storage until Sign out.

Certify: data is not sold, not used for purposes unrelated to the single purpose, and not used for creditworthiness or lending. No analytics, telemetry or advertising.

Privacy policy URL: https://github.com/gdevic/baltazar-mail-2/blob/main/PRIVACY.md

## Store listing (English)

The description names features in sentences, not lists: the Chrome Web Store rejects runs of format or product names as keyword spam.

Extension name: Baltazar Mail for Gmail (from the manifest)

Short description (from the manifest): A fast, ad-free client for Gmail that signs in with your Google account. Not affiliated with Google.

Description:

> Baltazar Mail for Gmail is a fast, clean, ad-free way to read and write your Gmail. It opens in its own tab; click Sign in with Google once, and Google's own page asks which account and what permission, then the extension keeps you signed in while the browser does.
>
> Reading: a three-column or stacked layout with resizable panes, sixteen light and dark palettes in different hues with a contrast slider, an adjustable text size, and a dark reading pane that darkens messages to match while keeping their hues and leaving images untouched. Your labels are the folders, nested as you named them, and a Starred view collects starred mail from every one of them but Spam and Trash.
>
> Mailbox: mark messages read or unread, star, archive, move, delete or report them as spam, one at a time or as a selection, with multi-level undo and redo. Labels can be created, renamed, moved and nested, empty ones deleted, and Trash and Spam emptied, all from a right-click menu.
>
> Search: limited to the open label and the ones nested under it, with matches elsewhere listed below, and simple operators written as in Gmail (from:, to:, subject:, has:attachment, is:starred, dates) to narrow it down.
>
> Writing: new messages, replies that keep their thread, and forwards that keep the original's attachments, rich or plain text, inline images, automatic drafts and undo-send. Address suggestions come from your own Inbox and Sent, with automated senders left out.
>
> Attachments open in place: documents, spreadsheets, images and media are previewed without downloading; documents are read inside an isolated sandbox with no access to your session.
>
> Privacy: no server, no analytics, no ads. Your mail goes only between your browser and Google. The source code is public at github.com/gdevic/baltazar-mail-2.
>
> Baltazar Mail for Gmail is an independent project and is not affiliated with, endorsed by or sponsored by Google. Gmail and Google are trademarks of their owner.

Logo, promotional tiles and screenshots: to be regenerated for the Gmail edition (`tools/screenshots.js` draws the Yahoo edition).

Search terms (7 terms, 14 words): gmail; gmail client; email client; webmail; ad-free email; dark mode email; pdf attachment viewer

## Notes for certification

> To test: click the Baltazar Mail for Gmail toolbar button, then Sign in with Google with any Google account (the reviewer's own, or a test account; nothing in the account is changed unless the reviewer moves, deletes or sends mail). Things to try: open a label and a message, search (the ? next to the search box explains the syntax), open an attachment from the strip under a message, write a message to yourself with New message, and open Settings with the gear button, where Sign out revokes the sign-in.
>
> How it works: the extension uses the Gmail API (gmail.googleapis.com) with an OAuth 2.0 token obtained through chrome.identity's web auth flow from Google's own sign-in page; it never sees or stores the password. The token lives in session storage and is renewed silently; the extension never opens Google's window except when the sign-in button is clicked.
>
> No remote code. No analytics or third-party services: an install from this store talks only to Google, apart from images in messages, which load from the senders' own servers when the user's setting allows, as the privacy policy explains. (The GitHub release build, installed with Load unpacked, also checks GitHub once a day for a newer version; that check is switched off for store installs.)
>
> Attachments are parsed by bundled open-source libraries (PDF.js, docx-preview, SheetJS, JSZip, DOMPurify) inside a manifest sandbox page with an opaque origin and no extension APIs. Source, security notes and a privacy policy: https://github.com/gdevic/baltazar-mail-2
