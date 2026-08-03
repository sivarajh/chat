// Admin dashboard: lists every group and lets an admin read any transcript.
//
// The URL is not the security boundary — anyone can read this file and find it.
// Access is enforced by Firestore rules: listing /groups requires a signed-in
// user with a matching document in /admins, which only the Firebase Console can
// create. A non-admin who opens this page can sign in but every query fails.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, connectFirestoreEmulator, collection, getDocs,
  query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { formatMessage, escapeHtml } from "./format.js";
import { initThemeToggle } from "./theme.js";

const $ = (id) => document.getElementById(id);

initThemeToggle();

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
if (firebaseConfig.emulator) {
  connectFirestoreEmulator(db, firebaseConfig.emulator.host, firebaseConfig.emulator.port);
  if (firebaseConfig.emulator.authPort) {
    connectAuthEmulator(auth, `http://${firebaseConfig.emulator.host}:${firebaseConfig.emulator.authPort}`,
      { disableWarnings: true });
  }
}

const show = (which) => {
  $("login").classList.toggle("hidden", which !== "login");
  $("dash").classList.toggle("hidden", which !== "dash");
};

function setStatus(text, warn = false) {
  const bar = $("dashStatus");
  if (!text) { bar.classList.add("hidden"); return; }
  bar.textContent = text;
  bar.classList.toggle("warn", warn);
  bar.classList.remove("hidden");
}

const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";

// ---------- auth ----------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (err) {
    $("loginError").textContent =
      /invalid|wrong|not-found|credential/i.test(err.code || "")
        ? "Wrong email or password."
        : "Sign-in failed: " + (err.code || err.message);
  }
});

$("signOutBtn").addEventListener("click", () => signOut(auth));
$("refreshBtn").addEventListener("click", () => loadGroups());
$("closeTranscript").addEventListener("click", () => $("transcript").classList.add("hidden"));

onAuthStateChanged(auth, (user) => {
  if (user) {
    show("dash");
    loadGroups();
  } else {
    show("login");
    $("groupRows").innerHTML = "";
    $("transcript").classList.add("hidden");
  }
});

// ---------- data ----------
async function loadGroups() {
  setStatus("Loading groups…");
  $("dashMeta").textContent = auth.currentUser ? auth.currentUser.email : "";

  let snap;
  try {
    snap = await getDocs(collection(db, "groups"));
  } catch (err) {
    // The rules reject `list` for anyone who isn't an admin.
    if ((err.code || "").includes("permission-denied")) {
      setStatus("This account is not an admin. Add its UID to the 'admins' collection in Firebase.", true);
      $("groupRows").innerHTML = "";
      return;
    }
    setStatus("Couldn't load groups: " + (err.code || err.message), true);
    return;
  }

  // Pull each group's message stats. Sequential-ish via Promise.all is fine at
  // the scale this dashboard is meant for.
  const groups = await Promise.all(snap.docs.map(async (d) => {
    const data = d.data() || {};
    let count = 0;
    let last = 0;
    try {
      const msgs = await getDocs(collection(db, "groups", d.id, "messages"));
      count = msgs.size;
      msgs.forEach((m) => { const t = (m.data() || {}).ts || 0; if (t > last) last = t; });
    } catch { /* leave stats at zero if unreadable */ }
    return {
      code: d.id,
      name: data.name || "(unnamed)",
      created: data.createdAt || 0,
      hasPass: !!data.passHash,
      count,
      last,
    };
  }));

  groups.sort((a, b) => (b.last || b.created) - (a.last || a.created));
  renderGroups(groups);

  const totalMsgs = groups.reduce((n, g) => n + g.count, 0);
  setStatus("");
  $("dashMeta").textContent =
    `${auth.currentUser ? auth.currentUser.email + " · " : ""}` +
    `${groups.length} group${groups.length === 1 ? "" : "s"} · ${totalMsgs} message${totalMsgs === 1 ? "" : "s"}`;
}

function renderGroups(groups) {
  const tbody = $("groupRows");
  tbody.innerHTML = "";

  if (!groups.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No groups yet.</td></tr>`;
    return;
  }

  for (const g of groups) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${escapeHtml(g.name)}</td>` +
      `<td><code>${escapeHtml(g.code)}</code></td>` +
      `<td class="num">${g.count}</td>` +
      `<td>${fmtTime(g.created)}</td>` +
      `<td>${fmtTime(g.last)}</td>` +
      `<td>${g.hasPass ? "🔒 Yes" : "—"}</td>` +
      `<td class="row-actions">
         <button class="btn ghost small" data-view="${escapeHtml(g.code)}">View</button>
         <a class="btn ghost small" href="./?g=${encodeURIComponent(g.code)}" target="_blank" rel="noopener">Open</a>
       </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => viewTranscript(btn.getAttribute("data-view")));
  });
}

async function viewTranscript(code) {
  const panel = $("transcript");
  const body = $("transcriptBody");
  $("transcriptTitle").textContent = `Transcript · ${code}`;
  body.innerHTML = "<li class='msg system'>Loading…</li>";
  panel.classList.remove("hidden");

  let snap;
  try {
    snap = await getDocs(query(collection(db, "groups", code, "messages"), orderBy("ts", "asc"), limit(1000)));
  } catch (err) {
    body.innerHTML = `<li class='msg system'>Couldn't load: ${escapeHtml(err.code || err.message)}</li>`;
    return;
  }

  if (snap.empty) {
    body.innerHTML = "<li class='msg system'>No messages in this group.</li>";
    return;
  }

  body.innerHTML = "";
  snap.forEach((d) => {
    const m = d.data() || {};
    const li = document.createElement("li");
    li.className = "msg them";
    li.innerHTML =
      `<div class="meta">${escapeHtml(m.sender || "Anonymous")} · ${fmtTime(m.ts)}</div>` +
      `<div class="bubble">${formatMessage(m.body || "")}</div>`;
    body.appendChild(li);
  });
}
