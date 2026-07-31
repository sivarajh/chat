// PWA glue: registers the service worker and offers an "Install app" button
// when the browser says the app is installable.
//
// NOTE: docs/pwa.js and public/pwa.js are intentionally identical so each
// deployment stays self-contained. Keep both in sync when editing.

export function initPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }

  // Chrome/Edge/Android fire this instead of showing their own prompt; stash it
  // and surface our own button. iOS Safari never fires it (install is manual
  // via Share -> Add to Home Screen), so the button simply stays hidden there.
  let deferred = null;
  const btn = document.getElementById("installBtn");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (btn) btn.classList.remove("hidden");
  });

  if (btn) {
    btn.addEventListener("click", async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.classList.add("hidden");
    });
  }

  window.addEventListener("appinstalled", () => {
    deferred = null;
    if (btn) btn.classList.add("hidden");
  });
}
