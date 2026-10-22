import { describe, it, expect } from 'vitest';
import { ybit } from '../../utils/ybit.js';

const PALETTE = ['#1B2A4A', '#FF9F5A', '#FFC38F', '#E0703A', '#FFFFFF', '#FF8FB1', '#6BCB77', '#3E8E41', '#C0392B'];
// The pixels are the svg's children (decorative, so no test ids of their own).
const rectangles = (svg) => [...svg.children].map((rectangle) => ({
  x: +rectangle.getAttribute('x'), y: +rectangle.getAttribute('y'), w: +rectangle.getAttribute('width'), h: +rectangle.getAttribute('height'), fill: rectangle.getAttribute('fill'),
}));
// The sprite back as a 20x19 grid of fills ('' = transparent), to compare states pixel by pixel.
function grid(svg) {
  const rows = Array.from({ length: 19 }, () => Array(20).fill(''));
  for (const rectangle of rectangles(svg)) for (let x = rectangle.x; x < rectangle.x + rectangle.w; x++) rows[rectangle.y][x] = rectangle.fill;
  return rows.map((row) => row.join(','));
}

describe('ybit', () => {
  it('returns a crisp, decorative SVG element sized by scale (default 4)', () => {
    const svg = ybit();
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.tagName).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 20 19');
    expect(svg.getAttribute('width')).toBe('80');
    expect(svg.getAttribute('height')).toBe('76');
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.dataset.testid).toBe('ybit');
    expect([...svg.children].every((child) => child.localName === 'rect')).toBe(true);
    expect(ybit('idle', 1).getAttribute('width')).toBe('20');
    expect(ybit('idle', 10).getAttribute('height')).toBe('190');
  });
  it('draws only palette colours, one row high, inside the grid, without overlaps', () => {
    for (const state of ['idle', 'happy', 'blink', 'lookL', 'lookR']) {
      const shapes = rectangles(ybit(state));
      expect(shapes.length).toBeGreaterThan(20);
      const seen = new Set();
      for (const rectangle of shapes) {
        expect(PALETTE).toContain(rectangle.fill);
        expect(rectangle.h).toBe(1);
        expect(rectangle.w).toBeGreaterThanOrEqual(1);
        expect(rectangle.x).toBeGreaterThanOrEqual(0);
        expect(rectangle.x + rectangle.w).toBeLessThanOrEqual(20);
        expect(rectangle.y).toBeGreaterThanOrEqual(0);
        expect(rectangle.y).toBeLessThan(19);
        for (let x = rectangle.x; x < rectangle.x + rectangle.w; x++) { const coordinate = `${x},${rectangle.y}`; expect(seen.has(coordinate)).toBe(false); seen.add(coordinate); }
      }
    }
  });
  it('merges runs: neighbouring rects in a row never share a colour', () => {
    const shapes = rectangles(ybit('happy'));
    for (const firstRectangle of shapes) for (const secondRectangle of shapes) if (firstRectangle !== secondRectangle && firstRectangle.y === secondRectangle.y && firstRectangle.x + firstRectangle.w === secondRectangle.x) expect(firstRectangle.fill).not.toBe(secondRectangle.fill);
  });
  it('has transparent corners and the sprout on top', () => {
    const rows = grid(ybit()).map((row) => row.split(','));
    expect(rows[0][0]).toBe('');
    expect(rows[18][19]).toBe('');
    expect(rows[0][10]).toBe('#3E8E41');
    expect(rows[0][11]).toBe('#6BCB77');
  });
  it('each state draws a different face; unknown states look idle', () => {
    const faces = ['idle', 'happy', 'blink', 'lookL', 'lookR'].map((face) => grid(ybit(face)).join('\n'));
    expect(new Set(faces).size).toBe(5);
    expect(grid(ybit('nonsense')).join('\n')).toBe(faces[0]);
  });
  it('only the face changes between states (rows 8-12)', () => {
    const idle = grid(ybit('idle')), happy = grid(ybit('happy'));
    idle.forEach((row, y) => { if (y < 8 || y > 12) expect(happy[y]).toBe(row); });
  });
  it('looking left/right moves the eyes by one pixel', () => {
    const at = (face) => grid(ybit(face))[9].split(',').indexOf('#1B2A4A', 3); // first eye pixel after the outline
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
