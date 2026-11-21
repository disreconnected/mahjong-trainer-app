// The phone app's service worker: registration, the "Update ready" banner and the storage request.
// Imported only by the built index.html (tools/build-mobile.js); the PC page never loads it.
// A game is never cut mid-hand: a new version waits until the player taps the banner.
// The helpers are pure so they can be tested under Node, without a DOM.

// The PC's own server (start.bat, port 8377) is not the phone app: no service worker there.
export function isPcServer(hostname, port) {
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false;
  return port === '' || port === '8377';
}

// The banner's text, and the class its element gets (styled in style.css).
export const UPDATE_TEXT = 'Update ready, tap to reload';
export const UPDATE_CLASS = 'pwa-update';

// Whether to register ./sw.js on this page load.
export function shouldRegister({ hasServiceWorker, hostname, port }) {
  return Boolean(hasServiceWorker) && !isPcServer(hostname, port);
}

// The banner is for a new worker that has finished installing while one already controls the page.
export function shouldShowBanner(hasController, newWorker) {
  return Boolean(hasController && newWorker);
}

// The element the banner is made of (a button so it works by tap and by keyboard). null without a
// document, so the module still imports under Node.
export function createBanner(doc, onTap) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = UPDATE_CLASS;
  el.textContent = UPDATE_TEXT;
  el.addEventListener('click', () => {
    el.remove();
    onTap();
  });
  return el;
}

function start() {
  const nav = globalThis.navigator ?? {};
  const location = globalThis.location ?? {};
  const container = nav.serviceWorker;
  if (!shouldRegister({ hasServiceWorker: Boolean(container), hostname: location.hostname, port: location.port ?? '' })) return;

  // Ask the phone to keep the app's storage. The result is ignored either way.
  try { nav.storage?.persist?.(); } catch { /* ignore */ }

  let tapped = false;
  let reloaded = false;

  // The page reloads on controllerchange only after the player tapped the banner.
  container.addEventListener('controllerchange', () => {
    if (!tapped || reloaded) return;
    reloaded = true;
    globalThis.location.reload();
  });

  const showBanner = (worker) => {
    const doc = globalThis.document;
    // Only ever one banner, even if more than one update check reports a waiting worker.
    for (const old of doc?.querySelectorAll?.(`.${UPDATE_CLASS}`) ?? []) old.remove();
    const el = createBanner(doc, () => {
      tapped = true;
      worker.postMessage('skipWaiting');
    });
    if (el) doc.body.appendChild(el);
  };

  const watch = (reg, worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') check(reg);
    });
  };

  const check = (reg) => {
    if (shouldShowBanner(Boolean(container.controller), reg.waiting)) showBanner(reg.waiting);
  };

  container
    .register('./sw.js')
    .then((reg) => {
      check(reg); // a worker may already be waiting from an earlier visit
      watch(reg, reg.installing); // an update that started before this page was listening
      reg.addEventListener('updatefound', () => watch(reg, reg.installing));

      // Back from the background: ask for an update. A failure there is not worth a message.
      globalThis.document?.addEventListener('visibilitychange', () => {
        if (globalThis.document.visibilityState !== 'visible') return;
        try {
          reg.update().catch(() => {});
        } catch { /* ignore */ }
      });
    })
    .catch(() => { /* no service worker here: the app still works online */ });
}

if (typeof document !== 'undefined') start();
