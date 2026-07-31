// Frontend for the group chat — GitHub Pages + Firebase edition.
//
// There is no server: the browser talks straight to Cloud Firestore for live
// messages, history, and presence. That's what lets the whole app run on a
// static host like GitHub Pages.
//
// Data layout in Firestore:
//   groups/{code}                     -> { name, passHash, createdAt }
//   groups/{code}/messages/{auto}     -> { sender, body, ts }
//   groups/{code}/presence/{clientId} -> { name, lastSeen }
//
// Routing uses a query param: ?g=<code> is a room, no param is the landing page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, setDoc, addDoc,
  onSnapshot, query, orderBy, limit, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { formatMessage, escapeHtml } from "./format.js";
import { initPwa } from "./pwa.js";

const $ = (id) => document.getElementById(id);

// ---------- Firebase init ----------
function isConfigured(cfg) {
  return !!(cfg && typeof cfg.apiKey === "string" && cfg.apiKey &&
    !/PASTE|YOUR_/i.test(cfg.apiKey) && cfg.projectId && !/PASTE|YOUR_/i.test(cfg.projectId));
}
const configured = isConfigured(firebaseConfig);
let db = null;
if (configured) {
  try {
    db = getFirestore(initializeApp(firebaseConfig));
    // Optional: point at a local Firestore emulator for development. Set
    // `emulator: { host, port }` in firebase-config.js to enable; ignored in
    // production where the field is absent.
    if (firebaseConfig.emulator) {
      connectFirestoreEmulator(db, firebaseConfig.emulator.host, firebaseConfig.emulator.port);
    }
  } catch (e) {
    console.error("Firebase init failed", e);
  }
}

// A stable per-tab id so a refresh doesn't create a duplicate presence entry.
let clientId = sessionStorage.getItem("gc_client");
if (!clientId) {
  clientId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  sessionStorage.setItem("gc_client", clientId);
}

const state = {
  code: null,
  name: localStorage.getItem("displayName") || "",
  passcode: "",       // passcode for the current room (kept in memory only)
  unsubs: [],         // active Firestore listeners to tear down on leave
  hb: null,           // presence heartbeat interval
  presRef: null,      // this tab's presence document
  seen: null,         // ids of messages already rendered
};

// Creation details are stashed per-code in sessionStorage rather than the URL,
// so the passcode never ends up in the shareable link or browser history.
function setPending(code, data) {
  sessionStorage.setItem("gc_create_" + code, JSON.stringify(data));
}
function getPending(code) {
  const raw = sessionStorage.getItem("gc_create_" + code);
  return raw ? JSON.parse(raw) : null;
}

// ---------- routing ----------
function currentCode() {
  return new URLSearchParams(location.search).get("g");
}
function baseUrl() {
  // Strip query/hash but keep the path (e.g. /chat/ on GitHub Pages).
  return location.href.split("#")[0].split("?")[0];
}
function goToRoom(code) {
  history.pushState({}, "", baseUrl() + "?g=" + encodeURIComponent(code));
  route();
}
function goHome() {
  history.pushState({}, "", baseUrl());
  route();
}
window.addEventListener("popstate", route);

// ---------- helpers ----------
function normalizeCode(raw) {
  let value = String(raw || "").trim();
  try {
    if (value.includes("://") || value.startsWith("?") || value.includes("?g=")) {
      const url = new URL(value, location.origin);
      value = url.searchParams.get("g") || value;
    }
  } catch { /* not a URL */ }
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function randomCode() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  const buf = new Uint32Array(7);
  crypto.getRandomValues(buf);
  for (const n of buf) out += chars[n % chars.length];
  return out;
}
function ensureName() {
  let name = state.name;
  while (!name || !name.trim()) {
    name = (prompt("Pick a display name to chat as:") || "").trim().slice(0, 40);
  }
  state.name = name;
  localStorage.setItem("displayName", name);
  return name;
}
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
async function hashPass(salt, passcode) {
  const data = new TextEncoder().encode(`${salt}::${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function promptPasscode(message) {
  const v = prompt(message || "This group requires a passcode:");
  return v === null ? null : v;
}

// ---------- screens ----------
function showScreen(which) {
  for (const id of ["setup", "landing", "room"]) {
    $(id).classList.toggle("hidden", id !== which);
  }
}
function setStatus(text, warn = false) {
  const bar = $("statusBar");
  if (!text) { bar.classList.add("hidden"); return; }
  bar.textContent = text;
  bar.classList.toggle("warn", warn);
  bar.classList.remove("hidden");
}

// ---------- message rendering ----------
function addMessage({ sender, body, ts, mine }) {
  const li = document.createElement("li");
  li.className = "msg " + (mine ? "me" : "them");
  li.innerHTML =
    `<div class="meta">${escapeHtml(mine ? "You" : sender)} · ${timeLabel(ts)}</div>` +
    `<div class="bubble">${formatMessage(body)}</div>`;
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
    const passcode = $("newPasscode").value;
    const code = randomCode();
    setPending(code, { groupName, passcode });
    goToRoom(code);
  });

  $("joinBtn").addEventListener("click", () => {
    err.textContent = "";
    if (!state.name) return fail("Enter a display name first.");
    const code = normalizeCode($("joinCode").value);
    if (code.length < 3) return fail("That doesn't look like a valid code.");
    goToRoom(code);
  });

  $("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });
  $("newPasscode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("createBtn").click(); });
  $("newGroupName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("createBtn").click(); });
}

// ---------- room ----------
function initRoomControls() {
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("messageInput");
    const text = input.value.trim();
    if (!text || !db || !state.code) return;
    input.value = "";
    try {
      await addDoc(collection(db, "groups", state.code, "messages"), {
        sender: state.name,
        body: text.slice(0, 4000),
        ts: Date.now(),
      });
    } catch (err) {
      console.error(err);
      setStatus("Message failed to send.", true);
    }
    input.focus();
  });

  $("leaveBtn").addEventListener("click", () => { goHome(); });

  $("copyLink").addEventListener("click", async () => {
    const url = baseUrl() + "?g=" + state.code;
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
    if (state.presRef) setDoc(state.presRef, { name: next, lastSeen: Date.now() }).catch(() => {});
  });
}

// Decide how to connect: creators create the group doc; everyone checks the
// passcode (client-side) before the chat is shown.
async function enterRoom() {
  const groupRef = doc(db, "groups", state.code);
  const pending = getPending(state.code);

  let snap;
  try {
    snap = await getDoc(groupRef);
  } catch (err) {
    console.error(err);
    setStatus("Can't reach Firestore. Check your Firebase config and rules.", true);
    return;
  }

  // Creator path: create the group document if it doesn't exist yet.
  if (pending && !snap.exists()) {
    const passHash = pending.passcode ? await hashPass(state.code, pending.passcode) : "";
    try {
      await setDoc(groupRef, {
        name: pending.groupName || "Untitled group",
        passHash,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error(err);
      setStatus("Couldn't create the group. Check your Firestore rules.", true);
      return;
    }
    state.passcode = pending.passcode || "";
    snap = await getDoc(groupRef);
  } else if (pending) {
    state.passcode = pending.passcode || "";
  }

  const data = snap.exists() ? snap.data() : null;
  const groupName = (data && data.name) || "Group chat";
  const passHash = (data && data.passHash) || "";

  // Passcode gate. Note: on a serverless static host this is a UI-level gate,
  // not a cryptographic wall — see the README's security note.
  if (passHash) {
    let ok = state.passcode && (await hashPass(state.code, state.passcode)) === passHash;
    while (!ok) {
      const entered = promptPasscode();
      if (entered === null) { goHome(); return; }
      ok = (await hashPass(state.code, entered)) === passHash;
      if (ok) state.passcode = entered;
      else alert("Incorrect passcode.");
    }
  }

  $("roomName").textContent = groupName;
  document.title = groupName + " · Chat";
  startListening();
}

function startListening() {
  state.seen = new Set();
  $("messages").innerHTML = "";
  let firstSnapshot = true;

  // --- messages: most recent 500, delivered live ---
  const mq = query(
    collection(db, "groups", state.code, "messages"),
    orderBy("ts", "desc"),
    limit(500)
  );
  const unsubMsgs = onSnapshot(mq, (snap) => {
    // Query is newest-first; reverse to render oldest-first.
    const docs = snap.docs.slice().reverse();
    for (const d of docs) {
      if (state.seen.has(d.id)) continue;
      state.seen.add(d.id);
      const m = d.data();
      addMessage({ sender: m.sender, body: m.body, ts: m.ts, mine: m.sender === state.name });
    }
    if (firstSnapshot && snap.empty) addSystem("No messages yet. Say hi 👋");
    firstSnapshot = false;
    setStatus("");
  }, (err) => {
    console.error(err);
    setStatus("Lost connection to messages.", true);
  });
  state.unsubs.push(unsubMsgs);

  // --- presence: heartbeat every 20s, members = anyone seen in the last 45s ---
  state.presRef = doc(db, "groups", state.code, "presence", clientId);
  const beat = () => setDoc(state.presRef, { name: state.name, lastSeen: Date.now() }).catch(() => {});
  beat();
  state.hb = setInterval(beat, 20000);

  const unsubPres = onSnapshot(collection(db, "groups", state.code, "presence"), (snap) => {
    const now = Date.now();
    const names = snap.docs
      .map((d) => d.data())
      .filter((p) => now - (p.lastSeen || 0) < 45000)
      .map((p) => p.name || "Anonymous");
    renderMembers(names);
  });
  state.unsubs.push(unsubPres);
}

function cleanupRoom() {
  for (const unsub of state.unsubs) { try { unsub(); } catch {} }
  state.unsubs = [];
  if (state.hb) { clearInterval(state.hb); state.hb = null; }
  if (state.presRef) { deleteDoc(state.presRef).catch(() => {}); state.presRef = null; }
  state.seen = null;
}

// Best-effort presence cleanup when the tab closes.
window.addEventListener("beforeunload", () => {
  if (state.presRef) deleteDoc(state.presRef);
});

// ---------- boot ----------
function route() {
  cleanupRoom();
  const code = currentCode();

  if (!code) {
    if (!configured) { showScreen("setup"); document.title = "Group Chat — setup"; return; }
    showScreen("landing");
    $("displayName").value = state.name;
    document.title = "Group Chat";
    return;
  }

  if (!configured) { showScreen("setup"); return; }

  const normalized = normalizeCode(code);
  if (normalized !== state.code) state.passcode = "";
  state.code = normalized;
  ensureName();
  showScreen("room");
  $("roomCode").textContent = state.code;
  $("memberPanel").classList.add("hidden");
  setStatus("Connecting…");
  enterRoom();
}

initPwa();
initLanding();
initRoomControls();
route();
