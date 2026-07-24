# 💬 Group Chat

A no-login group chat with **persistent history**, built to deploy **free** on
Cloudflare Workers.

- **No sign-up / no login.** Pick a display name in the browser and start chatting.
- **Create a group**, get a shareable link/code — anyone with it can join.
- **Optional per-group passcode** — set one when creating a group and joiners must enter it.
- **Live messages** over WebSockets (instant, no refresh).
- **Full history is saved** per group and shown to anyone who joins later.
- **Leave any time** — just hit back; rejoin later with the same link.

Everything runs on a single Cloudflare Worker: static frontend + real-time
backend + storage, no separate database to sign up for.

## How it works

| Piece | What it does |
|-------|--------------|
| `src/index.js` – Worker | Serves the frontend and routes `/ws/<code>` and `/api/room/<code>` to the right group. |
| `src/index.js` – `ChatRoom` Durable Object | One instance **per group** (keyed by its code). Holds a live list of WebSocket connections and stores every message in its own SQLite database. |
| `public/` | The frontend (`index.html`, `app.js`, `styles.css`), served as static assets. |

A group's messages live in that group's Durable Object, so history is kept for
as long as the group exists. Rooms are joined by code (e.g. `/?g=k3p9zq`) and
are **not** publicly listed.

## Run locally

```bash
npm install
npm run dev        # http://localhost:8787
```

Open two browser windows to chat with yourself across "users".

## Deploy for free

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. Log in from your terminal (opens a browser once):

   ```bash
   npx wrangler login
   ```

3. Deploy:

   ```bash
   npm run deploy
   ```

Wrangler prints a live URL like `https://groupchat.<your-subdomain>.workers.dev`.
That's your app — share it.

> **Free tier:** This uses **SQLite-backed Durable Objects**, which are included
> in the Cloudflare Workers **free plan**. No credit card or paid database
> required. (Rename the app by changing `"name"` in `wrangler.jsonc`.)

## Notes & limits

- No login means no identity: names aren't reserved. Without a passcode, anyone
  with a group's link can read and post. Add a passcode for a basic gate — it's
  validated server-side and stored only as a salted SHA-256 hash, never in
  plaintext and never sent back to clients. It's still meant for casual privacy,
  not high-stakes secrets.
- Each joiner loads the most recent 500 messages; older history stays stored.
- Messages are capped at 4000 characters; names at 40.
