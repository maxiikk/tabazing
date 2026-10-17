// Dialogs (the first-run tour, the review prompt), the alert bar and its health checks, and Settings.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText, closedMsg } from './quiet-boot.js';
import { t, tn } from '../../lib/i18n.js';
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
    const n = sw.TOUR_ALL.length;
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
    sw.tourStep(sw.TOUR_ALL.length - 1);
    key('ArrowRight');
    expect(modalOpen()).toBe(false);
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
    expect(toastText()).toBe(t('iconTip', 'Alt+Q'));
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
    expect(tid('sweep-text').textContent).toBe(tn('sweepAll', 2)); // B and C: not the current tab, not chrome://
    sw.state.query = 'c';
    sw.updateSweepButton();
    expect(tid('sweep-text').textContent).toBe(tn('sweepThese', 2));
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
