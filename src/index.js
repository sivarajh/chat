// Group chat backend for Cloudflare Workers.
//
// - The default export is the Worker: it serves the static frontend and routes
//   WebSocket / API traffic to the right group's Durable Object.
// - `ChatRoom` is a Durable Object. There is exactly one instance per group
//   code. It stores the group's full message history in its own SQLite database
//   and fans out live messages to every connected member over WebSockets.
//
// There is no authentication anywhere: a "user" is just a display name that the
// browser sends when it connects. Anyone with the group code can join.

const MAX_NAME_LEN = 40;
const MAX_BODY_LEN = 4000;
const HISTORY_LIMIT = 500; // messages sent to a client when it first connects

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Live chat socket: /ws/<code>
    if (path.startsWith("/ws/")) {
      const code = normalizeCode(decodeURIComponent(path.slice("/ws/".length)));
      if (!code) return new Response("Bad group code", { status: 400 });
      return roomStub(env, code).fetch(request);
    }

    // Room metadata (used by the join screen): /api/room/<code>
    if (path.startsWith("/api/room/")) {
      const code = normalizeCode(decodeURIComponent(path.slice("/api/room/".length)));
      if (!code) return json({ error: "Bad group code" }, 400);
      return roomStub(env, code).fetch(request);
    }

    // Everything else is a static asset (index.html, app.js, styles.css, ...).
    return env.ASSETS.fetch(request);
  },
};

function roomStub(env, code) {
  const id = env.CHAT_ROOM.idFromName(code);
  return env.CHAT_ROOM.get(id);
}

// A group code is lowercase alphanumeric, 3-32 chars. Returns "" if invalid.
function normalizeCode(raw) {
  const code = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9]{3,32}$/.test(code) ? code : "";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Durable Object: one per chat group.
// ---------------------------------------------------------------------------
export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;

    // Create tables on first use. blockConcurrencyWhile makes sure no request
    // is handled until the schema exists.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          sender TEXT    NOT NULL,
          body   TEXT    NOT NULL,
          ts     INTEGER NOT NULL
        );
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          v TEXT
        );
      `);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Metadata request for the join screen.
    if (url.pathname.startsWith("/api/room/")) {
      return json({
        name: this.getMeta("name") || "",
        exists: this.getMeta("name") !== null || this.messageCount() > 0,
        hasPasscode: this.getMeta("pass") !== null,
        messageCount: this.messageCount(),
        memberCount: this.currentMembers().length,
      });
    }

    // The group's code is the last path segment (/ws/<code>). Used as a salt so
    // the same passcode hashes differently across groups.
    const code = url.pathname.split("/").pop() || "";

    // Otherwise this is a WebSocket upgrade.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let name = sanitizeName(url.searchParams.get("name"));
    const groupName = sanitizeName(url.searchParams.get("groupName"), 60);
    const passcode = String(url.searchParams.get("pass") || "");

    // The first person to open a group is its creator: they name it and, if
    // they choose, set a passcode. Both stick for the life of the group.
    const isCreating = groupName && this.getMeta("name") === null;
    if (isCreating) {
      this.setMeta("name", groupName);
      if (passcode) this.setMeta("pass", await hashPass(code, passcode));
    }

    // Validate the passcode for everyone who isn't the creator that just set it.
    const passHash = this.getMeta("pass");
    const authOk =
      isCreating ||
      passHash === null ||
      (passcode !== "" && (await hashPass(code, passcode)) === passHash);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable WebSocket: the DO can sleep between messages without
    // dropping the connection, which keeps it cheap on the free plan.
    this.ctx.acceptWebSocket(server);

    // Reject a wrong/missing passcode: tell the client why, then close. The
    // "rejected" flag keeps the close handler from announcing a phantom leave.
    if (!authOk) {
      server.serializeAttachment({ rejected: true });
      server.send(JSON.stringify({ type: "error", reason: "bad-passcode" }));
      server.close(4001, "Incorrect passcode");
      return new Response(null, { status: 101, webSocket: client });
    }

    server.serializeAttachment({ name });

    // Send this client its starting state: history + who's here + group name.
    server.send(JSON.stringify({
      type: "welcome",
      groupName: this.getMeta("name") || "",
      you: name,
      history: this.recentMessages(),
    }));

    this.broadcastPresence();
    this.broadcastSystem(`${name} joined`, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Incoming message from a connected client.
  webSocketMessage(ws, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "chat") {
      const attachment = ws.deserializeAttachment() || {};
      const sender = attachment.name || "Anonymous";
      const body = String(data.text || "").slice(0, MAX_BODY_LEN).trim();
      if (!body) return;

      const ts = Date.now();
      this.sql.exec(
        "INSERT INTO messages (sender, body, ts) VALUES (?, ?, ?)",
        sender, body, ts
      );
      const id = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;

      this.broadcast({
        type: "message",
        message: { id, sender, body, ts },
      });
      return;
    }

    if (data.type === "rename") {
      const attachment = ws.deserializeAttachment() || {};
      const oldName = attachment.name || "Anonymous";
      const newName = sanitizeName(data.name);
      if (newName === oldName) return;
      ws.serializeAttachment({ name: newName });
      this.broadcastSystem(`${oldName} is now ${newName}`);
      this.broadcastPresence();
      return;
    }
  }

  webSocketClose(ws) {
    this.handleDeparture(ws);
  }

  webSocketError(ws) {
    this.handleDeparture(ws);
  }

  handleDeparture(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.rejected) return; // never joined; nothing to announce
    const name = attachment.name || "Someone";
    // Presence is derived from the live sockets; by the time this fires the
    // socket is already gone from getWebSockets(), so this reflects reality.
    this.broadcastPresence();
    this.broadcastSystem(`${name} left`);
  }

  // --- helpers ------------------------------------------------------------

  broadcast(obj, exclude) {
    const payload = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // Ignore sockets that are mid-teardown.
      }
    }
  }

  broadcastSystem(text, exclude) {
    this.broadcast({ type: "system", text, ts: Date.now() }, exclude);
  }

  broadcastPresence() {
    this.broadcast({ type: "presence", members: this.currentMembers() });
  }

  currentMembers() {
    const names = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.rejected) continue;
      names.push(attachment.name || "Anonymous");
    }
    return names;
  }

  recentMessages() {
    const rows = this.sql.exec(
      "SELECT id, sender, body, ts FROM messages ORDER BY id DESC LIMIT ?",
      HISTORY_LIMIT
    ).toArray();
    return rows.reverse();
  }

  messageCount() {
    return this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n;
  }

  getMeta(key) {
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray();
    return rows.length ? rows[0].v : null;
  }

  setMeta(key, value) {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key, value
    );
  }
}

function sanitizeName(raw, max = MAX_NAME_LEN) {
  const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, max);
  return name || "Anonymous";
}

// Hash a passcode for storage/comparison. The group code is mixed in as a salt
// so identical passcodes across groups don't share a hash. The passcode itself
// is never stored or sent back to clients.
async function hashPass(salt, passcode) {
  const data = new TextEncoder().encode(`${salt}::${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
