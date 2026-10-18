// Dialogs (the first-run tour, the review prompt), the alert bar and its health checks, and Settings.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText, closedMsg } from './quiet-boot.js';
import { t } from '../../lib/translations.js';
import { REVIEW_URL } from '../../lib/constants.js';
import RU from '../../dictionaries/ru.json';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const local = async (k) => (await chrome.storage.local.get(k))[k];
const prefs = () => local('prefs');
const modalOpen = () => !tid('modal').hidden;

describe('showDialog / closeDialog', () => {
  it('shows the nodes, focuses the main button, and closing goes back to the search box', async () => {
    const sw = await boot({ tabs: AB });
    const quiet = sw.button('q', 'Later', 'quiet', () => {});
    const main = sw.button('m', 'Go', 'primary', () => {});
    sw.showDialog('ask', [sw.para('Hello'), quiet, main]);
    expect(modalOpen()).toBe(true);
    expect(sw.state.modal).toBe('ask');
    expect(tid('dialog-text', tid('dialog')).textContent).toBe('Hello');
    expect(document.activeElement).toBe(main);
    cardOf('B').classList.add('tour-hl');
    sw.closeDialog();
    expect(modalOpen()).toBe(false);
    expect(sw.state.modal).toBe(null);
    expect(cardOf('B').classList.contains('tour-hl')).toBe(false);
    expect(document.activeElement).toBe(tid('search'));
  });
});

describe('whenTapMode', () => {
  it('runs once Alt is no longer held, not while a dialog is open or text is typed', async () => {
    const sw = await boot({ tabs: AB });
    const fn = vi.fn();
    sw.state.holding = true;
    sw.whenTapMode(fn);
    await tick(400);
    expect(fn).not.toHaveBeenCalled();
    sw.state.holding = false;
    await waitFor(() => fn.mock.calls.length);

    const typed = vi.fn();
    tid('search').value = 'x';
    sw.whenTapMode(typed);
    sw.state.modal = null;
    const busy = vi.fn();
    await tick(400);
    expect(typed).not.toHaveBeenCalled();
    tid('search').value = '';
    sw.state.modal = 'ask';
    sw.whenTapMode(busy);
    await tick(400);
    expect(busy).not.toHaveBeenCalled();
  });
});

describe('the tour', () => {
  it('walks through every step: Next, Back, then Done remembers it', async () => {
    const sw = await boot({ tabs: AB });
    sw.tourStep(0);
    const n = sw.TOUR.length; // the steps for what is on screen (one window, nothing playing: no windows or media step)
    expect(sw.TOUR.map((s) => s.id)).toEqual(['switch', 'move', 'search', 'palette', 'cards', 'later', 'many', 'sort', 'settings']);
    expect(sw.state.modal).toBe('tour');
    expect(tid('dialog-title').textContent).toBe(t('tourSwitchTitle'));
    expect(tid('tour-step-number').textContent).toBe('1');
    expect(tid('tour-step-of').textContent).toBe(`1 / ${n}`);
    expect(tid('tour-back')).toBe(null);
    expect(tid('tour-skip')).not.toBe(null);
    expect(tids('card-tab').find((c) => c.getAttribute('aria-selected') === 'true').classList.contains('tour-hl')).toBe(true);
    tid('tour-next').click();
    expect(tid('dialog-title').textContent).toBe(t('tour2Title'));
    tid('tour-back').click();
    expect(tid('tour-step-number').textContent).toBe('1');
    for (let i = 1; i < n; i++) tid('tour-next').click();
    expect(tid('dialog-title').textContent).toBe(t('tourSetTitle'));
    expect(tid('settings-btn').classList.contains('tour-hl')).toBe(true);
    expect(tid('tour-next')).toBe(null);
    expect(tid('tour-skip')).toBe(null);
    tid('tour-done').click();
    expect(modalOpen()).toBe(false);
    expect(tid('settings-btn').classList.contains('tour-hl')).toBe(false);
    await vi.waitFor(async () => expect(await local('onb')).toMatchObject({ tour: true, flyout: true }));
  });

  it('Skip ends it; arrows step through it; Esc ends it without closing the switcher', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ onb: { tour: false } }) });
    await chrome.storage.local.set({ onb: { tour: false } });
    sw.tourStep(0);
    tid('tour-skip').click();
    expect(modalOpen()).toBe(false);
    await vi.waitFor(async () => expect((await local('onb')).tour).toBe(true));

    sw.tourStep(0);
    key('ArrowRight');
    expect(tid('tour-step-number').textContent).toBe('2');
    key('ArrowLeft');
    key('ArrowLeft'); // stays on the first
    expect(tid('tour-step-number').textContent).toBe('1');
    key('Escape');
    expect(modalOpen()).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('ArrowRight on the last step ends it', async () => {
    const sw = await boot({ tabs: AB });
    sw.tourStep(0);
    sw.tourStep(sw.TOUR.length - 1);
    key('ArrowRight');
    expect(modalOpen()).toBe(false);
  });

  it('the "many at once" step shows every tick box (and points at the selected one), until the step changes', async () => {
    const sw = await boot({ tabs: AB });
    sw.tourStep(0);
    const many = sw.TOUR.findIndex((s) => s.id === 'many');
    sw.tourStep(many);
    expect(document.documentElement.classList.contains('tour-picking')).toBe(true);
    const sel = tids('card-tab').find((c) => c.getAttribute('aria-selected') === 'true');
    expect(tid('card-pick', sel).classList.contains('tour-hl')).toBe(true);
    expect(tid('dialog-text').textContent).toBe(t('tourManyBody', { key: 'Ctrl' }));
    sw.tourStep(many + 1);
    expect(document.documentElement.classList.contains('tour-picking')).toBe(false);
    sw.tourStep(many);
    key('Escape');
    expect(document.documentElement.classList.contains('tour-picking')).toBe(false);
  });

  it('adds a windows step and a media step when those are on screen', async () => {
    const sw = await boot({ tabs: AB, prefs: { allWindows: true }, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'W', url: 'https://w.example/' }); } });
    sw.state.media = [{ tabId: sw.state.tabs[0].id, frameId: 0, tab: sw.state.tabs[0], title: 'Song', site: 'a.example', playing: true }];
    sw.renderPlayer();
    sw.tourStep(0);
    const ids = sw.TOUR.map((s) => s.id);
    expect(ids).toContain('windows');
    expect(ids).toContain('player');
    sw.tourStep(ids.indexOf('windows'));
    expect(tid('wins').classList.contains('tour-hl')).toBe(true);
    expect(tid('dialog-title').textContent).toBe(t('tourWinTitle'));
    sw.tourStep(ids.indexOf('player'));
    expect(tid('player').classList.contains('tour-hl')).toBe(true);
  });

  it('every step says Alt+Q / Alt+W the corrected way: previous / next card in the list, wrapping around', async () => {
    const sw = await boot({ tabs: AB });
    sw.tourStep(0);
    expect(tid('dialog').textContent).toContain(t('keyPrevTab'));
    expect(tid('dialog').textContent).toContain(t('keyNextTab'));
    expect(t('tourSwitchBody')).toMatch(/Hold Alt and press Q/);
    expect(t('keyPrevTab')).toBe('previous card in the list (wraps around)');
  });

  it('placeTour puts the card next to its target, or nowhere in particular without one', async () => {
    const sw = await boot({ tabs: AB });
    const d = tid('dialog');
    const target = tid('search');
    target.getBoundingClientRect = () => ({ left: 100, right: 300, top: 10, bottom: 40, width: 200, height: 30 });
    sw.placeTour(target);
    expect(d.dataset.side).toBe('below'); // the top strip: below it
    expect(d.style.top).toBe('58px');
    sw.placeTour(null);
    expect(d.dataset.side).toBeUndefined();
    expect(d.style.left).toBe('');
  });
});

describe('the review prompt', () => {
  it('step 1 offers moods, "don\'t ask again" and "not now"', async () => {
    const sw = await boot({ tabs: AB });
    sw.askStep1();
    expect(tid('dialog-title').textContent).toBe(t('askTitle'));
    expect(['good', 'okay', 'bad'].map((m) => tid('ask-mood-' + m).textContent)).toEqual([t('moodGood'), t('moodOkay'), t('moodBad')]);
    tid('ask-not-now').click();
    expect(modalOpen()).toBe(false);
    sw.askStep1();
    tid('ask-dont-ask').click();
    expect(modalOpen()).toBe(false);
    await vi.waitFor(async () => expect((await local('rv')).done).toBe(true));
  });

  it('a good mood offers the store review, which opens it and stops asking', async () => {
    const sw = await boot({ tabs: AB });
    sw.askStep1();
    tid('ask-mood-good').click();
    expect(tid('dialog-title').textContent).toBe(t('askGoodTitle'));
    expect(tid('ask-survey')).toBe(null);
    expect(tid('ask-note').textContent).toBe(t('askNote'));
    tid('ask-review').click();
    await waitFor(() => closedMsg());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: REVIEW_URL, windowId: 1, active: true });
    expect((await local('rv')).done).toBe(true);
  });

  it('another mood offers the survey too, with the mood in its address', async () => {
    const sw = await boot({ tabs: AB });
    sw.askStep2('bad');
    expect(tid('dialog-title').textContent).toBe(t('askBadTitle'));
    expect(tid('ask-review')).not.toBe(null);
    tid('ask-survey').click();
    await waitFor(() => closedMsg());
    const url = chrome.tabs.create.mock.calls[0][0].url;
    expect(url).toMatch(/\/survey\?from=extension-prompt&v=[\d.]+&lang=en&mood=bad$/);
    expect(closedMsg().reason).toBe('switch');
  });

  it('Esc puts it off (askLater)', async () => {
    const sw = await boot({ tabs: AB });
    sw.askStep1();
    key('Escape');
    expect(modalOpen()).toBe(false);
    expect(sw.state.done).toBe(false);
    expect((await local('rv')).done).toBe(false); // it will ask again
  });

  it('openUrl opens the page in this window and closes the switcher', async () => {
    const sw = await boot({ tabs: AB });
    await sw.openUrl('https://x.example/');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://x.example/', windowId: 1, active: true });
    expect(closedMsg().reason).toBe('switch');
  });
});

describe('dialogKey', () => {
  it('lets other keys through to the dialog', async () => {
    const sw = await boot({ tabs: AB });
    sw.askStep1();
    const e = key('Enter');
    expect(e.defaultPrevented).toBe(false);
    expect(closedMsg()).toBeUndefined(); // Enter did not open a tab
  });
});

describe('firstRun', () => {
  it('starts the tour on a first open, and counts the open', async () => {
    const sw = await boot({ tabs: AB });
    await chrome.storage.local.set({ onb: { tour: false, flyout: false } });
    const opens = (await local('rv')).opens;
    await sw.firstRun();
    expect((await local('rv')).opens).toBe(opens + 1);
    await waitFor(() => sw.state.modal === 'tour');
    expect(tid('tour-step-number').textContent).toBe('1');
    expect((await local('onb')).flyout).toBe(true);
  });

  it('after the tour shows nothing (the review prompt is turned off)', async () => {
    const sw = await boot({ tabs: AB });
    await sw.firstRun();
    await tick(400);
    expect(modalOpen()).toBe(false);
  });
});

describe('alerts and health checks', () => {
  it('showAlert: text, an optional button, and the detail as a tooltip', async () => {
    const sw = await boot({ tabs: AB });
    const fn = vi.fn();
    sw.showAlert('Problem', 'Fix', fn, 'why');
    expect(tid('alert').hidden).toBe(false);
    expect(tid('alert-text').textContent).toBe('Problem');
    expect(tid('alert').title).toBe('why');
    expect(tid('alert-btn').textContent).toBe('Fix');
    tid('alert-btn').click();
    expect(fn).toHaveBeenCalled();
    sw.showAlert('Just this');
    expect(tid('alert-btn').hidden).toBe(true);
  });

  it('a missing Alt+Q shortcut gets an alert that opens the shortcuts page', async () => {
    const sw = await boot({ tabs: AB });
    chrome.commands.getAll.mockResolvedValueOnce([{ name: 'open-switcher', shortcut: '' }]);
    await sw.healthCheck();
    expect(tid('alert-text').textContent).toBe(t('shortcutMissing'));
    expect(tid('alert-btn').textContent).toBe(t('setShortcut'));
    tid('alert-btn').click();
    await waitFor(() => closedMsg());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts', windowId: 1, active: true });
  });

  it('withheld site access gets an alert that asks for it', async () => {
    const sw = await boot({ tabs: AB });
    chrome.permissions.contains.mockResolvedValueOnce(false);
    await sw.healthCheck();
    expect(sw.state.hostOk).toBe(false);
    expect(tid('alert-text').textContent).toBe(t('hostBlocked'));
    expect(tid('alert').title).toBe(t('hostBlockedTip'));
    expect(tid('sweep-btn').hidden).toBe(true);
    tid('alert-btn').click();
    await waitFor(() => tid('alert-text').textContent === t('hostThanks'));
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(window.focus).toHaveBeenCalled();
  });

  it('a recent screenshot error on this page is explained', async () => {
    const sw = await boot({ tabs: AB });
    await chrome.storage.session.set({ capdiag: { t: Date.now(), stage: 'error', msg: 'Cannot access contents of the page', host: 'a.example' } });
    await sw.healthCheck();
    expect(tid('alert-text').textContent).toBe(t('capErrPage'));
    expect(tid('alert-btn').hidden).toBe(true);
    expect(tid('alert').title).toBe('a.example: Cannot access contents of the page');
  });

  it('opened from the toolbar icon, it tips Alt+Q', async () => {
    const sw = await boot({ tabs: AB, ctx: { via: 'icon' } });
    await sw.healthCheck();
    expect(toastText()).toBe(t('iconTip', { key: 'Alt+Q' }));
    expect(tid('alert').hidden).toBe(true);
  });

  it('requestHostAccess does nothing more when refused', async () => {
    const sw = await boot({ tabs: AB });
    chrome.permissions.request.mockResolvedValueOnce(false);
    await sw.requestHostAccess();
    expect(tid('alert').hidden).toBe(true);
  });

  it('updateSweepButton offers to capture the tabs without a preview', async () => {
    const sw = await boot({ tabs: [...AB, { title: 'C', url: 'https://c.example/' }, { title: 'X', url: 'chrome://extensions/' }] });
    sw.updateSweepButton();
    expect(tid('sweep-btn').hidden).toBe(false);
    // compact: a camera and the count; the label and tooltip say the rest
    expect(tid('sweep-text').textContent).toBe('2'); // B and C: not the current tab, not chrome://
    expect(tid('sweep-btn').getAttribute('aria-label')).toBe(t('sweepAll', { count: 2 }));
    expect(tid('sweep-btn').title).toContain(t('sweepTitleAll'));
    sw.state.query = 'c';
    sw.updateSweepButton();
    expect(tid('sweep-btn').getAttribute('aria-label')).toBe(t('sweepThese', { count: 2 }));
    sw.state.hostOk = false;
    sw.updateSweepButton();
    expect(tid('sweep-btn').hidden).toBe(true);
  });
});

describe('Settings', () => {
  const open = async () => { tid('settings-btn').click(); return waitFor(() => tid('settings')); };

  it('the gear opens it, and the gear again closes it', async () => {
    await boot({ tabs: AB });
    const pop = await open();
    expect(tid('settings-title', pop).textContent).toBe(t('settings'));
    tid('settings-btn').click();
    await tick(20);
    expect(tid('settings')).toBe(null);
    await open();
    expect(tid('settings')).not.toBe(null);
  });

  it('shows the stored settings', async () => {
    await boot({ tabs: AB, prefs: { lang: 'en', startup: true, cardSize: 'small', accent: '#86EFAC', allWindows: true, theme: 'light' } });
    await open();
    expect(tid('settings-language').value).toBe('en');
    expect(tid('settings-startup').checked).toBe(true);
    expect(tid('settings-all-windows').checked).toBe(true);
    expect(tid('settings-card-size').value).toBe('small');
    expect(tid('settings-theme').value).toBe('light');
    expect(tids('settings-accent').find((b) => b.getAttribute('aria-checked') === 'true').dataset.c).toBe('#86EFAC');
    expect(tid('select-label', tid('select-settings-card-size')).textContent).toBe(t('setSizeSmall'));
  });

  it('startup and accent persist', async () => {
    await boot({ tabs: AB });
    await open();
    const start = tid('settings-startup');
    start.checked = true;
    start.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await prefs()).startup).toBe(true));
    tids('settings-accent')[3].click();
    await vi.waitFor(async () => expect((await prefs()).accent).toBe('#FCD34D'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#FCD34D');
    expect(tids('settings-accent')[3].getAttribute('aria-checked')).toBe('true');
  });

  it('a custom accent is tried live and kept once chosen', async () => {
    await boot({ tabs: AB });
    await open();
    const c = tid('settings-accent-custom');
    c.value = '#123456';
    c.dispatchEvent(new Event('input'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');
    await tick(20);
    expect((await prefs()) || {}).not.toHaveProperty('accent', '#123456');
    expect(c.classList.contains('on')).toBe(true);
    c.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await prefs()).accent).toBe('#123456'));
  });

  it('card size (through its themed list) persists and redraws the cards', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    tid('select-settings-card-size').click();
    const items = tids('menu-item');
    expect(items.map((x) => x.textContent)).toEqual([t('setSizeDefault'), t('setSizeSmall'), t('setSizeList')]);
    expect(tid('settings')).not.toBe(null); // the list opens over Settings, which stays
    items[2].click();
    await waitFor(() => sw.state.cardSize === 'list');
    expect(tid('settings-card-size').value).toBe('list');
    expect(tid('card-thumb', cardOf('B'))).toBe(null); // list cards have no screenshot
    await vi.waitFor(async () => expect((await prefs()).cardSize).toBe('list'));
  });

  it('theme persists and switches the colours', async () => {
    await boot({ tabs: AB });
    await open();
    const th = tid('settings-theme');
    th.value = 'light';
    th.dispatchEvent(new Event('change'));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    await vi.waitFor(async () => expect((await prefs()).theme).toBe('light'));
    th.value = 'dark';
    th.dispatchEvent(new Event('change'));
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('"all windows" persists and shows the other windows\' tabs', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Far', url: 'https://far.example/' }); } });
    expect(sw.state.tabs.map((x) => x.title)).not.toContain('Far');
    await open();
    const all = tid('settings-all-windows');
    all.checked = true;
    all.dispatchEvent(new Event('change'));
    await waitFor(() => sw.state.tabs.some((x) => x.title === 'Far'));
    expect((await prefs()).allWindows).toBe(true);
    expect(sw.state.scope).toBe('all');
  });

  it('a new language persists and redraws Settings, still open, in it', async () => {
    await boot({ tabs: AB });
    await open();
    const lang = tid('settings-language');
    lang.value = 'ru';
    lang.dispatchEvent(new Event('change'));
    await waitFor(() => tid('settings-title')?.textContent === RU.settings);
    expect(tids('settings')).toHaveLength(1);
    expect(document.documentElement.lang).toBe('ru');
    expect(tid('newtab-label').textContent).toBe(RU.newTab); // the page too
    expect((await prefs()).lang).toBe('ru');
  });

  it('"Change the Alt+Q shortcut" opens Chrome\'s shortcuts page', async () => {
    await boot({ tabs: AB });
    await open();
    tid('settings-shortcut').click();
    await waitFor(() => closedMsg());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts', windowId: 1, active: true });
  });

  it('Esc or a press outside closes it', async () => {
    await boot({ tabs: AB });
    let pop = await open();
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tid('settings')).toBe(null);
    pop = await open();
    await tick();
    tid('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('settings')).toBe(null);
  });
});

describe('the toolbar-icon tip', () => {
  it('shows at most three times, counting in prefs.iconTips', async () => {
    let sw = await boot({ tabs: AB, ctx: { via: 'icon' }, prefs: { iconTips: 2 } });
    await sw.healthCheck();
    expect(toastText()).toBe(t('iconTip', { key: 'Alt+Q' }));
    await vi.waitFor(async () => expect((await prefs()).iconTips).toBe(3));
    sw = await boot({ tabs: AB, ctx: { via: 'icon' } });
    sw.toast('');
    await sw.healthCheck();
    expect(toastText()).not.toBe(t('iconTip', { key: 'Alt+Q' }));
  });
});

describe('the shortcuts card (ⓘ)', () => {
  const openKeys = async () => { tid('keys-btn').click(); return waitFor(() => tid('keys-popover')); };

  it('opens below ⓘ with the focus in it, lists every shortcut in groups, and closes with ⓘ again', async () => {
    await boot({ tabs: AB });
    const pop = await openKeys();
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.getAttribute('aria-modal')).toBe('true');
    expect(tid('keys-btn').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(tid('keys-close'));
    expect(tids('keys-group-title').map((x) => x.textContent)).toEqual([t('keysGroupOpen'), t('keysGroupMove'), t('keysGroupAct'), t('keysGroupSearch'), t('keysGroupPalette'), t('keysGroupEsc')]);
    const keys = tids('keys-key').map((x) => x.textContent);
    for (const k of ['Alt+Q', 'Alt+W', 'Alt+E', 'Alt+Tab', 'Alt+1', 'Ctrl+←', 'Enter', 'Shift+Enter', 'Space', 'Del', 'Ctrl+Z', 'Alt+S', 'Alt+P', 'Shift+F10', 'Ctrl+Space', 'Ctrl+F', 'Esc']) expect(keys, k).toContain(k);
    for (const k of [t('kbdClick', { key: 'Shift' }), t('kbdClick', { key: 'Ctrl' }), t('kbdClickBox', { key: 'Shift' }), t('kbdRight'), t('kbdMiddle'), t('kbdLetGo', { key: 'Alt' }), t('kbdWheel', { key: 'Alt' })]) expect(keys, k).toContain(k);
    const actions = tids('keys-action').map((x) => x.textContent);
    expect(actions).toContain(t('keyPrevTab'));
    expect(actions).toContain(t('keyNextTab'));
    expect(actions).toContain(t('keyEsc'));
    tid('keys-btn').click();
    await tick(20);
    expect(tid('keys-popover')).toBe(null);
    expect(tid('keys-btn').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps Tab inside, and Esc, its × or a press outside close it, with the focus back on ⓘ', async () => {
    const sw = await boot({ tabs: AB });
    await openKeys();
    expect(key('Tab').defaultPrevented).toBe(true); // its only control: Tab stays on it
    expect(document.activeElement).toBe(tid('keys-close'));
    key('Escape');
    expect(tid('keys-popover')).toBe(null);
    expect(document.activeElement).toBe(tid('keys-btn'));
    expect(sw.state.done).toBe(false);
    await openKeys();
    tid('keys-close').click();
    expect(tid('keys-popover')).toBe(null);
    await openKeys();
    await tick();
    tid('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('keys-popover')).toBe(null);
    expect(document.activeElement).toBe(tid('keys-btn'));
  });

  it('names the keys as on this keyboard (not a Mac here: Alt, Ctrl)', async () => {
    const sw = await boot({ tabs: AB });
    expect(sw.IS_MAC).toBe(false);
    const keys = sw.shortcutGroups().flatMap(([, , rows]) => rows.flatMap(([k]) => k));
    expect(keys).toContain('Alt+Q');
    expect(keys).not.toContain('⌥Q');
  });
});

describe('Settings: the new groups and switches', () => {
  const open = async () => { tid('settings-btn').click(); return waitFor(() => tid('settings')); };

  it('is grouped: Appearance, Cards, Search, Behaviour', async () => {
    await boot({ tabs: AB });
    await open();
    expect(tids('settings-group-title').map((x) => x.textContent)).toEqual([t('setGroupLook'), t('setGroupCards'), t('setGroupSearch'), t('setGroupBehave')]);
    expect(tid('settings').style.maxHeight).not.toBe(''); // scrolls inside on a short window
  });

  it('with no theme saved, "Match system" is the one chosen', async () => {
    await boot({ tabs: AB });
    await open();
    expect(tid('settings-theme').value).toBe('system');
  });

  it('every switch shows its stored value and saves', async () => {
    await boot({ tabs: AB });
    await open();
    const want = { 'pinned-first': ['pinnedFirst', true], 'show-closed': ['showClosed', true], 'show-snoozed': ['showSnoozed', true], 'show-age': ['showAge', true], 'own-window': ['ownWindow', false], 'search-history': ['searchHistory', true], 'search-bookmarks': ['searchBookmarks', true] };
    for (const [id, [k, on]] of Object.entries(want)) {
      const box = tid('settings-' + id);
      expect(box.checked, id).toBe(on);
      box.checked = !on;
      box.dispatchEvent(new Event('change'));
      await vi.waitFor(async () => expect((await prefs())[k], id).toBe(!on));
    }
  });

  it('Show Recently closed / Show Snoozed off hide those sections at once', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    const snz = { id: 'z1', url: 'https://snz.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    const sw = await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ snoozed: [snz] }) });
    expect(tid('closed-section').hidden).toBe(false);
    expect(tid('snoozed-section').hidden).toBe(false);
    await open();
    for (const id of ['show-closed', 'show-snoozed']) { const b = tid('settings-' + id); b.checked = false; b.dispatchEvent(new Event('change')); }
    await waitFor(() => tid('closed-section').hidden && tid('snoozed-section').hidden);
    expect(sw.state.entries.every((e) => e.kind === 'tab')).toBe(true);
  });

  it('Title lines: two by default; one takes html.lines2 away', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    expect(tid('settings-title-lines').value).toBe('2');
    tid('select-settings-title-lines').click();
    tids('menu-item')[1].click();
    await vi.waitFor(async () => expect((await prefs()).titleLines).toBe(1));
    expect(document.documentElement.classList.contains('lines2')).toBe(false);
    expect(sw.state.prefs.titleLines).toBe(1);
  });

  it('Search switches change the placeholder', async () => {
    await boot({ tabs: AB });
    await open();
    const h = tid('settings-search-history');
    h.checked = false;
    h.dispatchEvent(new Event('change'));
    await waitFor(() => tid('search').placeholder === t('searchPhNoHistory'));
  });

  it('"Replay the tour" closes Settings and starts the tour', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    tid('settings-tour').click();
    expect(tid('settings')).toBe(null);
    expect(sw.state.modal).toBe('tour');
    expect(tid('tour-step-number').textContent).toBe('1');
  });

  it('"Keyboard and mouse shortcuts" opens the shortcuts card', async () => {
    await boot({ tabs: AB });
    await open();
    tid('settings-keys').click();
    expect(tid('settings')).toBe(null);
    expect(tid('keys-popover')).not.toBe(null);
  });
});

describe('Recently closed: Show more', () => {
  const closed = (n) => Array.from({ length: n }, (_, i) => ({ lastModified: Math.floor(Date.now() / 1000) - 60 - i, tab: { sessionId: 's' + i, url: `https://gone${i}.example/`, title: 'Gone ' + i } }));

  it('shows the first few; "Show more" (a button, reachable by Tab) shows up to the search limit, "Show fewer" goes back', async () => {
    chrome._data.closed = closed(14);
    const sw = await boot({ tabs: AB });
    const n = () => sw.state.entries.filter((e) => e.kind === 'closed').length;
    expect(n()).toBe(8);
    const more = tid('closed-more');
    expect(more.hidden).toBe(false);
    expect(more.tagName).toBe('BUTTON');
    expect(more.textContent).toBe(t('closedMore'));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    expect(n()).toBe(14);
    expect(tid('closed-more').textContent).toBe(t('closedFewer'));
    expect(tid('closed-more').getAttribute('aria-expanded')).toBe('true');
    tid('closed-more').click();
    expect(n()).toBe(8);
  });

  it('is not offered when everything already shows', async () => {
    chrome._data.closed = closed(3);
    await boot({ tabs: AB });
    expect(tid('closed-more').hidden).toBe(true);
  });
});
