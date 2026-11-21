// Log storage with two backends: the PC's server (/api/logs) and IndexedDB for a phone.
// No DOM; imports cleanly under Node. See docs/mobile-plan.md, phase 1.

// Log names: YYYY-MM-DD_HHmm_game-NN.json (old) or YYYY-MM-DD_HHmm_game-NN_<DEVICE>.json (new).
// Kept in step with server.js; copied rather than imported so this file stays browser-only.
export const LOG_NAME = /^\d{4}-\d{2}-\d{2}_\d{4}_game-(\d{2,})(?:_[A-Za-z0-9-]+)?\.json$/;

// A device name for file names: anything but letters, digits and '-' becomes '-', dashes are
// trimmed and the result is at most 40 characters. Empty -> null (the server uses 'PC').
export function deviceNameOf(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return name || null;
}

// A device name for a phone that has none yet: 'PHONE-' and four random uppercase letters or
// digits (never more than 40 characters once cleaned). rng: () => [0, 1), for tests.
export function suggestDeviceName(rng = Math.random) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let name = 'PHONE-';
  for (let i = 0; i < 4; i++) name += chars[Math.min(chars.length - 1, Math.floor(rng() * chars.length))];
  return name;
}

// The app mode a page load asks for: 'local' for ?mode=local (the phone build), else 'server'.
// A build sets MAHJONG_APP_MODE permanently, so the parameter is only a way to test on the PC.
export function modeFromSearch(search) {
  return new URLSearchParams(search ?? '').get('mode') === 'local' ? 'local' : 'server';
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// The name for a new log, as server.js builds it: local-time stamp, then the next game number
// (1 + the highest NN among existingNames), then the device name.
export function logNameFor(date, existingNames, device) {
  const dev = deviceNameOf(device);
  if (!dev) throw new Error('a device name is needed to name a log');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`;
  let max = 0;
  for (const name of existingNames ?? []) {
    const m = LOG_NAME.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${stamp}_game-${pad(max + 1)}_${dev}.json`;
}

// Oldest first: by date and time, then game number, then the whole name (as server.js sorts).
export function compareLogNames(a, b) {
  const ka = a.slice(0, 15);
  const kb = b.slice(0, 15);
  if (ka !== kb) return ka < kb ? -1 : 1;
  const d = Number(LOG_NAME.exec(a)[1]) - Number(LOG_NAME.exec(b)[1]);
  return d || (a < b ? -1 : a > b ? 1 : 0);
}

// --- server backend: the PC, unchanged ---

export function createServerStore(fetchImpl = globalThis.fetch) {
  return {
    async saveLog(log) {
      const res = await fetchImpl('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log),
      });
      if (res.status !== 201) throw new Error(`saving the log failed (HTTP ${res.status})`);
      return res.json();
    },

    async listLogs() {
      const res = await fetchImpl('/api/logs?details=1');
      if (res.status !== 200) throw new Error(`listing the logs failed (HTTP ${res.status})`);
      return res.json();
    },

    async readLog(name) {
      const res = await fetchImpl(`/api/logs/${encodeURIComponent(name)}`);
      if (res.status !== 200) throw new Error(`reading the log failed (HTTP ${res.status})`);
      return res.json();
    },
  };
}

// --- local backend: IndexedDB on the phone ---

const DB_NAME = 'mahjong-trainer';
const DB_VERSION = 1;
const STORE_NAME = 'logs';

// One entry of the server's GET /api/logs?details=1 list, taken from the stored log.
function detailsOf(name, log) {
  return {
    file: name,
    hasNotes: false, // notes live on the PC only
    startedAt: log?.startedAt ?? null,
    botLevel: log?.settings?.botLevel ?? null,
    dealer: log?.dealer ?? null,
    result: log?.result ?? null,
  };
}

export function createLocalStore({ indexedDB = globalThis.indexedDB, device, now = Date.now } = {}) {
  if (!indexedDB) throw new Error('local log storage needs IndexedDB, which this environment does not have');
  const dev = deviceNameOf(device);
  if (!dev) throw new Error('local log storage needs a device name (set it in the settings)');

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        dbPromise = null; // the next call tries again
        reject(err);
      };
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        fail(err);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME, { keyPath: 'name' });
        }
      };
      req.onblocked = () => fail(new Error('the log database is blocked by another copy of the app; close it and try again'));
      req.onerror = () => fail(req.error ?? new Error('could not open the log database'));
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          try { db.close(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        // Another tab wants to upgrade: close so it can, and reopen on the next use.
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
          dbPromise = null;
        };
        resolve(db);
      };
    });
    return dbPromise;
  }

  // Runs setup(store, ctx, tx) in one transaction and resolves with ctx.result. A failed or
  // aborted transaction (for example a commit that runs out of disk) rejects.
  async function run(mode, setup) {
    const db = await openDb();
    return new Promise((resolveP, rejectP) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, mode);
      } catch (err) {
        rejectP(err);
        return;
      }
      const ctx = {};
      tx.oncomplete = () => resolveP(ctx.result);
      tx.onerror = () => rejectP(tx.error ?? new Error('log database transaction failed'));
      tx.onabort = () => rejectP(tx.error ?? new Error('log database transaction aborted'));
      try {
        setup(tx.objectStore(STORE_NAME), ctx, tx);
      } catch (err) {
        try { tx.abort(); } catch { /* ignore */ }
        rejectP(err);
      }
    });
  }

  return {
    async saveLog(log) {
      const at = now();
      const date = new Date(at);
      const savedAt = new Date(at).toISOString();
      // Names are read and the record written in one transaction, so two saves cannot pick the
      // same number; `add` never overwrites an existing name.
      return run('readwrite', (store, ctx) => {
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          const name = logNameFor(date, keys.result ?? [], dev);
          const added = store.add({ name, log, savedAt, exported: false });
          added.onsuccess = () => {
            ctx.result = { file: name };
          };
        };
      });
    },

    // The same entries as the server's ?details=1 list, in the same order.
    async listLogs() {
      const records = (await run('readonly', (store, ctx) => {
        const all = store.getAll();
        all.onsuccess = () => {
          ctx.result = all.result ?? [];
        };
      })) ?? [];
      return records
        .filter((r) => r && LOG_NAME.test(r.name))
        .map((r) => detailsOf(r.name, r.log))
        .sort((a, b) => compareLogNames(a.file, b.file));
    },

    async readLog(name) {
      const record = await run('readonly', (store, ctx) => {
        const got = store.get(name);
        got.onsuccess = () => {
          ctx.result = got.result ?? null;
        };
      });
      if (!record) throw new Error('reading the log failed (not found)');
      return record.log;
    },

    // Every log at once (one read of the store), in listLogs order: [{ name, log, exported }].
    // Used to pack them for export without a read per log.
    async readAllLogs() {
      const records = (await run('readonly', (store, ctx) => {
        const all = store.getAll();
        all.onsuccess = () => {
          ctx.result = all.result ?? [];
        };
      })) ?? [];
      return records
        .filter((r) => r && LOG_NAME.test(r.name))
        .sort((a, b) => compareLogNames(a.name, b.name))
        .map((r) => ({ name: r.name, log: r.log, exported: Boolean(r.exported) }));
    },

    // Counted with a cursor so the full logs stay unread.
    async unexportedCount() {
      return run('readonly', (store, ctx) => {
        let count = 0;
        ctx.result = 0;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) {
            ctx.result = count;
            return;
          }
          if (!c.value?.exported) count += 1;
          c.continue();
        };
      });
    },

    async markExported(names) {
      const wanted = new Set(names ?? []);
      await run('readwrite', (store) => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          if (wanted.has(c.value.name) && !c.value.exported) c.update({ ...c.value, exported: true });
          c.continue();
        };
      });
    },
  };
}

// 'server' on the PC (no MAHJONG_APP_MODE); 'local' inside the phone app.
export function pickStore({ mode = globalThis.MAHJONG_APP_MODE ?? 'server', ...opts } = {}) {
  return mode === 'local' ? createLocalStore(opts) : createServerStore(opts.fetchImpl);
}
