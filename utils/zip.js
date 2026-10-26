// Zip files, made and read back (stored or deflated entries): the backup's tabazing-backup-<date>.zip (utils/backup.js),
// and the Firefox package (scripts/firefox.js). Nothing here touches the extension's APIs, so Node can run it too.
const MAX_ENTRY = 50 * 1024 * 1024; // an entry bigger than this isn't one of ours (unzipFiles skips it)
const CRC = (() => { const table = new Uint32Array(256); for (let byte = 0; byte < 256; byte++) { let crc = byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; table[byte] = crc >>> 0; } return table; })();
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** A zip of these files ([{ name, data }]: data a string or bytes), stored (not compressed: JSON is small). */
export function zipFiles(files, when = new Date()) {
  const encoder = new TextEncoder();
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true); centralHeader.setUint16(4, 20, true); centralHeader.setUint16(6, 20, true); centralHeader.setUint16(8, 0x0800, true);
    centralHeader.setUint16(10, 0, true); centralHeader.setUint16(12, dosTime, true); centralHeader.setUint16(14, dosDate, true);
    centralHeader.setUint32(16, crc, true); centralHeader.setUint32(20, data.length, true); centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, name.length, true); centralHeader.setUint32(42, offset, true);
    central.push(new Uint8Array(centralHeader.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}
async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The files of a zip: Map(name -> text). Stored and deflated entries (a zip made again by the system's own tool). */
export async function unzipFiles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out = new Map();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip');
    const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true), nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true), local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || size > MAX_ENTRY) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
    if (data) out.set(name, decoder.decode(data));
  }
  return out;
}
