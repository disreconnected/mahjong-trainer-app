// Exporting the phone's logs as a zip, and handing it to the share sheet or the downloads folder.
// The file name and the log text match what collect-logs.bat and server.js write, so the zip
// imports on the PC unchanged. DOM use is inside shareOrDownload only. See docs/mobile-plan.md,
// phase 2.
import { makeZip } from './zip.js';
import { deviceNameOf } from './store.js';

const pad = (n) => String(n).padStart(2, '0');

// logs_<DEVICE>_<YYYY-MM-DD_HHMM>.zip, in local time, as collect-logs.js names it.
export function exportFileName(date, device) {
  const dev = deviceNameOf(device);
  if (!dev) throw new Error('exporting the logs needs a device name (set it in the settings)');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `logs_${dev}_${stamp}.zip`;
}

// Packs store records (store.readAllLogs()) into a zip: logs/<name> JSON text, pretty-printed
// like server.js writes it. Logs already exported are left out unless { all: true } (a phone with
// nothing new still sends everything). -> { fileName, bytes, names, total }; names go to
// store.markExported(names).
export async function packRecords(records, { device, date = new Date(), all = false } = {}) {
  const chosen = all ? records : records.filter((r) => !r.exported);
  const files = chosen.map((r) => ({ name: `logs/${r.name}`, data: JSON.stringify(r.log, null, 2) + '\n' }));
  return {
    fileName: exportFileName(date, device),
    bytes: await makeZip(files, date),
    names: chosen.map((r) => r.name),
    total: records.length,
  };
}

// Every log in the phone's store, read once, packed as above.
export async function buildExport(store, { device, now = Date.now, all = false } = {}) {
  return packRecords(await store.readAllLogs(), { device, date: new Date(now()), all });
}

// Sends the zip out: the share sheet where files can be shared (phones), otherwise a download.
// Resolves true once it was shared or downloaded, false when the user cancelled the share.
// env: the globals to use (navigator, File, Blob, URL, document); no DOM outside this function.
export async function shareOrDownload({ fileName, bytes }, env = globalThis) {
  const { navigator, File, Blob, URL: urlApi, document } = env;
  const file = new File([bytes], fileName, { type: 'application/zip' });
  if (navigator && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
    && typeof navigator.share === 'function') {
    try {
      await navigator.share({ files: [file], title: fileName });
      return true;
    } catch (err) {
      // The user closed the sheet: nothing was sent, and that is not an error.
      if (err && err.name === 'AbortError') return false;
      // Android Chrome says it can share files, then refuses .zip (NotAllowedError). A TypeError
      // is the other way share() reports a file it will not take. Both mean: download instead.
      if (!(err && (err.name === 'NotAllowedError' || err instanceof TypeError))) throw err;
    }
  }

  const href = urlApi.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoking straight away can cut the download short in some browsers; give it a moment.
    // (unref, where timers have it, keeps Node from waiting on it.)
    setTimeout(() => urlApi.revokeObjectURL(href), 10_000)?.unref?.();
  }
  return true;
}
