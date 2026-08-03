// Manual theme toggle: Auto (follow OS) -> Light -> Dark -> Auto.
//
// The CSS already follows the OS via prefers-color-scheme by default. This
// module lets a visitor pin a choice that overrides it, by setting
// documentElement[data-theme], which docs/styles.css and public/styles.css
// both give priority over the OS setting. The preference is remembered per
// browser (localStorage), not per group.
//
// A synchronous inline snippet in each HTML file's <head> applies any saved
// preference before first paint, so there's no flash of the wrong theme; this
// module wires up the toggle button(s) and keeps the attribute + every button
// on the page in sync afterwards.
//
// A page can have more than one toggle button live in the DOM at once (e.g.
// the landing screen and the room screen both render before either is
// hidden), so every button carrying [data-theme-toggle] is updated together
// whenever any one of them is clicked.
//
// NOTE: docs/theme.js and public/theme.js are intentionally identical so each
// deployment stays self-contained. Keep both in sync when editing.

const KEY = "gc-theme";
const MODES = ["auto", "light", "dark"];
const LABEL = { auto: "🌗 Auto", light: "☀️ Light", dark: "🌙 Dark" };

function readMode() {
  const saved = localStorage.getItem(KEY);
  return MODES.includes(saved) ? saved : "auto";
}

function applyToDocument(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
}

function applyToButtons(mode) {
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.textContent = LABEL[mode];
    btn.setAttribute("aria-label", `Theme: ${mode}. Tap to change.`);
  });
}

// Call once per page. Wires up every element carrying [data-theme-toggle].
export function initThemeToggle() {
  let mode = readMode();
  applyToDocument(mode); // in case the inline pre-paint snippet was absent
  applyToButtons(mode);

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      localStorage.setItem(KEY, mode);
      applyToDocument(mode);
      applyToButtons(mode);
    });
  });
}
