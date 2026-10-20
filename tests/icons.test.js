// The extension's icon (scripts/icons.js draws icons/*.png from icons/icon.svg): every size the manifest names is
// there, at its size, and the SVG source is the one the script draws.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { iconSvg } from '../scripts/icons.js';

const png = (f) => { const b = readFileSync(f); return { sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

describe('the icon', () => {
  it('each size the manifest names is a PNG of that size', () => {
    const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
    for (const set of [m.icons, m.action.default_icon]) {
      for (const [size, file] of Object.entries(set)) expect(png(file), file).toEqual({ sig: 'PNG', w: +size, h: +size });
    }
  });

  it('icons/icon.svg is what scripts/icons.js draws: four tiles, one lit and (large sizes only) ringed', () => {
    expect(readFileSync('icons/icon.svg', 'utf8').replace(/\r\n/g, '\n')).toBe(iconSvg(128) + '\n');
    expect(iconSvg(128).match(/width="32" height="32"/g)).toHaveLength(4);
    expect(iconSvg(128)).toContain('fill="url(#lit)"');
    expect(iconSvg(128)).toMatch(/stroke="#7dd3fc"/);
    expect(iconSvg(16)).not.toMatch(/stroke="#7dd3fc"/); // too small for the ring
  });
});
