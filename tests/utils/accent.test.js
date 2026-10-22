import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCENT, ACCENTS, isAccent, applyAccent } from '../../utils/accent.js';

// WCAG relative luminance / contrast, computed independently of the module.
const luminance = (hexColor) => [1, 3, 5].map((i) => parseInt(hexColor.slice(i, i + 2), 16) / 255)
  .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (colorA, colorB) => { const [x, y] = [luminance(colorA), luminance(colorB)].sort((first, second) => second - first); return (x + 0.05) / (y + 0.05); };

describe('accent constants', () => {
  it('default is one of the presets, and every preset is a valid, unique accent', () => {
    expect(ACCENTS).toContain(DEFAULT_ACCENT);
    expect(new Set(ACCENTS).size).toBe(ACCENTS.length);
    for (const accent of ACCENTS) expect(isAccent(accent)).toBe(true);
  });
});

describe('isAccent', () => {
  it('accepts #rrggbb in either case', () => {
    expect(isAccent('#7dd3fc')).toBe(true);
    expect(isAccent('#ABCDEF')).toBe(true);
    expect(isAccent('#aBc123')).toBe(true);
  });
  it.each([['#abc'], ['abcdef'], ['#abcdefff'], ['#ggg000'], [' #abcdef'], ['#abcdef '], [''], [null], [undefined], [0xabcdef], [{}], [['#abcdef']]])(
    'rejects %j', (value) => expect(isAccent(value)).toBe(false));
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
    const element = document.createElement('div');
    document.documentElement.style.removeProperty('--accent');
    applyAccent('#000000', element);
    expect(element.style.getPropertyValue('--accent')).toBe('#000000');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });
  it('uses dark ink on light accents and white on dark ones', () => {
    const element = document.createElement('div');
    applyAccent('#FFFFFF', element);
    expect(element.style.getPropertyValue('--on-accent')).toBe('#1B2A4A');
    expect(element.style.getPropertyValue('--on-accent-ink')).toBe('#000');
    applyAccent('#000000', element);
    expect(element.style.getPropertyValue('--on-accent')).toBe('#fff');
    expect(element.style.getPropertyValue('--on-accent-ink')).toBe('#fff');
  });
  it('every preset (pastels) gets the dark ink', () => {
    const element = document.createElement('div');
    for (const accent of ACCENTS) { applyAccent(accent, element); expect(element.style.getPropertyValue('--on-accent')).toBe('#1B2A4A'); }
  });
  it('picks whichever of ink / white contrasts more', () => {
    const element = document.createElement('div');
    for (const color of ['#777777', '#808080', '#FF0000', '#00FF00', '#0000FF', '#C0392B', '#1B2A4A', '#FCD34D', '#6B7280', '#3E8E41']) {
      applyAccent(color, element);
      const best = contrast(color, '#1B2A4A') >= contrast(color, '#FFFFFF') ? '#1B2A4A' : '#fff';
      expect(element.style.getPropertyValue('--on-accent'), color).toBe(best);
    }
  });
});
