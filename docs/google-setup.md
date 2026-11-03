# Google Cloud setup for Baltazar Mail for Gmail

The Gmail extension signs in with OAuth 2.0, which needs an OAuth client that Google knows about. A store copy carries the project's client id; a copy you build or load yourself needs one of your own, because the client id is tied to the extension id in the redirect address. This page is what it takes.

## 1. A Google Cloud project with the Gmail API

1. Open [console.cloud.google.com](https://console.cloud.google.com/), create a project (any name, such as `baltazar-mail`), and select it.
2. APIs & Services, Library: find **Gmail API** and enable it.

## 2. The OAuth consent screen

1. APIs & Services, OAuth consent screen (Google Auth Platform, Branding). User type **External**. App name, your support email and developer contact email are required; the rest can wait.
2. Scopes: add `https://mail.google.com/`. This is a *restricted* scope: the app can read, write and permanently delete mail, which the extension needs for Empty Trash and for deleting a message from Trash. Google shows an "unverified app" warning on the consent screen until the app passes its verification (see section 6).
3. Audience, Test users: add the Google accounts that may sign in while the app is unverified. Up to 100.

## 3. The OAuth client

1. APIs & Services, Credentials, Create credentials, **OAuth client ID**, type **Web application** (not "Chrome extension": that type only works with `chrome.identity.getAuthToken`, which Edge does not support; the extension uses the web auth flow, which both browsers support).
2. Authorized redirect URIs: one entry per extension id you will use, each of the form `https://<extension id>.chromiumapp.org/`, with the trailing slash. The id of a copy is in the address bar of its mail tab after `chrome-extension://`, and on the extensions page with Developer mode on. See section 4 for keeping it stable.
3. Copy the client id (it ends in `.apps.googleusercontent.com`). No client secret is used: the extension uses the implicit grant, which gives it an access token directly, one hour at a time, renewed silently while the browser holds your Google session.

## 4. Putting the client id into the build

Create `gmail/local.json` (it is ignored by git):

```json
{
  "client_id": "1234567890-abc.apps.googleusercontent.com",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
}
```

`client_id` replaces the placeholder in `gmail/manifest.json` when `node tools/build.js` runs. `key` is optional: it is a public key that pins the extension id, so every unpacked copy built from this key has the same id and therefore the same redirect URI. Without it, the id of an unpacked extension is derived from the folder it was loaded from, and changes when the folder moves. To make a key: pack the built folder once (extensions page, Pack extension, or `chrome --pack-extension=dist/baltazar-mail-gmail`), take the `.pem` file it writes, and put its public part on one line:

```sh
openssl rsa -in baltazar-mail-gmail.pem -pubout -outform DER | openssl base64 -A
```

Then build, load `dist/baltazar-mail-gmail` unpacked, read the id from the extensions page, and add `https://<that id>.chromiumapp.org/` to the client's redirect URIs.

## 5. Signing in

Click the toolbar icon; the sign-in page has one button, **Sign in with Google**. Google asks which account, shows the unverified-app warning while the app is unverified (Advanced, Go to the app), then the permission. The token is kept in the browser's session storage for this extension, and is renewed silently; **Sign out** in Settings revokes it. The extension never opens Google's window by itself: when a silent renewal fails (the Google session ended), the sign-in page comes back and waits for the button.

## 6. Publishing

A store listing needs Google's OAuth verification for the restricted Gmail scope: a brand verification (the app's home page and privacy policy, with the project's domain verified) and a security assessment by a Google-approved assessor (the CASA framework, Tier 2), repeated yearly. Until then the consent screen warns, and only the test users of section 2 can sign in. The stores themselves (Chrome Web Store, Microsoft Edge Add-ons) assign the published copy its own extension id; add that id's redirect URI to the client before publishing, and use the published copy's id for `key` so unpacked copies match it where the store allows.
