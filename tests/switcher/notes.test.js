// Notes on tabs (the button, its tooltip, the note card), the big preview, and the small menus
// (menu, fancySelect) the actions use.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, entryByTitle, toastText, closedMessage } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const twoTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const notes = async () => (await chrome.storage.local.get('notes')).notes || {};
const type = (box, text) => { box.value = text; box.dispatchEvent(new Event('input')); };
const withNote = (noteText) => ({ tabs: twoTabs, beforeImport: () => chrome.storage.local.set({ notes: { 'https://b.example/': { u: 'https://b.example/', n: noteText, t: Date.now() } } }) });

describe('note button', () => {
  it('paintNote: accent and the note as its label when there is one', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const button = document.createElement('button');
    button.title = 'card tooltip';
    switcher.paintNote(button, 'call Bob');
    expect(button.classList.contains('on')).toBe(true);
    expect(button.dataset.note).toBe('call Bob');
    expect(button.title).toBe('');
    expect(button.getAttribute('aria-label')).toBe(translate('noteEdit') + ': call Bob');
    switcher.paintNote(button, '');
    expect(button.classList.contains('on')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(translate('noteAdd'));
  });

  it('noteButton shows the stored note of its page', async () => {
    const switcher = await boot(withNote('remember'));
    const button = byTestId('quick-note', cardOf('B'));
    expect(button.dataset.note).toBe('remember');
    expect(switcher.noteButton(entryByTitle(switcher, 'A')).dataset.note).toBe('');
  });

  it('hovering a note button with a note shows it as a tooltip, briefly after', async () => {
    await boot(withNote('remember'));
    const button = byTestId('quick-note', cardOf('B'));
    button.dispatchEvent(new Event('mouseenter'));
    expect(byTestId('note-tooltip')).toBe(null); // not at once
    await waitFor(() => byTestId('note-tooltip'));
    expect(byTestId('note-tooltip-title').textContent).toBe(translate('noteTitle'));
    expect(byTestId('note-tooltip-text').textContent).toBe('remember');
    button.dispatchEvent(new Event('mouseleave'));
    expect(byTestId('note-tooltip')).not.toBe(null); // a moment to reach the tooltip itself...
    await waitFor(() => !byTestId('note-tooltip')); // ...then it goes
  });

  it('no tooltip without a note, and hideTip cancels a pending one', async () => {
    const switcher = await boot(withNote('x'));
    switcher.noteTip(byTestId('quick-note', cardOf('A')));
    switcher.noteTip(byTestId('quick-note', cardOf('B')));
    switcher.hideTip();
    await tick(switcher.TIP_DELAY_MILLISECONDS + 50);
    expect(byTestId('note-tooltip')).toBe(null);
  });
});

describe('an address too long to keep (over 2048 characters)', () => {
  const LONG = 'https://long.example/path?q=' + 'a'.repeat(2100);
  const tabs = [...twoTabs, { title: 'Long', url: LONG }];

  it('a note: the toast says it can\'t be kept and the note box doesn\'t open (nothing typed is lost)', async () => {
    const switcher = await boot({ tabs });
    switcher.notePopover(LONG, byTestId('quick-note', cardOf('Long')));
    expect(byTestId('note-popover')).toBe(null);
    expect(toastText()).toBe(translate('urlTooLong'));
    byTestId('quick-note', cardOf('Long')).click(); // the card's own button too
    expect(byTestId('note-popover')).toBe(null);
    expect(await notes()).toEqual({});
  });

  it('a star: the toast says it can\'t be kept, and it isn\'t starred', async () => {
    const switcher = await boot({ tabs });
    await switcher.star(entryByTitle(switcher, 'Long'));
    expect(toastText()).toBe(translate('urlTooLong'));
    expect(switcher.isStarred(LONG)).toBe(false);
    expect((await chrome.storage.local.get('stars')).stars || {}).toEqual({});
  });

  it('a normal address still gets its note box and its star', async () => {
    const switcher = await boot({ tabs });
    switcher.notePopover('https://a.example/', byTestId('quick-note', cardOf('A')));
    expect(byTestId('note-popover')).not.toBe(null);
    await switcher.star(entryByTitle(switcher, 'B'));
    expect(switcher.isStarred('https://b.example/')).toBe(true);
  });
});

describe('note card', () => {
  it('opens from the button, saves while typing, and marks the button', async () => {
    await boot({ tabs: twoTabs });
    const button = byTestId('quick-note', cardOf('B'));
    button.click();
    const popover = byTestId('note-popover');
    expect(byTestId('note-label', popover).textContent).toBe(translate('noteTitle'));
    expect(byTestId('note-clear', popover).hidden).toBe(true);
    await waitFor(() => document.activeElement === byTestId('note-input', popover));
    type(byTestId('note-input', popover), 'buy milk');
    expect(byTestId('note-clear', popover).hidden).toBe(false);
    await vi.waitFor(async () => expect((await notes())['https://b.example/']?.n).toBe('buy milk'));
    expect(button.dataset.note).toBe('buy milk');
    expect(button.classList.contains('on')).toBe(true);
    expect(byTestId('note-popover')).not.toBe(null); // still open
  });

  it('Clear removes the note and keeps the card open', async () => {
    await boot(withNote('old'));
    byTestId('quick-note', cardOf('B')).click();
    expect(byTestId('note-input').value).toBe('old');
    byTestId('note-clear').click();
    expect(byTestId('note-input').value).toBe('');
    expect(byTestId('note-clear').hidden).toBe(true);
    await vi.waitFor(async () => expect(await notes()).toEqual({}));
    expect(byTestId('note-popover')).not.toBe(null);
  });

  it('× closes it, saving what was written, back to the search box', async () => {
    await boot({ tabs: twoTabs });
    byTestId('quick-note', cardOf('B')).click();
    type(byTestId('note-input'), 'now');
    byTestId('note-close').click(); // before the 400 ms save while typing
    expect(byTestId('note-popover')).toBe(null);
    expect(document.activeElement).toBe(byTestId('search'));
    await vi.waitFor(async () => expect((await notes())['https://b.example/']?.n).toBe('now'));
  });

  it('its button again closes it', async () => {
    await boot({ tabs: twoTabs });
    const button = byTestId('quick-note', cardOf('B'));
    button.click();
    expect(byTestId('note-popover')).not.toBe(null);
    button.click();
    expect(byTestId('note-popover')).toBe(null);
  });

  it('a press outside or Esc closes it (and saves)', async () => {
    await boot({ tabs: twoTabs });
    byTestId('quick-note', cardOf('B')).click();
    await waitFor(() => document.activeElement === byTestId('note-input'));
    byTestId('header').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('note-popover')).toBe(null);
    byTestId('quick-note', cardOf('B')).click();
    await waitFor(() => document.activeElement === byTestId('note-input'));
    type(byTestId('note-input'), 'esc');
    key('Escape');
    expect(byTestId('note-popover')).toBe(null);
    await vi.waitFor(async () => expect((await notes())['https://b.example/']?.n).toBe('esc'));
  });
});

describe('big preview', () => {
  const PREVIEW = 'data:image/jpeg;base64,BIG0';
  it('shows the screenshot large; its × closes it', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const entry = { ...entryByTitle(switcher, 'B'), preview: { img: PREVIEW, t: 1 } };
    switcher.openBig(entry);
    const bigPreview = byTestId('big-preview');
    expect(byTestId('big-preview-title', bigPreview).textContent).toBe('B');
    expect(byTestId('big-preview-host', bigPreview).textContent).toBe('b.example');
    expect(byTestId('big-preview-image', bigPreview).src).toBe(PREVIEW);
    expect(document.activeElement).toBe(byTestId('big-preview-close', bigPreview));
    byTestId('big-preview-close', bigPreview).click();
    expect(byTestId('big-preview')).toBe(null);
    expect(document.activeElement).toBe(byTestId('search'));
  });

  it('swaps in the sharp copy when there is one', async () => {
    const switcher = await boot({ tabs: twoTabs, beforeImport: () => chrome.storage.local.set({ 'pvhd:https://b.example/': { img: 'data:image/jpeg;base64,SHARP', t: 1 } }) });
    const OriginalImage = window.Image;
    window.Image = class { set src(value) { this._s = value; setTimeout(() => this.onload && this.onload(), 0); } get src() { return this._s; } };
    try {
      switcher.openBig({ ...entryByTitle(switcher, 'B'), preview: { img: PREVIEW, t: 1 } });
      await waitFor(() => byTestId('big-preview-image').src.endsWith('SHARP'));
    } finally { window.Image = OriginalImage; }
  });

  it('without a preview says so; a click around it or Esc closes it', async () => {
    const switcher = await boot({ tabs: twoTabs });
    switcher.openBig({ ...entryByTitle(switcher, 'B'), preview: null });
    expect(byTestId('big-preview-none').textContent).toBe(translate('noPreview'));
    byTestId('big-preview-none').click(); // inside the box: stays
    expect(byTestId('big-preview')).not.toBe(null);
    byTestId('big-preview').click();
    expect(byTestId('big-preview')).toBe(null);
    switcher.openBig(entryByTitle(switcher, 'B'));
    key('Escape');
    expect(byTestId('big-preview')).toBe(null);
    expect(switcher.state.done).toBe(false);
  });

  it('Shift+click on a card\'s preview opens it; Enter then opens that tab', async () => {
    const switcher = await boot({ tabs: twoTabs });
    byTestId('card-thumb', cardOf('B')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(byTestId('big-preview-title').textContent).toBe('B');
    key('Enter');
    await waitFor(() => closedMessage());
    expect(chrome.tabs.update).toHaveBeenCalledWith(entryByTitle(switcher, 'B').tab.id, { active: true });
  });

  it('closeBig without one open leaves the focus alone', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const button = byTestId('new-tab');
    button.focus();
    switcher.closeBig();
    expect(document.activeElement).toBe(button);
  });
});

describe('menu', () => {
  const anchorButton = () => { const button = document.createElement('button'); byTestId('app').append(button); return button; };

  it('lists the items, runs the one clicked, and closes', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const callback = vi.fn();
    const anchor = anchorButton();
    switcher.menu(anchor, [{ label: 'One', run: callback }, null, { label: 'Two', run: vi.fn() }]);
    expect(allByTestId('menu-item').map((button) => button.textContent)).toEqual(['One', 'Two']);
    expect(allByTestId('menu-separator')).toHaveLength(1);
    expect(document.activeElement).toBe(allByTestId('menu-item')[0]);
    allByTestId('menu-item')[0].click();
    await tick();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(byTestId('menu')).toBe(null);
  });

  it('an item actions at once (nothing asks "sure?": what closes has Undo), and says what failed with its own words', async () => {
    const switcher = await boot({ tabs: twoTabs });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callback = vi.fn(() => { throw new Error('no'); });
    switcher.menu(anchorButton(), [{ label: 'Close all', danger: true, error: 'Could not close.', run: callback }]);
    allByTestId('menu-item')[0].click();
    await tick();
    expect(callback).toHaveBeenCalled();
    expect(toastText()).toBe('Could not close.');
  });

  it('at a point (a right-click) it opens there, and a second right-click opens it anew', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const anchor = anchorButton();
    switcher.menu(anchor, [{ label: 'X', run: () => {} }], { at: { x: 120, y: 80 } });
    expect(byTestId('menu').style.left).toBe('120px');
    switcher.menu(anchor, [{ label: 'Y', run: () => {} }], { at: { x: 140, y: 90 } });
    expect(allByTestId('menu')).toHaveLength(1);
    expect(byTestId('menu-item').textContent).toBe('Y');
  });

  it('ticks the current choice, and says so when an item fails', async () => {
    const switcher = await boot({ tabs: twoTabs });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    switcher.menu(anchorButton(), [{ label: 'X', on: false, run: () => {} }, { label: 'Y', on: true, run: () => { throw new Error('bad'); } }]);
    const [x, y] = allByTestId('menu-item');
    expect([x.getAttribute('aria-checked'), y.getAttribute('aria-checked')]).toEqual(['false', 'true']);
    expect(document.activeElement).toBe(y); // the current one has the focus
    y.click();
    await waitFor(() => toastText() === translate('actionFailed'));
  });

  it('its button again closes it; arrows move; Esc closes back to the button', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const anchor = anchorButton();
    const items = [{ label: '1', run() {} }, { label: '2', run() {} }];
    switcher.menu(anchor, items);
    switcher.menu(anchor, items);
    expect(byTestId('menu')).toBe(null);
    switcher.menu(anchor, items);
    const menu = byTestId('menu');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(allByTestId('menu-item')[1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(allByTestId('menu-item')[0]); // wraps
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byTestId('menu')).toBe(null);
    expect(document.activeElement).toBe(anchor);
  });

  it('a press outside closes it', async () => {
    const switcher = await boot({ tabs: twoTabs });
    switcher.menu(anchorButton(), [{ label: '1', run() {} }]);
    await tick();
    byTestId('header').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('menu')).toBe(null);
  });
});

describe('fancySelect', () => {
  it('stands in for the Sort select: shows the choice, and picking one changes the sort', async () => {
    const switcher = await boot({ tabs: twoTabs });
    const button = byTestId('select-sort');
    expect(byTestId('select-label', button).textContent).toBe(translate('sortByRecent'));
    expect(switcher.fancySelect(byTestId('sort'))).toBe(byTestId('sort')._fancy); // made once
    button.click();
    expect(allByTestId('menu-item').map((x) => x.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    allByTestId('menu-item')[0].click(); // By order
    await waitFor(() => switcher.state.sort === 'order');
    expect(byTestId('sort').value).toBe('order');
    expect(byTestId('select-label', button).textContent).toBe(translate('sortByOrder'));
    await vi.waitFor(async () => expect((await chrome.storage.local.get('view')).view?.sort).toBe('order'));
  });
});
