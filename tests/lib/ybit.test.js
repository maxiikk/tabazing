import { describe, it, expect } from 'vitest';
import { ybit } from '../../lib/ybit.js';

const PAL = ['#1B2A4A', '#FF9F5A', '#FFC38F', '#E0703A', '#FFFFFF', '#FF8FB1', '#6BCB77', '#3E8E41', '#C0392B'];
// The pixels are the svg's children (decorative, so no test ids of their own).
const rects = (s) => [...s.children].map((r) => ({
  x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'), fill: r.getAttribute('fill'),
}));
// The sprite back as a 20x19 grid of fills ('' = transparent), to compare states pixel by pixel.
function grid(s) {
  const g = Array.from({ length: 19 }, () => Array(20).fill(''));
  for (const r of rects(s)) for (let x = r.x; x < r.x + r.w; x++) g[r.y][x] = r.fill;
  return g.map((row) => row.join(','));
}

describe('ybit', () => {
  it('returns a crisp, decorative SVG element sized by scale (default 4)', () => {
    const s = ybit();
    expect(s.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(s.tagName).toBe('svg');
    expect(s.getAttribute('viewBox')).toBe('0 0 20 19');
    expect(s.getAttribute('width')).toBe('80');
    expect(s.getAttribute('height')).toBe('76');
    expect(s.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(s.getAttribute('aria-hidden')).toBe('true');
    expect(s.dataset.testid).toBe('ybit');
    expect([...s.children].every((c) => c.localName === 'rect')).toBe(true);
    expect(ybit('idle', 1).getAttribute('width')).toBe('20');
    expect(ybit('idle', 10).getAttribute('height')).toBe('190');
  });
  it('draws only palette colours, one row high, inside the grid, without overlaps', () => {
    for (const state of ['idle', 'happy', 'blink', 'lookL', 'lookR']) {
      const rs = rects(ybit(state));
      expect(rs.length).toBeGreaterThan(20);
      const seen = new Set();
      for (const r of rs) {
        expect(PAL).toContain(r.fill);
        expect(r.h).toBe(1);
        expect(r.w).toBeGreaterThanOrEqual(1);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(20);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeLessThan(19);
        for (let x = r.x; x < r.x + r.w; x++) { const k = `${x},${r.y}`; expect(seen.has(k)).toBe(false); seen.add(k); }
      }
    }
  });
  it('merges runs: neighbouring rects in a row never share a colour', () => {
    const rs = rects(ybit('happy'));
    for (const a of rs) for (const b of rs) if (a !== b && a.y === b.y && a.x + a.w === b.x) expect(a.fill).not.toBe(b.fill);
  });
  it('has transparent corners and the sprout on top', () => {
    const g = grid(ybit()).map((r) => r.split(','));
    expect(g[0][0]).toBe('');
    expect(g[18][19]).toBe('');
    expect(g[0][10]).toBe('#3E8E41');
    expect(g[0][11]).toBe('#6BCB77');
  });
  it('each state draws a different face; unknown states look idle', () => {
    const faces = ['idle', 'happy', 'blink', 'lookL', 'lookR'].map((s) => grid(ybit(s)).join('\n'));
    expect(new Set(faces).size).toBe(5);
    expect(grid(ybit('nonsense')).join('\n')).toBe(faces[0]);
  });
  it('only the face changes between states (rows 8-12)', () => {
    const idle = grid(ybit('idle')), happy = grid(ybit('happy'));
    idle.forEach((row, y) => { if (y < 8 || y > 12) expect(happy[y]).toBe(row); });
  });
  it('looking left/right moves the eyes by one pixel', () => {
    const at = (s) => grid(ybit(s))[9].split(',').indexOf('#1B2A4A', 3); // first eye pixel after the outline
    expect(at('lookL')).toBe(at('idle') - 1);
    expect(at('lookR')).toBe(at('idle') + 1);
  });
  it('returns a new element every call, findable by its test id', () => {
    expect(ybit()).not.toBe(ybit());
    document.body.append(ybit('happy'));
    expect(document.querySelectorAll('[data-testid="ybit"]')).toHaveLength(1);
    document.body.replaceChildren();
  });
});
