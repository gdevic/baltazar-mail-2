# Yahoo Mail ws/v3 protocol, as used by the n8 web client

Derived from a captured Edge session on 2026-10-30. Everything here is undocumented and may change without notice; keep all of it behind one adapter module.

## Transport

All mailbox operations go through one endpoint: `POST https://mail.yahoo.com/c/ws/v3/batch`. The `/c/` prefix is a same-origin proxy in front of `apis.mail.yahoo.com`, which is what makes the calls work from the page with ordinary session cookies and no CORS.

Query parameters on every batch call: `name=<operation>` (telemetry label, see list below), `appId=<from bootstrap, YMailCLDNovation on this shard>`, `wssid=<token>`, `ymreqid=<uuid>`, `nonblocking=true`. The web UI also sends `hash=<8 hex>`, stable per operation template; verified unnecessary, calls without it succeed.

Body: `multipart/form-data` with a single field `batchJson` containing the JSON envelope below. Auth is the browser session cookies plus `wssid`, an anti-CSRF token tied to the session. Attachment previews and downloads go directly to `https://cloud-apis.mail.yahoo.com/ws/v3/mailboxes/@.id==<mailboxId>/messages/@.id==<msgId>/content/parts/@.id==<partId>/thumbnail?size=552w&pid=<partId>&downloadWhenThumbnailFails=true&appid=YMailNorrin`, and `.../refresh` answers 307 with a signed URL.

## Batch envelope

```json
{
  "requests": [
    {
      "id": "GetMessageGroupList",
      "uri": "/ws/v3/mailboxes/@.id==<mailboxId>/messages/@.select==q?q=...",
      "method": "GET",
      "payloadType": "embedded",
      "payload": { },
      "suppressResponse": false,
      "filters": { "select": { "<alias>": "$.path.in.response" } },
      "requests": [ ]
    }
  ],
  "responseType": "json"
}
```

Inner requests may carry nested `requests` that run after the parent, with `filters.select` extracting values from the parent response and `payload` referencing them as `$..`-style placeholders. The UI uses this to chain "save draft, then move to Sent, then set answered flag" in one round trip. `payloadType` is `embedded` for inline JSON and `multipart` for `payloadParts` (used by save/send).

Response:

```json
{
  "result": {
    "responses": [ { "id": "...", "httpCode": 200, "headers": [ ], "response": { "result": { } } } ],
    "status": { "failedRequests": [ ], "successRequests": [ { "id": "...", "httpCode": 200, "latency": 0.0 } ] }
  },
  "error": null
}
```

Mutations return `httpCode` and an empty `responseString` rather than a `response` object.

## Operations observed

| name | inner method and URI | payload | median ms |
|---|---|---|---|
| `mailbox.sync` | GET `.../mailboxes/@.id==<mb>/folders` (verified: returns the same folders array) | none | 164 |
| `messageGroups.getList` | GET `.../messages/@.select==q?q=<query>` | none | 318 |
| `messages.prefetchGetBodiesFull` | GET `.../messages/@.id==<msg>/content/simplebody/full` | none | 328 |
| `messages.readFlagUpdate` | POST `.../messages/@.select==q?q=id:(<msg>)` | `{"message":{"flags":{"read":bool}}}` | 259 |
| `messages.starFlagUpdate` | POST same | `{"message":{"flags":{"flagged":bool}}}` | 293 |
| `messages.move` | POST same | `{"message":{"folder":{"id":"<folderId>"}}}` | 373 |
| `messages.delete` | DELETE `.../messages/@.select==q?q=id:(<msg>)` | none | 271 |
| `messages.saveV3` | POST `.../messages?totalAttachments=0&uploadCount=0`, multipart | message + simpleBody.html | 632 |
| `messages.saveAndSend` | same as save, plus chained move-to-Sent and `answered`/`forwarded` flag update | same | 3556 |
| `unseenCount.reset` | POST `.../decos/@.id==<decoId>` | `{"id":"...","counts":[{"accountId":"1","unseen":0}]}` | 166 |

Multiple ids can go in one `q=id:(a,b,c)` selector; the UI numbers inner requests `UnifiedUpdateMessage_0`, `_1` and so on when it fans out instead.

## List query language

Boolean behaviour (measured 2026-10-31 with set arithmetic on live results): several `keyword:` terms are always ORed, with or without `AND`, `OR` or parentheses (two words with 126 and 50 hits and 27 in common: `keyword:a keyword:b` returns all 149). A quoted keyword is an exact adjacent phrase (`keyword:"first last"` matched 49 messages, `keyword:"last first"` none). Field filters AND with each other and with the keyword group: `from:("x")`, `to:("x")` (to and cc), `subject:"x"`, `has:attachment`, `is:flagged`, `is:unread`, `is:read`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`, `folderId:`, and `id:(a OR b ...)`. Negation works only for `-has:attachment`, `-is:flagged`, `-is:read`, `-folderId:`; `-keyword:`, `NOT keyword:`, `-from:`, `-subject:` fail with ET-5006. `after:` needs dashes (slashes give EC-4001); `subject:("x")` does not filter. `id:(...)` with a keyword returns exactly the intersection, also with 500 ids (17 KB query, about 350 ms), which is how the client evaluates AND and NOT (`ext/query.js`).

Folder sets: `folderId:(a OR b OR c)` selects several folders (verified with 217 ids, about 450 ms). Exclusion needs one term per folder, `-folderId:a -folderId:b`; `-folderId:(a OR b)` and `NOT (...)` do not exclude.

`is:flagged` selects starred messages across all folders; `-folderType:(TRASH)-folderType:(BULK)` excludes Trash and Spam (verified 2026-10-31); the client adds it to every search not limited to chosen folders (all mail, other folders, contact history).

`q=folderId:<id> -folderType:(SYNC)-folderType:(INVISIBLE) count:100 offset:0 -sort:date`

`-sort:date` is descending. Paging is by `offset`. Free-text search uses the same endpoint with `keyword:<term>` and no `folderId` (`count:20 offset:0 -sort:date keyword:Z80`, response `query.type` is `S` instead of `L`); a `folderId:` can be added to scope it. The response carries `query.token` and `query.nextModSeq`, which allow incremental refresh of an already-loaded list instead of re-fetching it.

## Data model

Message (as returned in lists and bodies): `id` (27-char opaque, the handle for every mutation), `immutableid`, `uid`, `conversationId`, `csid`, `modSeq`, `size`, `snippet` (about 500 chars of body text, enough for a preview pane without a body fetch), `attachmentCount`, `attachments[]`, `flags {read, flagged, ham, recent, answered, forwarded}`, `headers {subject, from[], to[], cc[], bcc[], replyTo[], date (epoch seconds as string), mimeDate, internalDate, messageIdRfc822, inReplyTo, referenceList[], mimeType}`, `folder {id, name, types[], unread, total, highestModSeq}`, `decos[] {id, type}` (classification tags, also where ads and "smart view" markers live), `inReplyTo {replied, messageReference.id}`.

Body: `simpleBody.html` (server-sanitised HTML, remote images rewritten through Yahoo's proxy), `simpleBody.htmlAnnotations[]`, `simpleBody.attachments[] {partId, filename, size, type, subtype, contentId, disposition, downloadUrl, thumbnailUrl, textExtractionUrl}`.

Folder: `id` (small decimal string; 1 Inbox, 3 Sent, 4 Trash and 371 seen in this capture; the rest to be read from the folder list), `name`, `types[]` (`INBOX`, `SENT`, `TRASH`, `SYNC`, `INVISIBLE`, custom), `unread`, `total`, `size`, `uidNext`, `uidValidity`, `highestModSeq`, `acctId`. The captured mailbox reports 217 folders, most of which carry `SYNC` or `INVISIBLE` types and are filtered out of the list query.

## Folders (verified 2026-11-02, from the web client)

A folder's `name` is its whole path, segments joined with `/`. Subfolders of a system folder use its name as the first segment (`Inbox/Receipts`, type `USER`); Yahoo's client offers Inbox as a parent.

- Create: `folders.create`, PUT `.../mailboxes/@.id==<mb>/folders`, payload `{"folder":{"types":["USER"],"acctId":"1","name":"Parent/New"}}`. HTTP 201; the result is the new folder (`id`, `name`, `types`, `unread`, `total`, `acctId`, ...).
- Rename and move are one call: `folders.rename`, POST `.../folders/<id>` (no `@.id==`), inner id `RenameFolders00_<id>`, payload `{"folder":{"name":"<new path>"}}`. HTTP 200 with the updated folder. Moving to the top level drops the parent segments.
- Mark a folder read: `messages.readFlagUpdate`, POST `.../messages/@.select==q?q=folderId:<id> count:<unread> offset:0 is:unread acctId:<acct>&async=true`, payload `{"message":{"flags":{"read":true}}}`. HTTP 202 with `result.task` (`id` like `t182533`, `status` `PENDING`); `task.status`, GET `.../tasks/@.id==<taskId>`, reports `PENDING` until `COMPLETED`.
- Delete a folder: `folders.delete`, DELETE `.../folders/@.id==<id>`, inner id `DeleteFolders`. HTTP 204. Yahoo's client deletes a subfolder before its parent. A folder that is already gone answers HTTP 400 `EC-4001` with `validationErrors: ["ID"]`; Yahoo's own folder list lagged a deletion in testing, and its client sent the same delete again and got that error.
- Empty a folder (Trash, Spam): `messages.delete`, DELETE `.../messages/@.select==q?q=folderId:<id> count:<total> acctId:<acct>&async=true`. HTTP 202 with a task, followed with `task.status` as above (270 messages took about 5 s).
- Folder ids are decimal strings; new folders got five-digit ids (33003 and up).

## New-mail detection

No push channel exists. The UI calls `mailbox.sync` periodically (10 calls in a short session) and compares each folder's `highestModSeq` and `unread` to the last seen values; on a change it re-runs `messageGroups.getList` for the visible folder. At 164 ms per poll this is cheap enough to run every 15 to 30 s.

## Bootstrap

Verified: `GET https://mail.yahoo.com/` with session cookies returns about 1.5 MB of HTML (1.1 s) containing an inline `window.AppBootstrapData = {...}` object. Three regexes give everything needed: `"mailWssid":"<wssid>"`, `"appId":"<appId>"`, and `"primaryMailbox":{..."id":"<mailboxId>"...}`. The mailbox id is a 90-character opaque string. A signed-out session returns the marketing landing page instead (no `AppBootstrapData`), which is the signal to send the user to sign in. On a 401 or 403 from batch, re-run bootstrap; if that fails the session has expired and the user signs in again at mail.yahoo.com.

## Measured latencies (from inside the page, 2026-10-30)

Folder list 161 ms, inbox list of 100 messages 227 ms, full body 150 ms, whole-mailbox search 229 ms, flag update 264 ms (HTTP 204). Search returns subjects with `^_term^_` markers around hits.

## Open items

- Incremental list refresh using `query.token` / `nextModSeq`.

## Compose, drafts and send (verified live 2026-10-30, from the client bundle)

Accounts: `GET /ws/v3/mailboxes/@.id==<mb>/accounts` returns the primary account and send-as aliases: `id`, `email`, `sendingName`, `isPrimary`, `isSending`, `type` (FREE, ALIAS, DEA), `signature`, `signatureActive`, `replyToAddress`.

Save (draft) and send are one inner request, `SaveMessage`, with `payloadType: "multipart"`:

```json
{ "id": "SaveMessage", "method": "POST", "payloadType": "multipart",
  "uri": "/ws/v3/mailboxes/@.id==<mb>/messages?uploadCount=<files>&totalAttachments=<attachments>",
  "payloadParts": [
    { "partName": "jsonString", "contentType": "application/json", "payload": {
      "actions": { "responseMessage": true },
      "message": { "csid": "<client id, ms epoch>", "newMessage": true,
        "headers": { "subject": "", "from": [{"name":"","email":""}], "replyTo": [..], "to": [..], "cc": [], "bcc": [] },
        "folder": { "id": "<Draft folder id>" }, "flags": { "spam": "false", "read": "true" },
        "inReplyTo": { "messageReference": { "id": "<orig id>" }, "replied": true, "forwarded": false },
        "attachments": [ { "disposition": "attachment", "multipartName": "multipart://<encoded filename>" } ] },
      "simpleBody": { "html": "<div>...</div>" } } },
    { "contentType": "<mime>", "partName": "<encoded filename>", "payloadReference": "multipart://<encoded filename>" }
  ] }
```

`newMessage` is `true` unless replying or forwarding (then `inReplyTo` is set). Plain text goes in `simpleBody.text` instead of `html`. `from` and `replyTo` are arrays; passing an object yields HTTP 500 `ET-5016`. The draft is identified by `csid`; saving again with the same `csid` replaces it. Files travel in the same multipart form as `batchJson`, each as a form field named `encodeURIComponent(filename)`, matching the `multipart://` references. Operation name `messages.saveV3` for a draft save.

Send chains two more requests under the save, using the batch's filter/placeholder mechanism, under operation name `messages.saveAndSend`:

```json
"filters": { "select": { "messageId": "$..message.immutableid", "csid": "$..message.csid", "cid": "$..message.conversationId" } },
"requests": [
  { "id": "GetSimpleBody", "method": "GET", "payloadType": "embedded", "uri": "/ws/v3/mailboxes/@.id==<mb>/messages/@.id==$(messageId)/content/simplebody/full" },
  { "id": "SendMessage", "method": "POST", "payloadType": "embedded", "uri": "/ws/v3/mailboxes/@.id==<mb>/messages/@.id==$(messageId)/send",
    "payload": { "csid": "$(csid)", "destinationFolder": { "id": "<Sent folder id>" } },
    "requests": [ { "id": "UpdateMessages", "method": "POST", "payloadType": "embedded", "uri": "/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=id:(<orig id>)", "payload": { "message": { "flags": { "answered": true, "forwarded": false } } } } ] }
]
```

The `UpdateMessages` child is only added for replies and forwards. Measured: 829 ms without attachment, 812 ms with a 22-byte one. Search syntax for header fields: `subject:"test message"`.

## Spam, forwarded attachments, person search (verified 2026-10-30)

Spam and not spam in Yahoo's client are plain moves: to the folder of type BULK, and back to INBOX. No flag update accompanies them; the server learns from the move.

An attachment of another message is forwarded by reference, copied server-side without a download: `{ "disposition": "attachment", "contentId": "<cid>", "messageReference": { "id": "<orig message id>", "pid": "<partId>" } }`, counted in `totalAttachments` but not `uploadCount`. The save answers HTTP 206 when some referenced parts were dropped: inline parts referenced this way become plain attachments and the body's `cid:` links do not resolve, so inline images of a quoted original are re-uploaded as new inline parts instead.

Draft saves refer to the parts of the draft's previous save the same way (`messageReference` to the previous draft id), so a large attachment is uploaded once rather than on every autosave. Not yet verified live: whether a save that replaces draft X may copy parts out of X. The client treats an error or HTTP 206 on such a save as a refusal and saves again with every file uploaded; sends always upload.

Not yet verified: what `simplebody/full` returns for a message saved as plain text (whether `simpleBody.text` is set and `html` empty, and the value of `headers.mimeType`). The client reads either as a sign of a plain-text draft, after its own record of the format (by `csid`) for drafts it saved.

`GET .../content/simplebody/full` returns attachment metadata on `message.attachments`; `simpleBody.attachments` is present only for some messages. Each entry has `partId`, `filename`, `size`, `type`, `subtype`, `disposition`, `contentId`, `downloadUrl`, `thumbnailUrl` (server-rendered previews for images and PDFs, cookie-authenticated).

Person search: `(from:("addr") OR to:("addr"))`; `fromEmail:(...)` also exists.

Attachment text: `textExtractionUrl` (`.../content/parts/@.id==<pid>/text?appid=...`) returns `{"result":{"textExtractResult":"..."}}`, the plain text of PDFs, Word documents, HTML and similar. PDF attachments carry no `thumbnailUrl`. `downloadUrl` (`.../parts/@.id==<pid>/refresh`) answers 307 to the file but cannot be fetched by script (`Failed to fetch`, also same-origin); only a top-level navigation follows it. `.../parts/@.id==<pid>/raw` answers 403 (EC-4020).

## Attachment bytes and document preview (verified 2026-10-31)

Message source: `GET https://apis.mail.yahoo.com/ws/v3/mailboxes/@.id==<mb>/messages/@.id==<msg>/content/rawplaintext?appId=<appId>&wssid=<wssid>&ymreqid=<uuid>` returns the full RFC 822 message as `text/plain` (it is what Yahoo's "View raw message" opens). Attachment `partId` values are IMAP body-part numbers (`2`, `3`, `1.2`) into this MIME tree; decoded sizes match the metadata `size` byte for byte. This is the only fetchable source of attachment bytes, so the client fetches it once per message and cuts parts out of it (`ext/mime.js`).

Document converter: attachment metadata carries `documentId` (on `message.attachments` in the `simplebody/full` response and in list results). `POST /c/ws/v3/batch?name=document.fetch` with HTTP header `docs-document-id: <documentId>` and inner request `{id:"FetchDocument", uri:"/ws/docpreview/v2/fetch", method:"POST", payloadType:"embedded", payload:{start_page, end_page, retryCount}}` returns `{code, statuscode, info:{num_pages, dimension:{w,h}, sheetInfo?}, pages:{pageN:{html, css, statuscode, pdfEmbed}}}`. `code` 800 is success, 605/612/621/814 mean still converting (retry with `retryCount` incremented), 813 unsupported type, 816 password protected. Page `statuscode` 700 means ready. `html` is entity-encoded (`&#60;div...`). PDF pages come back as one JPEG `data:` image per page at 96 dpi; Word, Excel and other Office files come back as HTML and CSS (`.aps-page` root), one sheet per page for spreadsheets.
