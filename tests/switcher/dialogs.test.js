// Dialogs (the first-run tour, the review prompt), the alert bar and its health checks, Settings and the ⓘ card.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText, closedMsg } from './quiet-boot.js';
import { t } from '../../utils/translations.js';
import { REVIEW_URL } from '../../utils/constants.js';
import { SETTINGS_TABS } from '../../utils/store.js';
import MANIFEST from '../../manifest.json';
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
    expect(sw.TOUR.map((s) => s.id)).toEqual(['switch', 'move', 'search', 'palette', 'cards', 'later', 'views', 'many', 'sort', 'settings']);
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
    expect(tid('menu-btn').classList.contains('tour-hl')).toBe(true);
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
  const open = async () => { tid('settings-btn').click(); await waitFor(() => tid('settings')); await tick(); return tid('settings'); };
  const tab = (id) => tid('settings-tab-' + id);
  const panel = (id) => tid('settings-panel-' + id);
  const shownPanels = () => SETTINGS_TABS.filter((id) => !panel(id).hidden);
  const view = () => local('view');
  const backdropClick = () => {
    const back = tid('settings-backdrop');
    back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  it('is a modal dialog: a title, its ×, the categories as tabs and the chosen one\'s panel; the rest is inert', async () => {
    const sw = await boot({ tabs: AB });
    expect(sw.SETTINGS_CATS.map((c) => c.id)).toEqual(SETTINGS_TABS); // what the store accepts
    const dlg = await open();
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dlg.getAttribute('aria-labelledby'))).toBe(tid('settings-title'));
    expect(tid('settings-title').textContent).toBe(t('settings'));
    expect(tid('settings-close').getAttribute('aria-label')).toBe(t('setClose'));
    const list = tid('settings-tabs');
    expect(list.getAttribute('role')).toBe('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(tids('settings-tab-label').map((x) => x.textContent)).toEqual([t('setGroupLook'), t('setGroupCards'), t('setGroupSearch'), t('setGroupBehave'), t('setGroupKeys')]);
    expect(tids('settings-tab-icon')).toHaveLength(5);
    for (const id of SETTINGS_TABS) {
      expect(tab(id).getAttribute('role')).toBe('tab');
      expect(document.getElementById(tab(id).getAttribute('aria-controls'))).toBe(panel(id));
      expect(panel(id).getAttribute('role')).toBe('tabpanel');
      expect(document.getElementById(panel(id).getAttribute('aria-labelledby'))).toBe(tab(id));
    }
    expect(shownPanels()).toEqual(['look']);
    expect(tab('look').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('look'));
    expect(tid('header').hasAttribute('inert')).toBe(true);
    expect(tid('scroller').closest('[inert]')).not.toBe(null);
    expect(tid('settings-backdrop').hasAttribute('inert')).toBe(false);
  });

  it('closes with ×, Esc, a click on the backdrop or the gear again, giving the focus back to the gear', async () => {
    const sw = await boot({ tabs: AB });
    const closed = () => {
      expect(tid('settings')).toBe(null);
      expect(document.activeElement).toBe(tid('menu-btn'));
      expect(tid('header').hasAttribute('inert')).toBe(false);
    };
    await open();
    tid('settings-close').click();
    closed();
    await open();
    key('Escape');
    closed();
    await open();
    tid('settings').dispatchEvent(new MouseEvent('click', { bubbles: true })); // inside: stays
    expect(tid('settings')).not.toBe(null);
    backdropClick();
    closed();
    await open();
    await sw.openSettings(tid('settings-btn')); // what the gear does (behind the backdrop, it can't be clicked)
    closed();
    expect(sw.state.done).toBe(false);
  });

  it('a press on the backdrop that only closes a select\'s list leaves Settings open', async () => {
    await boot({ tabs: AB });
    await open();
    tid('select-settings-theme').click();
    expect(tid('menu')).not.toBe(null);
    expect(tid('menu').hasAttribute('inert')).toBe(false);
    await tick(); // the list's press-outside listener
    backdropClick();
    expect(tid('menu')).toBe(null);
    expect(tid('settings')).not.toBe(null);
  });

  it('↑/↓, Home and End move between the categories and show each at once; the last one is remembered', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    expect(key('ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tab('cards'));
    expect(shownPanels()).toEqual(['cards']);
    expect(tab('look').tabIndex).toBe(-1);
    expect(tab('cards').tabIndex).toBe(0);
    key('ArrowUp');
    expect(document.activeElement).toBe(tab('look'));
    key('ArrowUp'); // wraps around
    expect(document.activeElement).toBe(tab('keys'));
    key('Home');
    expect(shownPanels()).toEqual(['look']);
    key('ArrowRight'); // ←/→ only when the tabs are a row
    expect(shownPanels()).toEqual(['look']);
    key('End');
    expect(shownPanels()).toEqual(['keys']);
    await vi.waitFor(async () => expect((await view()).settingsTab).toBe('keys'));
    tab('search').click();
    expect(shownPanels()).toEqual(['search']);
    await vi.waitFor(async () => expect((await view()).settingsTab).toBe('search'));
    key('Escape');
    await open();
    expect(shownPanels()).toEqual(['search']);
    expect(document.activeElement).toBe(tab('search'));
    expect(sw.state.done).toBe(false);
  });

  it('opens on the stored category, or on Appearance when that is not one', async () => {
    await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ view: { settingsTab: 'behave' } }) });
    await open();
    expect(shownPanels()).toEqual(['behave']);
    await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ view: { settingsTab: 'nope' } }) });
    await open();
    expect(shownPanels()).toEqual(['look']);
  });

  it('in a narrow window the categories are a row of tabs (horizontal: ←/→ move too)', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    sw.settingsLayout(sw.SETTINGS_NARROW_W - 1);
    expect(tid('settings').classList.contains('narrow')).toBe(true);
    expect(tid('settings-tabs').getAttribute('aria-orientation')).toBe('horizontal');
    key('ArrowRight');
    expect(document.activeElement).toBe(tab('cards'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(tab('look'));
    key('ArrowDown');
    expect(document.activeElement).toBe(tab('cards'));
    sw.settingsLayout(1280);
    expect(tid('settings').classList.contains('narrow')).toBe(false);
    expect(tid('settings-tabs').getAttribute('aria-orientation')).toBe('vertical');
  });

  it('every control is in its category', async () => {
    await boot({ tabs: AB });
    await open();
    const has = (id, ...testids) => { for (const x of testids) expect(panel(id).contains(tid(x)), x).toBe(true); };
    has('look', 'settings-language', 'settings-theme', 'settings-accents', 'settings-card-size', 'settings-title-lines');
    has('cards', 'settings-pinned-first', 'settings-show-age', 'settings-show-closed', 'settings-show-snoozed', 'settings-all-windows');
    has('search', 'settings-search-history', 'settings-search-bookmarks');
    has('behave', 'settings-own-window', 'settings-startup', 'settings-tour');
    has('keys', 'settings-keys-chrome', 'settings-keys-inside', 'settings-keys-change-all');
    expect(tid('settings-shortcut')).toBe(null); // the old links are gone: Shortcuts replaces them
    expect(tid('settings-keys')).toBe(null);
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
    expect(document.activeElement).toBe(tid('select-settings-card-size'));
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

  it('with no theme saved, "Match system" is the one chosen', async () => {
    await boot({ tabs: AB });
    await open();
    expect(tid('settings-theme').value).toBe('system');
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

  it('every switch shows its stored value and saves', async () => {
    await boot({ tabs: AB });
    await open();
    const want = { 'pinned-first': ['pinnedFirst', true], 'show-closed': ['showClosed', true], 'show-snoozed': ['showSnoozed', true], 'show-age': ['showAge', true], 'show-groups': ['showGroups', true], 'group-wrap': ['groupWrap', false], 'own-window': ['ownWindow', false], 'search-history': ['searchHistory', true], 'search-bookmarks': ['searchBookmarks', true] };
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

  it('a new language persists and redraws Settings, still open, on the same category, the focus on the language', async () => {
    await boot({ tabs: AB });
    await open();
    tab('cards').click();
    tab('look').click();
    tid('select-settings-language').click();
    tids('menu-item').find((x) => x.textContent === 'Русский').click();
    await waitFor(() => tid('settings-title')?.textContent === RU.settings);
    expect(tids('settings')).toHaveLength(1);
    expect(tids('settings-backdrop')).toHaveLength(1);
    expect(shownPanels()).toEqual(['look']);
    expect(tid('settings-tab-label', tab('keys')).textContent).toBe(RU.setGroupKeys);
    expect(document.activeElement).toBe(tid('select-settings-language'));
    expect(document.documentElement.lang).toBe('ru');
    expect(tid('newtab-label').textContent).toBe(RU.newTab); // the page too
    expect((await prefs()).lang).toBe('ru');
    expect(tid('header').hasAttribute('inert')).toBe(true);
  });

  it('Ctrl+H over Settings: Settings closes and the history comes in its place, usable; Esc closes it', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    key('h', { code: 'KeyH', ctrlKey: true });
    await waitFor(() => sw.historyOpen());
    expect(tid('settings')).toBe(null);
    expect(tid('settings-backdrop')).toBe(null);
    expect(tid('history-overlay').hasAttribute('inert')).toBe(false);
    key('Escape', { target: tid('history-search') });
    expect(sw.historyOpen()).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('Ctrl+Shift+O over Settings: Settings closes and the bookmarks come in its place, usable; Esc closes them', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true });
    await waitFor(() => sw.bookmarksOpen());
    expect(tid('settings')).toBe(null);
    expect(tid('settings-backdrop')).toBe(null);
    expect(tid('bookmarks-overlay').hasAttribute('inert')).toBe(false);
    key('Escape', { target: tid('bookmarks-search') });
    expect(sw.bookmarksOpen()).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('"Replay the tour" closes Settings and starts the tour', async () => {
    const sw = await boot({ tabs: AB });
    await open();
    tid('settings-tour').click();
    expect(tid('settings')).toBe(null);
    expect(sw.state.modal).toBe('tour');
    expect(tid('tour-step-number').textContent).toBe('1');
  });
});

describe('Settings -> Shortcuts', () => {
  const open = async () => {
    tid('settings-btn').click();
    await waitFor(() => tid('settings'));
    tid('settings-tab-keys').click();
    await waitFor(() => tids('settings-command').length);
    return tid('settings-panel-keys');
  };
  const rows = () => tids('settings-command');
  const keysOf = (row) => tids('settings-command-key', row).map((k) => k.textContent);
  const cmds = (shortcuts) => Object.entries(shortcuts).map(([name, shortcut]) => ({ name, description: '', shortcut }));

  it('lists every command of manifest.json with the key Chrome has for it; an unassigned one says "Not set"', async () => {
    const sw = await boot({ tabs: AB });
    expect(sw.COMMANDS.map((c) => c.name)).toEqual(Object.keys(MANIFEST.commands));
    chrome.commands.getAll.mockImplementation(async () => cmds({ 'open-switcher': 'Alt+Q', 'open-switcher-reverse': '', 'open-switcher-stay': 'Alt+E', 'open-palette': 'Ctrl+Shift+Y' }));
    const pane = await open();
    expect(tid('settings-keys-chrome-title', pane).textContent).toBe(t('setKeysChrome'));
    expect(tid('settings-keys-chrome-note', pane).textContent).toBe(t('setKeysChromeNote'));
    expect(tids('settings-command-name').map((x) => x.textContent)).toEqual([t('setKeyPrev'), t('setKeyNext'), t('setKeyStay'), t('setKeyPalette')]);
    expect(tids('settings-command-desc').map((x) => x.textContent)).toEqual([t('cmdOpen'), t('cmdReverse'), t('cmdStay'), t('cmdPalette')]);
    const [prev, next, stay, palette] = rows();
    expect(keysOf(prev)).toEqual(['Alt', 'Q']);
    expect(keysOf(stay)).toEqual(['Alt', 'E']);
    expect(keysOf(palette)).toEqual(['Ctrl', 'Shift', 'Y']);
    expect(keysOf(next)).toEqual([]);
    expect(tid('settings-command-unset', next).textContent).toBe(t('setKeysUnset'));
    expect(tid('settings-command-unset-note', next).textContent).toBe(t('setKeysUnsetNote', { key: 'Alt+W' }));
    expect(tid('settings-command-unset', prev)).toBe(null);
    expect(tids('settings-command-change').map((b) => b.getAttribute('aria-label'))).toEqual(
      [t('setKeyPrev'), t('setKeyNext'), t('setKeyStay'), t('setKeyPalette')].map((name) => t('setKeysChangeAria', { name })));
  });

  it('Chrome\'s Mac form ("⌥Q") gets one keycap per key; a failed read shows them all as not set', async () => {
    const sw = await boot({ tabs: AB });
    expect(sw.keyCaps('⌥Q')).toEqual(['⌥', 'Q']);
    expect(sw.keyCaps('Ctrl+Shift+Y')).toEqual(['Ctrl', 'Shift', 'Y']);
    chrome.commands.getAll.mockImplementation(async () => { throw new Error('no'); });
    await open();
    expect(tids('settings-command-unset')).toHaveLength(4);
  });

  it('"Change" on a row and "Change in Chrome" open Chrome\'s shortcuts page', async () => {
    for (const testid of ['settings-command-change', 'settings-keys-change-all']) {
      await boot({ tabs: AB });
      await open();
      tid(testid).click();
      await waitFor(() => closedMsg());
      expect(chrome.tabs.create, testid).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts', windowId: 1, active: true });
      chrome.runtime.sendMessage.mockClear();
      chrome.tabs.create.mockClear();
    }
  });

  it('reads the keys again when the window gets the focus back (from Chrome\'s page), only while open', async () => {
    await boot({ tabs: AB });
    chrome.commands.getAll.mockImplementation(async () => cmds({ 'open-switcher': '', 'open-switcher-reverse': 'Alt+W', 'open-switcher-stay': 'Alt+E', 'open-palette': 'Alt+R' }));
    await open();
    expect(tid('settings-command-unset', rows()[0])).not.toBe(null);
    chrome.commands.getAll.mockImplementation(async () => cmds({ 'open-switcher': 'Alt+Z', 'open-switcher-reverse': 'Alt+W', 'open-switcher-stay': 'Alt+E', 'open-palette': 'Alt+R' }));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => keysOf(rows()[0]).join('+') === 'Alt+Z');
    expect(tids('settings-command-unset')).toHaveLength(0);
    key('Escape');
    const calls = chrome.commands.getAll.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await tick(10);
    expect(chrome.commands.getAll.mock.calls.length).toBe(calls);
  });

  it('"Inside Tabazing" lists the keys inside the switcher, as the ⓘ card does', async () => {
    const sw = await boot({ tabs: AB });
    const pane = await open();
    const inside = tid('settings-keys-inside', pane);
    expect(tid('settings-keys-inside-title', inside).textContent).toBe(t('setKeysInside'));
    expect(tids('keys-group-title', inside).map((x) => x.textContent)).toEqual(sw.shortcutGroups().map(([, name]) => name));
    const keys = tids('keys-key', inside).map((x) => x.textContent);
    for (const k of ['Alt+Q', 'Enter', 'Ctrl+Z', 'Esc']) expect(keys, k).toContain(k);
    expect(new Set(tids('keys-group-title', inside).map((x) => x.id)).size).toBe(sw.shortcutGroups().length);
    expect(tids('keys-group-title', inside).every((x) => x.id.startsWith('skg-'))).toBe(true);
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
    expect(tids('keys-group-title').map((x) => x.textContent)).toEqual([t('keysGroupOpen'), t('keysGroupMove'), t('keysGroupAct'), t('keysGroupSearch'), t('keysGroupPalette'), t('keysGroupViews'), t('keysGroupEsc')]);
    const keys = tids('keys-key').map((x) => x.textContent);
    for (const k of ['Alt+Q', 'Alt+W', 'Alt+E', 'Alt+Tab', 'Alt+1', 'Ctrl+←', 'Enter', 'Shift+Enter', 'Space', 'Del', 'Ctrl+Z', 'Alt+S', 'Alt+P', 'Shift+F10', 'Ctrl+Space', 'Ctrl+F', 'Esc']) expect(keys, k).toContain(k);
    for (const k of [t('kbdClick', { key: 'Shift' }), t('kbdClick', { key: 'Ctrl' }), t('kbdClickBox', { key: 'Shift' }), t('kbdRight'), t('kbdMiddle'), t('kbdLetGo', { key: 'Alt' }), t('kbdWheel', { key: 'Alt' })]) expect(keys, k).toContain(k);
    const actions = tids('keys-action').map((x) => x.textContent);
    expect(actions).toContain(t('keyPrevTab'));
    expect(actions).toContain(t('keyNextTab'));
    expect(actions).toContain(t('keyEsc'));
    expect(tid('keys-settings-note', pop).textContent).toBe(t('keysInSettings')); // where the keys that open Tabazing change
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
