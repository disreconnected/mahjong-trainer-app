// Minimal ZIP writer and reader. The writer deflates entries when the browser can, and stores
// them otherwise; the reader takes stored and deflated entries and checks each one. No DOM and
// no Node imports (inflate is passed in), so the phone app and the Node tools share it.
// See docs/mobile-plan.md, phase 2.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const VERSION = 20; // 2.0: the oldest version that reads deflate

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// CRC-32 (the zip polynomial) of a string (UTF-8) or a Uint8Array.
export function crc32(data) {
  const bytes = toBytes(data);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return ENCODER.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('zip data must be a Uint8Array or a string');
}

// Forward slashes only, and nothing that could land outside the folder it is written to.
function safeName(raw) {
  const name = String(raw).replace(/\\/g, '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw new Error(`zip entry has an unsafe path: ${raw}`);
  }
  if (name === '') throw new Error('zip entry needs a name');
  return name;
}

// DOS date and time of a Date, in local time (as zip stores them).
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class ByteWriter {
  constructor() {
    this.bytes = new Uint8Array(1024);
    this.view = new DataView(this.bytes.buffer);
    this.pos = 0;
  }

  grow(n) {
    if (this.pos + n <= this.bytes.length) return;
    let size = this.bytes.length;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u16(v) {
    this.grow(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  u32(v) {
    this.grow(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  raw(b) {
    this.grow(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
  }
}

// files: [{ name, data: Uint8Array | string }] -> the bytes of a zip with those entries, using
// forward-slash paths and UTF-8 names. `date` (a Date) becomes each entry's timestamp. Entries
// are deflated when the platform has CompressionStream('deflate-raw') and stored otherwise;
// pass { deflate: false } to always store them.
export async function makeZip(files, date = new Date(), { deflate = true } = {}) {
  const { time, day } = dosStamp(date instanceof Date ? date : new Date(date));
  const canDeflate = deflate && hasDeflateRaw();
  const entries = [];
  for (const f of files) {
    const name = safeName(f.name);
    const data = toBytes(f.data);
    const packed = canDeflate ? await deflateRaw(data) : null;
    // Compression only pays when it actually shrinks the entry.
    const useDeflate = packed !== null && packed !== undefined && packed.length < data.length;
    entries.push({
      name: ENCODER.encode(name),
      data,
      body: useDeflate ? packed : data,
      method: useDeflate ? 8 : 0,
      crc: crc32(data),
    });
  }

  const out = new ByteWriter();
  let offset = 0;
  for (const e of entries) {
    e.offset = offset;
    out.u32(LOCAL_SIG);
    out.u16(VERSION);
    out.u16(FLAG_UTF8);
    out.u16(e.method);
    out.u16(time);
    out.u16(day);
    out.u32(e.crc);
    out.u32(e.body.length);
    out.u32(e.data.length);
    out.u16(e.name.length);
    out.u16(0); // no extra field
    out.raw(e.name);
    out.raw(e.body);
    offset = out.pos;
  }

  const dirStart = out.pos;
  for (const e of entries) {
    out.u32(CENTRAL_SIG);
    out.u16(VERSION); // made by
    out.u16(VERSION); // needed
    out.u16(FLAG_UTF8);
    out.u16(e.method);
    out.u16(time);
    out.u16(day);
    out.u32(e.crc);
    out.u32(e.body.length);
    out.u32(e.data.length);
    out.u16(e.name.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk
    out.u16(0); // internal attributes
    out.u32(0); // external attributes
    out.u32(e.offset);
    out.raw(e.name);
  }
  const dirSize = out.pos - dirStart;

  out.u32(END_SIG);
  out.u16(0); // this disk
  out.u16(0); // disk with the central directory
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(dirSize);
  out.u32(dirStart);
  out.u16(0); // no comment

  return out.bytes.slice(0, out.pos);
}

// Whether the platform can deflate raw streams (browsers and Node 18+ can).
function hasDeflateRaw() {
  if (typeof globalThis.CompressionStream !== 'function') return false;
  try {
    new globalThis.CompressionStream('deflate-raw'); // throws where the format is unknown
    return true;
  } catch {
    return false;
  }
}

// deflateRaw bytes -> deflated bytes, through one CompressionStream.
async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// bytes -> [{ name, data }] for every file entry (folder entries are left out).
// inflateRaw (zlib.inflateRawSync in Node; a browser's DecompressionStream wrapper) is only
// needed for compressed entries. Names get forward slashes; unsafe paths, encrypted entries and
// entries whose CRC-32 or size does not match their data are rejected.
export function readZip(bytes, { inflateRaw } = {}) {
  // A plain Uint8Array throughout: a Buffer (Node's file read) would come back out of the
  // entries, typed differently from what the caller handed in.
  const buf = new Uint8Array(toBytes(bytes));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 22) throw new Error('not a zip file (too short)');

  // The end record is the last one in the file, within 64 KiB of the end (its comment is shorter).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file (no end record)');

  const count = view.getUint16(end + 10, true);
  const dirSize = view.getUint32(end + 12, true);
  const dirStart = view.getUint32(end + 16, true);
  if (dirStart + dirSize > buf.length) throw new Error('not a zip file (central directory outside the file)');

  const out = [];
  let p = dirStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error('not a zip file (bad central directory)');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const name = DECODER.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || name.endsWith('\\')) continue; // a folder: nothing to write
    const safe = safeName(name);
    if (flags & 0x0001) throw new Error(`zip entry ${safe} is encrypted, which this app cannot read`);

    if (localAt + 30 > buf.length || view.getUint32(localAt, true) !== LOCAL_SIG) {
      throw new Error(`not a zip file (bad entry header for ${safe})`);
    }
    const start = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (start + compSize > buf.length) throw new Error(`not a zip file (entry ${safe} runs past the end)`);
    const raw = buf.subarray(start, start + compSize);

    let data;
    if (method === 0) {
      data = raw.slice();
    } else if (method === 8) {
      if (typeof inflateRaw !== 'function') {
        throw new Error(`zip entry ${safe} is compressed and no inflateRaw was given`);
      }
      data = new Uint8Array(toBytes(inflateRaw(raw)));
    } else {
      throw new Error(`zip entry ${safe} uses unsupported compression (method ${method})`);
    }
    // A damaged or truncated file must be caught here, not imported as a broken log.
    if (data.length !== size) throw new Error(`zip entry ${safe} is ${data.length} bytes, not the ${size} recorded`);
    if (crc32(data) !== crc) throw new Error(`zip entry ${safe} fails its CRC check`);
    out.push({ name: safe, data });
  }
  return out;
}
