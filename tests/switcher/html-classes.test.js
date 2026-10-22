// The classes Tabazing puts on <html> to switch whole-page modes (palette-open, light, intro...) must not also
// be classes of elements in the page: a rule written for the element (".palette { position: fixed; width:
// 660px }") would then lay out the whole document. That happened once: opening the command palette shrank
// the switcher to the palette's width. jsdom doesn't apply CSS, so this checks the names themselves.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const switcherSource = readFileSync('switcher.js', 'utf8');
const html = readFileSync('markup/switcher.html', 'utf8');

// Classes set on the document element: classList.add / toggle / replace on document.documentElement.
const pageModes = new Set([...switcherSource.matchAll(/document\.documentElement\.classList\.(?:add|toggle)\(\s*'([\w-]+)'/g)].map((match) => match[1]));
// Classes given to elements: class="…" in the HTML, and makeElement(tag, 'className …') / className = '…' in switcher.js.
const elementClasses = new Set([
  ...[...html.matchAll(/\sclass="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)),
  ...[...switcherSource.matchAll(/\bmakeElement\(\s*'[\w-]+'\s*,\s*'([^']*)'/g)].flatMap((match) => match[1].split(/\s+/)),
  ...[...switcherSource.matchAll(/\.className\s*=\s*'([^']*)'/g)].flatMap((match) => match[1].split(/\s+/)),
].filter(Boolean));

describe('whole-page mode classes on <html>', () => {
  it('the scan finds them (sanity check)', () => {
    for (const className of ['palette-open', 'light', 'alttab']) expect(pageModes.has(className), className).toBe(true);
    expect(elementClasses.has('palette')).toBe(true); // the palette panel
    expect(elementClasses.size).toBeGreaterThan(100);
  });

  it('none is also an element\'s class (its rules would apply to the whole page)', () => {
    expect([...pageModes].filter((className) => elementClasses.has(className))).toEqual([]);
  });
});
