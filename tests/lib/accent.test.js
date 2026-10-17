import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCENT, ACCENTS, isAccent, applyAccent } from '../../lib/accent.js';

// WCAG relative luminance / contrast, computed independently of the module.
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('accent constants', () => {
  it('default is one of the presets, and every preset is a valid, unique accent', () => {
    expect(ACCENTS).toContain(DEFAULT_ACCENT);
    expect(new Set(ACCENTS).size).toBe(ACCENTS.length);
    for (const c of ACCENTS) expect(isAccent(c)).toBe(true);
  });
});

describe('isAccent', () => {
  it('accepts #rrggbb in either case', () => {
    expect(isAccent('#7dd3fc')).toBe(true);
    expect(isAccent('#ABCDEF')).toBe(true);
    expect(isAccent('#aBc123')).toBe(true);
  });
  it.each([['#abc'], ['abcdef'], ['#abcdefff'], ['#ggg000'], [' #abcdef'], ['#abcdef '], [''], [null], [undefined], [0xabcdef], [{}], [['#abcdef']]])(
    'rejects %j', (v) => expect(isAccent(v)).toBe(false));
});

describe('applyAccent', () => {
  it('sets --accent upper-cased on documentElement by default and returns it', () => {
    expect(applyAccent('#5eead4')).toBe('#5EEAD4');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#5EEAD4');
  });
  it('falls back to the default for invalid input', () => {
    for (const bad of [undefined, null, 'red', '#fff', 42]) {
      expect(applyAccent(bad)).toBe(DEFAULT_ACCENT);
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe(DEFAULT_ACCENT);
    }
  });
  it('writes to the given root element only', () => {
    const el = document.createElement('div');
    document.documentElement.style.removeProperty('--accent');
    applyAccent('#000000', el);
    expect(el.style.getPropertyValue('--accent')).toBe('#000000');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });
  it('uses dark ink on light accents and white on dark ones', () => {
    const el = document.createElement('div');
    applyAccent('#FFFFFF', el);
    expect(el.style.getPropertyValue('--on-accent')).toBe('#1B2A4A');
    expect(el.style.getPropertyValue('--on-accent-ink')).toBe('#000');
    applyAccent('#000000', el);
    expect(el.style.getPropertyValue('--on-accent')).toBe('#fff');
    expect(el.style.getPropertyValue('--on-accent-ink')).toBe('#fff');
  });
  it('every preset (pastels) gets the dark ink', () => {
    const el = document.createElement('div');
    for (const c of ACCENTS) { applyAccent(c, el); expect(el.style.getPropertyValue('--on-accent')).toBe('#1B2A4A'); }
  });
  it('picks whichever of ink / white contrasts more', () => {
    const el = document.createElement('div');
    for (const c of ['#777777', '#808080', '#FF0000', '#00FF00', '#0000FF', '#C0392B', '#1B2A4A', '#FCD34D', '#6B7280', '#3E8E41']) {
      applyAccent(c, el);
      const best = contrast(c, '#1B2A4A') >= contrast(c, '#FFFFFF') ? '#1B2A4A' : '#fff';
      expect(el.style.getPropertyValue('--on-accent'), c).toBe(best);
    }
  });
});
