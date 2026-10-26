// utils/zip.js: what zipFiles makes, unzipFiles reads back; zips made by other tools (deflated) too.
import { describe, it, expect } from 'vitest';
import { zipFiles, unzipFiles, crc32 } from '../../utils/zip.js';

describe('the zip', () => {
  it('crc32 is the standard one', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('what zipFiles makes, unzipFiles reads back (UTF-8 names and text)', async () => {
    const zip = zipFiles([{ name: 'backup/notes.json', data: '[{"note":"ünïcode — ok"}]' }, { name: 'backup/stars.json', data: '[]' }]);
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]); // "PK"
    const back = await unzipFiles(zip);
    expect([...back.keys()]).toEqual(['backup/notes.json', 'backup/stars.json']);
    expect(back.get('backup/notes.json')).toBe('[{"note":"ünïcode — ok"}]');
  });

  it('reads a deflated zip too (made again by the system\'s own zip tool)', async () => {
    const text = JSON.stringify({ a: 'x'.repeat(2000) });
    const raw = new TextEncoder().encode(text);
    const deflated = new Uint8Array(await new Response(new Response(raw).body.pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    // a stored zip, then its one entry rewritten as deflated (method 8, the compressed size)
    const stored = zipFiles([{ name: 'backup/info.json', data: text }]);
    const name = new TextEncoder().encode('backup/info.json');
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 8, true); local.setUint32(14, crc, true);
    local.setUint32(18, deflated.length, true); local.setUint32(22, raw.length, true); local.setUint16(26, name.length, true);
    const centralDirectory = new DataView(new ArrayBuffer(46));
    centralDirectory.setUint32(0, 0x02014b50, true); centralDirectory.setUint16(10, 8, true); centralDirectory.setUint32(16, crc, true); centralDirectory.setUint32(20, deflated.length, true);
    centralDirectory.setUint32(24, raw.length, true); centralDirectory.setUint16(28, name.length, true); centralDirectory.setUint32(42, 0, true);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
    end.setUint32(12, 46 + name.length, true); end.setUint32(16, 30 + name.length + deflated.length, true);
    const parts = [new Uint8Array(local.buffer), name, deflated, new Uint8Array(centralDirectory.buffer), name, new Uint8Array(end.buffer)];
    const zip = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) { zip.set(part, at); at += part.length; }
    expect(stored.length).toBeGreaterThan(zip.length); // (it did compress)
    expect((await unzipFiles(zip)).get('backup/info.json')).toBe(text);
  });

  it('something that isn\'t a zip is refused', async () => {
    await expect(unzipFiles(new TextEncoder().encode('hello'))).rejects.toThrow();
  });
});
