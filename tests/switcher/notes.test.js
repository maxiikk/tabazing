// Notes on tabs (the button, its tooltip, the note card), the big preview, and the small menus
// (menu, fancySelect) the actions use.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, entryByTitle, toastText, closedMsg } from '../helpers/quiet-boot.js';
import { t } from '../../utils/translations.js';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const notes = async () => (await chrome.storage.local.get('notes')).notes || {};
const type = (box, text) => { box.value = text; box.dispatchEvent(new Event('input')); };
const withNote = (n) => ({ tabs: AB, beforeImport: () => chrome.storage.local.set({ notes: { 'https://b.example/': { u: 'https://b.example/', n, t: Date.now() } } }) });

describe('note button', () => {
  it('paintNote: accent and the note as its label when there is one', async () => {
    const sw = await boot({ tabs: AB });
    const b = document.createElement('button');
    b.title = 'card tooltip';
    sw.paintNote(b, 'call Bob');
    expect(b.classList.contains('on')).toBe(true);
    expect(b.dataset.note).toBe('call Bob');
    expect(b.title).toBe('');
    expect(b.getAttribute('aria-label')).toBe(t('noteEdit') + ': call Bob');
    sw.paintNote(b, '');
    expect(b.classList.contains('on')).toBe(false);
    expect(b.getAttribute('aria-label')).toBe(t('noteAdd'));
  });

  it('noteButton shows the stored note of its page', async () => {
    const sw = await boot(withNote('remember'));
    const b = tid('quick-note', cardOf('B'));
    expect(b.dataset.note).toBe('remember');
    expect(sw.noteButton(entryByTitle(sw, 'A')).dataset.note).toBe('');
  });

  it('hovering a note button with a note shows it as a tooltip, briefly after', async () => {
    await boot(withNote('remember'));
    const b = tid('quick-note', cardOf('B'));
    b.dispatchEvent(new Event('mouseenter'));
    expect(tid('note-tooltip')).toBe(null); // not at once
    await waitFor(() => tid('note-tooltip'));
    expect(tid('note-tooltip-title').textContent).toBe(t('noteTitle'));
    expect(tid('note-tooltip-text').textContent).toBe('remember');
    b.dispatchEvent(new Event('mouseleave'));
    expect(tid('note-tooltip')).not.toBe(null); // a moment to reach the tooltip itself...
    await waitFor(() => !tid('note-tooltip')); // ...then it goes
  });

  it('no tooltip without a note, and hideTip cancels a pending one', async () => {
    const sw = await boot(withNote('x'));
    sw.noteTip(tid('quick-note', cardOf('A')));
    sw.noteTip(tid('quick-note', cardOf('B')));
    sw.hideTip();
    await tick(sw.TIP_DELAY_MS + 50);
    expect(tid('note-tooltip')).toBe(null);
  });
});

describe('an address too long to keep (over 2048 characters)', () => {
  const LONG = 'https://long.example/path?q=' + 'a'.repeat(2100);
  const tabs = [...AB, { title: 'Long', url: LONG }];

  it('a note: the toast says it can\'t be kept and the note box doesn\'t open (nothing typed is lost)', async () => {
    const sw = await boot({ tabs });
    sw.notePopover(LONG, tid('quick-note', cardOf('Long')));
    expect(tid('note-popover')).toBe(null);
    expect(toastText()).toBe(t('urlTooLong'));
    tid('quick-note', cardOf('Long')).click(); // the card's own button too
    expect(tid('note-popover')).toBe(null);
    expect(await notes()).toEqual({});
  });

  it('a star: the toast says it can\'t be kept, and it isn\'t starred', async () => {
    const sw = await boot({ tabs });
    await sw.star(entryByTitle(sw, 'Long'));
    expect(toastText()).toBe(t('urlTooLong'));
    expect(sw.isStarred(LONG)).toBe(false);
    expect((await chrome.storage.local.get('stars')).stars || {}).toEqual({});
  });

  it('a normal address still gets its note box and its star', async () => {
    const sw = await boot({ tabs });
    sw.notePopover('https://a.example/', tid('quick-note', cardOf('A')));
    expect(tid('note-popover')).not.toBe(null);
    await sw.star(entryByTitle(sw, 'B'));
    expect(sw.isStarred('https://b.example/')).toBe(true);
  });
});

describe('note card', () => {
  it('opens from the button, saves while typing, and marks the button', async () => {
    await boot({ tabs: AB });
    const b = tid('quick-note', cardOf('B'));
    b.click();
    const pop = tid('note-popover');
    expect(tid('note-label', pop).textContent).toBe(t('noteTitle'));
    expect(tid('note-clear', pop).hidden).toBe(true);
    await waitFor(() => document.activeElement === tid('note-input', pop));
    type(tid('note-input', pop), 'buy milk');
    expect(tid('note-clear', pop).hidden).toBe(false);
    await vi.waitFor(async () => expect((await notes())['https://b.example/']?.n).toBe('buy milk'));
    expect(b.dataset.note).toBe('buy milk');
    expect(b.classList.contains('on')).toBe(true);
    expect(tid('note-popover')).not.toBe(null); // still open
  });

  it('Clear removes the note and keeps the card open', async () => {
    await boot(withNote('old'));
    tid('quick-note', cardOf('B')).click();
    expect(tid('note-input').value).toBe('old');
    tid('note-clear').click();
    expect(tid('note-input').value).toBe('');
    expect(tid('note-clear').hidden).toBe(true);
    await vi.waitFor(async () => expect(await notes()).toEqual({}));
    expect(tid('note-popover')).not.toBe(null);
  });

  it('× closes it, saving what was written, back to the search box', async () => {
    await boot({ tabs: AB });
    tid('quick-note', cardOf('B')).click();
    type(tid('note-input'), 'now');
    tid('note-close').click(); // before the 400 ms save while typing
    expect(tid('note-popover')).toBe(null);
    expect(document.activeElement).toBe(tid('search'));
    await vi.waitFor(async () => expect((await notes())['https://b.example/']?.n).toBe('now'));
  });

  it('its button again closes it', async () => {
    await boot({ tabs: AB });
    const b = tid('quick-note', cardOf('B'));
    b.click();
    expect(tid('note-popover')).not.toBe(null);
    b.click();
    expect(tid('note-popover')).toBe(null);
  });

  it('a press outside or Esc closes it (and saves)', async () => {
    await boot({ tabs: AB });
    tid('quick-note', cardOf('B')).click();
    await waitFor(() => document.activeElement === tid('note-input'));
    tid('header').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('note-popover')).toBe(null);
    tid('quick-note', cardOf('B')).click();
    await waitFor(() => document.activeElement === tid('note-input'));
    type(tid('note-input'), 'esc');
    key('Escape');
    expect(tid('note-popover')).toBe(null);
    await vi.waitFor(async () => expect((await notes())['https://b.example/']?.n).toBe('esc'));
  });
});

describe('big preview', () => {
  const PV = 'data:image/jpeg;base64,BIG0';
  it('shows the screenshot large; its × closes it', async () => {
    const sw = await boot({ tabs: AB });
    const e = { ...entryByTitle(sw, 'B'), preview: { img: PV, t: 1 } };
    sw.openBig(e);
    const big = tid('big-preview');
    expect(tid('big-preview-title', big).textContent).toBe('B');
    expect(tid('big-preview-host', big).textContent).toBe('b.example');
    expect(tid('big-preview-image', big).src).toBe(PV);
    expect(document.activeElement).toBe(tid('big-preview-close', big));
    tid('big-preview-close', big).click();
    expect(tid('big-preview')).toBe(null);
    expect(document.activeElement).toBe(tid('search'));
  });

  it('swaps in the sharp copy when there is one', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ 'pvhd:https://b.example/': { img: 'data:image/jpeg;base64,SHARP', t: 1 } }) });
    const OrigImage = window.Image;
    window.Image = class { set src(v) { this._s = v; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._s; } };
    try {
      sw.openBig({ ...entryByTitle(sw, 'B'), preview: { img: PV, t: 1 } });
      await waitFor(() => tid('big-preview-image').src.endsWith('SHARP'));
    } finally { window.Image = OrigImage; }
  });

  it('without a preview says so; a click around it or Esc closes it', async () => {
    const sw = await boot({ tabs: AB });
    sw.openBig({ ...entryByTitle(sw, 'B'), preview: null });
    expect(tid('big-preview-none').textContent).toBe(t('noPreview'));
    tid('big-preview-none').click(); // inside the box: stays
    expect(tid('big-preview')).not.toBe(null);
    tid('big-preview').click();
    expect(tid('big-preview')).toBe(null);
    sw.openBig(entryByTitle(sw, 'B'));
    key('Escape');
    expect(tid('big-preview')).toBe(null);
    expect(sw.state.done).toBe(false);
  });

  it('Shift+click on a card\'s preview opens it; Enter then opens that tab', async () => {
    const sw = await boot({ tabs: AB });
    tid('card-thumb', cardOf('B')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(tid('big-preview-title').textContent).toBe('B');
    key('Enter');
    await waitFor(() => closedMsg());
    expect(chrome.tabs.update).toHaveBeenCalledWith(entryByTitle(sw, 'B').tab.id, { active: true });
  });

  it('closeBig without one open leaves the focus alone', async () => {
    const sw = await boot({ tabs: AB });
    const b = tid('newtab');
    b.focus();
    sw.closeBig();
    expect(document.activeElement).toBe(b);
  });
});

describe('menu', () => {
  const anchorBtn = () => { const b = document.createElement('button'); tid('app').append(b); return b; };

  it('lists the items, runs the one clicked, and closes', async () => {
    const sw = await boot({ tabs: AB });
    const fn = vi.fn();
    const a = anchorBtn();
    sw.menu(a, [{ label: 'One', fn }, null, { label: 'Two', fn: vi.fn() }]);
    expect(tids('menu-item').map((b) => b.textContent)).toEqual(['One', 'Two']);
    expect(tids('menu-separator')).toHaveLength(1);
    expect(document.activeElement).toBe(tids('menu-item')[0]);
    tids('menu-item')[0].click();
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(tid('menu')).toBe(null);
  });

  it('an item acts at once (nothing asks "sure?": what closes has Undo), and says what failed with its own words', async () => {
    const sw = await boot({ tabs: AB });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(() => { throw new Error('no'); });
    sw.menu(anchorBtn(), [{ label: 'Close all', danger: true, err: 'Could not close.', fn }]);
    tids('menu-item')[0].click();
    await tick();
    expect(fn).toHaveBeenCalled();
    expect(toastText()).toBe('Could not close.');
  });

  it('at a point (a right-click) it opens there, and a second right-click opens it anew', async () => {
    const sw = await boot({ tabs: AB });
    const a = anchorBtn();
    sw.menu(a, [{ label: 'X', fn: () => {} }], { at: { x: 120, y: 80 } });
    expect(tid('menu').style.left).toBe('120px');
    sw.menu(a, [{ label: 'Y', fn: () => {} }], { at: { x: 140, y: 90 } });
    expect(tids('menu')).toHaveLength(1);
    expect(tid('menu-item').textContent).toBe('Y');
  });

  it('ticks the current choice, and says so when an item fails', async () => {
    const sw = await boot({ tabs: AB });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sw.menu(anchorBtn(), [{ label: 'X', on: false, fn: () => {} }, { label: 'Y', on: true, fn: () => { throw new Error('bad'); } }]);
    const [x, y] = tids('menu-item');
    expect([x.getAttribute('aria-checked'), y.getAttribute('aria-checked')]).toEqual(['false', 'true']);
    expect(document.activeElement).toBe(y); // the current one has the focus
    y.click();
    await waitFor(() => toastText() === t('actFailed'));
  });

  it('its button again closes it; arrows move; Esc closes back to the button', async () => {
    const sw = await boot({ tabs: AB });
    const a = anchorBtn();
    const items = [{ label: '1', fn() {} }, { label: '2', fn() {} }];
    sw.menu(a, items);
    sw.menu(a, items);
    expect(tid('menu')).toBe(null);
    sw.menu(a, items);
    const m = tid('menu');
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(tids('menu-item')[1]);
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(tids('menu-item')[0]); // wraps
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tid('menu')).toBe(null);
    expect(document.activeElement).toBe(a);
  });

  it('a press outside closes it', async () => {
    const sw = await boot({ tabs: AB });
    sw.menu(anchorBtn(), [{ label: '1', fn() {} }]);
    await tick();
    tid('header').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('menu')).toBe(null);
  });
});

describe('fancySelect', () => {
  it('stands in for the Sort select: shows the choice, and picking one changes the sort', async () => {
    const sw = await boot({ tabs: AB });
    const b = tid('select-sort');
    expect(tid('select-label', b).textContent).toBe(t('sortByRecent'));
    expect(sw.fancySelect(tid('sort'))).toBe(tid('sort')._fancy); // made once
    b.click();
    expect(tids('menu-item').map((x) => x.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    tids('menu-item')[0].click(); // By order
    await waitFor(() => sw.state.sort === 'order');
    expect(tid('sort').value).toBe('order');
    expect(tid('select-label', b).textContent).toBe(t('sortByOrder'));
    await vi.waitFor(async () => expect((await chrome.storage.local.get('view')).view?.sort).toBe('order'));
  });
});
