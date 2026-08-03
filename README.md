# 💬 Group Chat

A no-login group chat with **persistent history**. Pick a display name, create or
join a group by shareable link, chat live, and leave any time — no accounts.

- **No sign-up / no login.** Just pick a display name in the browser.
- **Create a group**, get a shareable link/code — anyone with it can join.
- **Optional per-group passcode** — set one when creating; joiners must enter it.
- **Live messages** (instant, no refresh) with a live member list.
- **Rich text like Slack** — clickable links, `*bold*`, `_italic_`, `~strike~`,
  `` `code` ``, code blocks and quotes. See [Message formatting](#message-formatting).
- **Full history is saved** per group and shown to anyone who joins later.
- **Leave any time** — just hit back; rejoin later with the same link.
- **Installable (PWA)** — install to a phone home screen or desktop and it opens
  like a native app; the shell works offline. See [PWA](#pwa-installable-app).
- **Apple-style design, with a light/dark switch** — an iOS-inspired look that
  follows your system setting by default, or pin Light/Dark yourself with the
  toggle. See [Theme](#theme-light--dark).
- **Admin dashboard** — an authenticated view of every group and transcript.
  See [Admin dashboard](#admin-dashboard).

There are **two deployments** in this repo — pick one:

| | Where it runs | What you set up |
|---|---|---|
| **A. GitHub Pages + Firebase** (`docs/`) | Static site on GitHub Pages; live data in Cloud Firestore | A free Firebase project |
| **B. Cloudflare Workers** (`src/`, `public/`) | Everything on one Cloudflare Worker | A free Cloudflare account |

Both are free. **A** hosts the page on GitHub itself (uses Firebase for the
realtime/storage a static host can't do). **B** is a single all-in-one deploy.

---

## A. Deploy on GitHub Pages + Firebase

The site in `docs/` is a static app that talks directly to **Cloud Firestore**
for live messages, history, and presence — so GitHub Pages can host all of it.

### 1. Create a free Firebase project
1. Go to **https://console.firebase.google.com** → **Add project** (the free
   *Spark* plan is enough; no card required).
2. In the project, open **Build → Firestore Database → Create database**, start
   in **Production mode**, and pick a location.
3. Add a **Web app**: Project Overview → the **`</>`** icon → register the app.
   Firebase shows you a `firebaseConfig` object — keep it handy.

### 2. Add your config
Paste that `firebaseConfig` into **`docs/firebase-config.js`** (replace the
`PASTE_…` placeholders). These values aren't secret — Firebase web config is
meant to ship to the browser; your **Security Rules** are what protect the data.
(GitHub may flag the `apiKey` — see
[About that "Google API Key" alert](#about-that-google-api-key-alert) below.)

### 3. Set the security rules
In the Firebase Console → **Firestore Database → Rules**, replace the contents
with the rules from **[`firestore.rules`](./firestore.rules)** in this repo and
click **Publish**. (Or, with the Firebase CLI: `firebase deploy --only firestore:rules`.)

These rules keep the no-login flow working while locking down the data shape:
group name/passcode are write-once, messages and presence are size-limited, and
nothing already written can be edited or deleted.

### 4. Restrict your API key (recommended)
Because the key ships to browsers, lock it to your own site so it can't be
reused elsewhere:

1. Go to **https://console.cloud.google.com/apis/credentials** and pick your
   Firebase project (top-left project selector).
2. Under **API Keys**, click the one named **“Browser key (auto created by
   Firebase)”**.
3. **Application restrictions** → choose **Websites** → **Add** these referrers:
   - `https://<your-github-username>.github.io/*`
   - `http://localhost:*` *(only if you want to run it locally too)*
4. **Save.** Changes can take a few minutes to take effect.

This makes the key unusable from anyone else's site. Combined with the rules in
step 3, that's the real security model for a static app.

### 5. Turn on GitHub Pages
In your GitHub repo: **Settings → Pages → Build and deployment**:
- **Source:** *Deploy from a branch*
- **Branch:** your branch (e.g. `main`) and folder **`/docs`** → **Save**.

GitHub gives you a URL like `https://<you>.github.io/<repo>/`. Open it — if the
config is missing you'll see a setup screen; once it's filled in you get the
chat. Share the URL. Every push to that branch redeploys automatically.

> **Try it locally first (optional):** any static server works, e.g.
> `npx serve docs`, then open the printed URL.

### About that "Google API Key" alert

After you commit your config, GitHub secret scanning will likely email you:
*"Google API Key detected in docs/firebase-config.js."* **This is expected, and
it is not a leaked credential.**

- A Firebase **web** API key is a *project identifier*, not a password. It
  grants **no** data access by itself — Google
  [documents that it's safe to commit](https://firebase.google.com/docs/projects/api-keys).
  GitHub flags it because Google uses the same key format for billable APIs
  (Maps, Cloud), where a key *can* be abused.
- **It cannot be made private.** Every visitor's browser must download this
  config for the app to run. Removing it from the repo (e.g. injecting it at
  build time) only silences the scanner — the key is still public in the
  deployed page. There's no way around that for a static, serverless app.
- **What actually protects you** is what you already set up: the **Security
  Rules** (step 3) control all data access, and the **key restrictions**
  (step 4) stop the key working from anyone else's domain.

**What to do:** complete step 4 if you haven't, then dismiss the GitHub alert
(**Security → Secret scanning → the alert → Dismiss →** *"Won't fix"* or
*"False positive"*). Rotating the key isn't necessary — a new one would be just
as public.

> **Note:** none of this applies to a Firebase **service account** JSON or
> private key. Those *are* real secrets — never commit one. This project doesn't
> use or need them.

---

## B. Deploy on Cloudflare Workers

The all-in-one version. One Worker serves the frontend, relays live messages
over WebSockets, and stores each group's history in its own SQLite database
(via a Durable Object) — no separate database to sign up for.

```bash
npm install
npm run dev            # try it locally at http://localhost:8787

npx wrangler login     # free Cloudflare account (opens a browser once)
npm run deploy         # prints your live https://…workers.dev URL
```

> **Free tier:** uses **SQLite-backed Durable Objects**, included in the
> Cloudflare Workers **free plan**. Rename the app / URL by changing `"name"`
> in `wrangler.jsonc`.

**How it works:** `src/index.js` is the Worker + a `ChatRoom` Durable Object
(one instance per group code) that holds the live WebSocket connections and the
message history. `public/` is the frontend.

---

## Theme (light & dark)

The design follows an iOS/macOS look (SF fonts, iOS system colors, frosted
translucent bars, iMessage-style bubbles) and comes in matching light and dark
versions.

By default it follows your **device/browser setting** automatically. To
override that, tap the theme button (🌗/☀️/🌙 — top-right of the landing card,
or in the room and admin headers) to cycle **Auto → Light → Dark → Auto**. Your
choice is remembered in that browser and applies immediately, regardless of
what your OS is set to.

There's no flash of the wrong theme on load: a small inline script in each
page's `<head>` applies a saved choice before the page paints. Implementation
is `theme.js` (identical in both builds) plus the `[data-theme]` CSS overrides
in `styles.css`.

## PWA (installable app)

Both builds ship a web app manifest, icons, and a service worker, so the app is
installable and its shell loads offline.

- **Android / desktop Chrome & Edge:** an **⬇️ Install app** button appears on
  the landing page (the browser also offers its own install option).
- **iOS Safari:** **Share → Add to Home Screen** (iOS never shows an automatic
  prompt).

Once installed it runs standalone — no browser chrome, its own icon, and the
app shell opens instantly even with no connection.

**What works offline:** the interface itself. Messages are live data, so
sending and receiving still need a connection — the service worker deliberately
never caches Firestore traffic, so you are never shown stale messages.

Files: `manifest.webmanifest`, `sw.js`, `pwa.js`, `icons/` in each build.
Icons are generated by `node tools/make-icons.mjs` (no image dependencies).
After changing anything in the app shell, bump `CACHE` in `sw.js` so clients
pick the new version up.

## Admin dashboard

`admin.html` lists every group ever created — name, code, message count,
created/last-activity times, whether it has a passcode — and can open any
group's full transcript read-only.

> **The URL is not the protection.** Anyone can read the site's JavaScript and
> find the path, so the dashboard is guarded by Firebase Authentication plus
> Firestore rules: listing groups requires a signed-in user whose UID has a
> document in the `admins` collection, which only you can create from the
> Firebase Console. Someone who finds the page sees a login form, and even with
> a valid non-admin account every query is refused by the server.

### Setting up your admin account (one time)

1. **Firebase Console → Build → Authentication → Get started**, enable the
   **Email/Password** provider.
2. **Authentication → Users → Add user**: enter your email and a strong
   password. Copy the **User UID** shown in the list.
3. **Firestore Database → Start collection**, collection ID **`admins`**.
   Create a document whose **Document ID is exactly that UID**, with any field
   (e.g. `note` = `admin`). Save.
4. Make sure the rules from [`firestore.rules`](./firestore.rules) are
   published — they contain the `isAdmin()` check.
5. Visit **`https://<you>.github.io/<repo>/admin.html`** and sign in.

To add another admin, repeat steps 2–3. To revoke one, delete their document
from `admins` (or their account) — access stops immediately.

The dashboard is **read-only**: the rules forbid editing or deleting messages
and groups, for admins too.

## Message formatting

Messages support Slack-style rich text. Both deployments share the same
formatter (`docs/format.js` and `public/format.js`, kept identical).

| Type this | You get |
|---|---|
| `https://example.com` | a clickable link (auto-detected, opens in a new tab) |
| `www.example.com` | a clickable link |
| `bob@example.com` | a clickable email link |
| `*bold*` | **bold** |
| `_italic_` | *italic* |
| `~struck~` | ~~struck~~ |
| `` `code` `` | inline `code` |
| ` ```…``` ` | a code block |
| `> quoted` | a quoted line |

A small set of inline HTML tags also renders: `<b> <strong> <i> <em> <u> <s>
<del> <code> <br>`.

**Why only those tags.** Message bodies are untrusted — anyone in a group can
send one — so rendering arbitrary HTML would let a member run JavaScript in
everyone else's browser (stealing their session or messages). Instead, every
message is escaped first and only the whitelisted tags above are re-enabled,
re-emitted by name with **all attributes discarded**. So `<script>`,
`<iframe>`, `<img onerror=…>`, `style="…"` and `on*` handlers can't get
through — they show up as plain text. URLs are only ever linked as `http`,
`https`, or `mailto`, so `javascript:` links are impossible too.

Formatting is display-only: the raw text you typed is what gets stored.

## Notes & limits (both versions)

- **No login means no identity:** names aren't reserved. Without a passcode,
  anyone with a group's link can read and post.
- **Passcodes** are stored only as a salted SHA-256 hash (salted with the group
  code), never in plaintext.
  - On **Cloudflare (B)** the passcode is checked **server-side** — a wrong
    passcode never receives any history.
  - On **GitHub Pages + Firebase (A)** there is no server, so the passcode is a
    **client-side gate**: it keeps casual users out of the UI, but the data is
    technically readable by someone who bypasses the app and queries Firestore
    directly. Good for casual privacy, not for high-stakes secrets. (For a true
    wall you'd add Firebase Authentication.)
- **Group codes can't be enumerated.** Rules allow looking a group up by code
  but only an admin may list the collection, so nobody can discover groups they
  weren't invited to.
- **The admin dashboard exists only in the GitHub Pages / Firebase build (A).**
  The Cloudflare build (B) has the PWA support but no admin view.
- **The Firebase config in `docs/` is public by design** — see
  [About that "Google API Key" alert](#about-that-google-api-key-alert). No real
  secrets (service accounts, private keys) are used anywhere in this project.
- Each joiner loads the most recent **500** messages; older history stays stored.
- Messages are capped at 4000 characters; names at 40.
