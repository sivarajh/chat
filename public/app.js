// Frontend for the group chat. No framework — plain DOM + one WebSocket.
//
// Routing is done with a query param: /?g=<code> is a room, / is the landing
// page. Using a query param (not a path) means the static asset server always
// serves index.html and never has to know about rooms.

const $ = (id) => document.getElementById(id);

const state = {
  code: null,
  name: localStorage.getItem("displayName") || "",
  socket: null,
  intentionalClose: false,
  reconnectDelay: 1000,
};

// ---------- routing ----------
function currentCode() {
  return new URLSearchParams(location.search).get("g");
}

function goToRoom(code, groupName) {
  const params = new URLSearchParams({ g: code });
  if (groupName) params.set("new", groupName); // signals "I just created this"
  history.pushState({}, "", "?" + params.toString());
  route();
}

function goHome() {
  history.pushState({}, "", location.pathname);
  route();
}

window.addEventListener("popstate", route);

// ---------- helpers ----------
function normalizeCode(raw) {
  // Accept a raw code or a full invite link.
  let value = String(raw || "").trim();
  try {
    if (value.includes("://") || value.startsWith("?") || value.includes("?g=")) {
      const url = new URL(value, location.origin);
      value = url.searchParams.get("g") || value;
    }
  } catch { /* not a URL, use as-is */ }
  value = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return value;
}

function randomCode() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no easily-confused chars
  let out = "";
  const buf = new Uint32Array(7);
  crypto.getRandomValues(buf);
  for (const n of buf) out += chars[n % chars.length];
  return out;
}

function ensureName() {
  let name = state.name;
  while (!name || !name.trim()) {
    name = prompt("Pick a display name to chat as:") || "";
    name = name.trim().slice(0, 40);
  }
  state.name = name;
  localStorage.setItem("displayName", name);
  return name;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- landing ----------
function initLanding() {
  const nameInput = $("displayName");
  nameInput.value = state.name;
  nameInput.addEventListener("input", () => {
    state.name = nameInput.value.trim().slice(0, 40);
    localStorage.setItem("displayName", state.name);
  });

  const err = $("landingError");
  const fail = (msg) => { err.textContent = msg; };

  $("createBtn").addEventListener("click", () => {
    err.textContent = "";
    if (!state.name) return fail("Enter a display name first.");
    const groupName = $("newGroupName").value.trim().slice(0, 60) || "Untitled group";
    goToRoom(randomCode(), groupName);
  });

  $("joinBtn").addEventListener("click", () => {
    err.textContent = "";
    if (!state.name) return fail("Enter a display name first.");
    const code = normalizeCode($("joinCode").value);
    if (code.length < 3) return fail("That doesn't look like a valid code.");
    goToRoom(code);
  });

  $("joinCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinBtn").click();
  });
  $("newGroupName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("createBtn").click();
  });
}

// ---------- room ----------
function showScreen(which) {
  $("landing").classList.toggle("hidden", which !== "landing");
  $("room").classList.toggle("hidden", which !== "room");
}

function setStatus(text, warn = false) {
  const bar = $("statusBar");
  if (!text) { bar.classList.add("hidden"); return; }
  bar.textContent = text;
  bar.classList.toggle("warn", warn);
  bar.classList.remove("hidden");
}

function addMessage({ sender, body, ts, mine }) {
  const li = document.createElement("li");
  li.className = "msg " + (mine ? "me" : "them");
  li.innerHTML =
    `<div class="meta">${escapeHtml(mine ? "You" : sender)} · ${timeLabel(ts)}</div>` +
    `<div class="bubble">${escapeHtml(body)}</div>`;
  appendAndScroll(li);
}

function addSystem(text) {
  const li = document.createElement("li");
  li.className = "msg system";
  li.textContent = text;
  appendAndScroll(li);
}

function appendAndScroll(node) {
  const list = $("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.appendChild(node);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderMembers(members) {
  $("memberCount").textContent = members.length;
  const list = $("memberList");
  list.innerHTML = "";
  for (const m of members) {
    const li = document.createElement("li");
    li.textContent = m === state.name ? m + " (you)" : m;
    list.appendChild(li);
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ name: state.name });
  const createdName = new URLSearchParams(location.search).get("new");
  if (createdName) params.set("groupName", createdName);

  const socket = new WebSocket(`${proto}://${location.host}/ws/${state.code}?${params}`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.reconnectDelay = 1000;
    setStatus("");
  });

  socket.addEventListener("message", (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === "welcome") {
      $("roomName").textContent = data.groupName || "Group chat";
      document.title = (data.groupName || "Group") + " · Chat";
      $("messages").innerHTML = "";
      for (const m of data.history || []) {
        addMessage({ ...m, mine: m.sender === state.name });
      }
      if (!(data.history || []).length) addSystem("No messages yet. Say hi 👋");
    } else if (data.type === "message") {
      addMessage({ ...data.message, mine: data.message.sender === state.name });
    } else if (data.type === "system") {
      addSystem(data.text);
    } else if (data.type === "presence") {
      renderMembers(data.members || []);
    }
  });

  socket.addEventListener("close", () => {
    if (state.intentionalClose) return;
    setStatus("Reconnecting…", true);
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });
}

function leaveRoom() {
  state.intentionalClose = true;
  if (state.socket) { try { state.socket.close(); } catch {} }
  state.socket = null;
  goHome();
}

function initRoomControls() {
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("messageInput");
    const text = input.value.trim();
    if (!text || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify({ type: "chat", text }));
    input.value = "";
    input.focus();
  });

  $("leaveBtn").addEventListener("click", leaveRoom);

  $("copyLink").addEventListener("click", async () => {
    const url = `${location.origin}/?g=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Invite link copied ✓");
      setTimeout(() => setStatus(""), 1800);
    } catch {
      prompt("Copy this invite link:", url);
    }
  });

  $("membersToggle").addEventListener("click", () => {
    $("memberPanel").classList.toggle("hidden");
  });

  $("changeName").addEventListener("click", () => {
    const next = (prompt("New display name:", state.name) || "").trim().slice(0, 40);
    if (!next || next === state.name) return;
    state.name = next;
    localStorage.setItem("displayName", next);
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "rename", name: next }));
    }
  });
}

// ---------- boot ----------
function route() {
  const code = currentCode();

  // Tear down any existing socket when navigating.
  if (state.socket) {
    state.intentionalClose = true;
    try { state.socket.close(); } catch {}
    state.socket = null;
  }

  if (!code) {
    showScreen("landing");
    $("displayName").value = state.name;
    document.title = "Group Chat";
    return;
  }

  state.code = normalizeCode(code);
  ensureName();
  state.intentionalClose = false;
  showScreen("room");
  $("roomCode").textContent = state.code;
  $("memberPanel").classList.add("hidden");
  setStatus("Connecting…");
  connect();
}

initLanding();
initRoomControls();
route();
