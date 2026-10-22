// Y-bit, drawn from a character grid into a crisp SVG (no image files).
// Y-bit and this sprite code: Copyright (c) 2026 Vajrayu, all rights reserved (see ../../ART-LICENSE.md).

const INK = '#1B2A4A';
const COLORS = { k: INK, o: '#FF9F5A', l: '#FFC38F', d: '#E0703A', w: '#FFFFFF', p: '#FF8FB1', g: '#6BCB77', G: '#3E8E41', m: '#C0392B' };

// A round little courier: orange body, sprout on top, envelope satchel. 20 x 19.
function rows(state) {
  const width = 20, height = 19, centerX = 10, centerY = 9.5, radiusX = 8.5, radiusY = 7.5;
  const grid = Array.from({ length: height }, () => Array(width).fill('.'));
  const inside = (x, y) => { const normalizedX = (x + 0.5 - centerX) / radiusX, normalizedY = (y + 0.5 - centerY) / radiusY; return normalizedX * normalizedX + normalizedY * normalizedY <= 1; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(x, y)) {
    const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    if (edge) grid[y][x] = 'k';
    else { const shade = ((x + 0.5 - centerX) / radiusX) * 0.6 + ((y + 0.5 - centerY) / radiusY) * 0.8; grid[y][x] = shade < -0.5 ? 'l' : shade > 0.45 ? 'd' : 'o'; }
  }
  const set = (points, color) => points.forEach(([x, y]) => { grid[y][x] = color; });
  grid[1][10] = 'G'; grid[0][10] = 'G'; grid[0][11] = 'g'; grid[0][12] = 'g'; grid[1][11] = 'g';
  if (state === 'happy') { set([[4, 9], [5, 8], [6, 9], [12, 9], [13, 8], [14, 9]], 'k'); set([[9, 11], [10, 11]], 'k'); set([[9, 12], [10, 12]], 'm'); }
  else if (state === 'blink') { set([[5, 10], [6, 10], [12, 10], [13, 10]], 'k'); set([[9, 12], [10, 12]], 'k'); }
  else { // 'idle', or 'lookL' / 'lookR': the eyes move one pixel towards where it looks
    const lookOffsetX = state === 'lookL' ? -1 : state === 'lookR' ? 1 : 0;
    const eye = (startX) => [[startX, 8], [startX, 9], [startX, 10], [startX + 1, 8], [startX + 1, 9], [startX + 1, 10]];
    set([...eye(5 + lookOffsetX), ...eye(12 + lookOffsetX)], 'k');
    set(lookOffsetX > 0 ? [[6 + lookOffsetX, 8], [13 + lookOffsetX, 8]] : [[5 + lookOffsetX, 8], [12 + lookOffsetX, 8]], 'w'); set([[9, 12], [10, 12]], 'k');
  }
  set([[3, 11], [4, 11], [14, 11], [15, 11]], 'p');
  set([[6, 18], [7, 18], [12, 18], [13, 18]], 'k');
  ['kkkkk', 'kkwkk', 'kwwwk', 'kkkkk'].forEach((rowPattern, rowOffset) => [...rowPattern].forEach((character, columnOffset) => { grid[12 + rowOffset][15 + columnOffset] = character; }));
  return grid.map((row) => row.join(''));
}

// Returns an <svg> element (built with the DOM, so nothing is parsed from a string).
export function ybit(state = 'idle', scale = 4) {
  const grid = rows(state), SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', `0 0 ${grid[0].length} ${grid.length}`);
  svg.setAttribute('width', String(grid[0].length * scale));
  svg.setAttribute('height', String(grid.length * scale));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.testid = 'ybit';
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const character = row[x];
      if (!COLORS[character]) { x++; continue; }
      let endX = x; while (endX < row.length && row[endX] === character) endX++;
      const rectangle = document.createElementNS(SVG_NAMESPACE, 'rect');
      rectangle.setAttribute('x', x); rectangle.setAttribute('y', y); rectangle.setAttribute('width', endX - x); rectangle.setAttribute('height', 1); rectangle.setAttribute('fill', COLORS[character]);
      svg.append(rectangle); x = endX;
    }
  });
  return svg;
}
