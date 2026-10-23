// Dialogs (the first-run tour, the review prompt), the alert bar and its health checks, Settings and the ⓘ card.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, toastText, closedMessage } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';
import { REVIEW_URL } from '../../utils/constants.js';
import { SETTINGS_TABS } from '../../utils/store.js';
import MANIFEST from '../../manifest.json';
import RU from '../../dictionaries/ru.json';

const defaultTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const local = async (storageKey) => (await chrome.storage.local.get(storageKey))[storageKey];
const preferences = () => local('prefs');
const modalOpen = () => !byTestId('modal').hidden;

describe('showDialog / closeDialog', () => {
  it('shows the nodes, focuses the main button, and closing goes back to the search box', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const quiet = switcher.button('q', 'Later', 'quiet', () => {});
    const main = switcher.button('m', 'Go', 'primary', () => {});
    switcher.showDialog('ask', [switcher.paragraph('Hello'), quiet, main]);
    expect(modalOpen()).toBe(true);
    expect(switcher.state.modal).toBe('ask');
    expect(byTestId('dialog-text', byTestId('dialog')).textContent).toBe('Hello');
    expect(document.activeElement).toBe(main);
    cardOf('B').classList.add('tour-highlight');
    switcher.closeDialog();
    expect(modalOpen()).toBe(false);
    expect(switcher.state.modal).toBe(null);
    expect(cardOf('B').classList.contains('tour-highlight')).toBe(false);
    expect(document.activeElement).toBe(byTestId('search'));
  });
});

describe('whenTapMode', () => {
  it('runs once Alt is no longer held, not while a dialog is open or text is typed', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const callback = vi.fn();
    switcher.state.holding = true;
    switcher.whenTapMode(callback);
    await tick(400);
    expect(callback).not.toHaveBeenCalled();
    switcher.state.holding = false;
    await waitFor(() => callback.mock.calls.length);

    const typed = vi.fn();
    byTestId('search').value = 'x';
    switcher.whenTapMode(typed);
    switcher.state.modal = null;
    const busy = vi.fn();
    await tick(400);
    expect(typed).not.toHaveBeenCalled();
    byTestId('search').value = '';
    switcher.state.modal = 'ask';
    switcher.whenTapMode(busy);
    await tick(400);
    expect(busy).not.toHaveBeenCalled();
  });
});

describe('the tour', () => {
  it('walks through every step: Next, Back, then Done remembers it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.tourStep(0);
    const stepCount = switcher.TOUR.length; // the steps for what is on screen (one window, nothing playing: no windows or media step)
    expect(switcher.TOUR.map((step) => step.id)).toEqual(['switch', 'move', 'search', 'palette', 'cards', 'later', 'views', 'many', 'sort', 'settings']);
    expect(switcher.state.modal).toBe('tour');
    expect(byTestId('dialog-title').textContent).toBe(translate('tourSwitchTitle'));
    expect(byTestId('tour-step-number').textContent).toBe('1');
    expect(byTestId('tour-step-of').textContent).toBe(`1 / ${stepCount}`);
    expect(byTestId('tour-back')).toBe(null);
    expect(byTestId('tour-skip')).not.toBe(null);
    expect(allByTestId('card-tab').find((card) => card.getAttribute('aria-selected') === 'true').classList.contains('tour-highlight')).toBe(true);
    byTestId('tour-next').click();
    expect(byTestId('dialog-title').textContent).toBe(translate('tour2Title'));
    byTestId('tour-back').click();
    expect(byTestId('tour-step-number').textContent).toBe('1');
    for (let i = 1; i < stepCount; i++) byTestId('tour-next').click();
    expect(byTestId('dialog-title').textContent).toBe(translate('tourSettingsTitle'));
    expect(byTestId('menu-button').classList.contains('tour-highlight')).toBe(true);
    expect(byTestId('tour-next')).toBe(null);
    expect(byTestId('tour-skip')).toBe(null);
    byTestId('tour-done').click();
    expect(modalOpen()).toBe(false);
    expect(byTestId('settings-button').classList.contains('tour-highlight')).toBe(false);
    await vi.waitFor(async () => expect(await local('onb')).toMatchObject({ tour: true, flyout: true }));
  });

  it('Skip ends it; arrows step through it; Esc ends it without closing the switcher', async () => {
    const switcher = await boot({ tabs: defaultTabs, beforeImport: () => chrome.storage.local.set({ onb: { tour: false } }) });
    await chrome.storage.local.set({ onb: { tour: false } });
    switcher.tourStep(0);
    byTestId('tour-skip').click();
    expect(modalOpen()).toBe(false);
    await vi.waitFor(async () => expect((await local('onb')).tour).toBe(true));

    switcher.tourStep(0);
    key('ArrowRight');
    expect(byTestId('tour-step-number').textContent).toBe('2');
    key('ArrowLeft');
    key('ArrowLeft'); // stays on the first
    expect(byTestId('tour-step-number').textContent).toBe('1');
    key('Escape');
    expect(modalOpen()).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  it('ArrowRight on the last step ends it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.tourStep(0);
    switcher.tourStep(switcher.TOUR.length - 1);
    key('ArrowRight');
    expect(modalOpen()).toBe(false);
  });

  it('the "many at once" step shows every tick box (and points at the selected one), until the step changes', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.tourStep(0);
    const many = switcher.TOUR.findIndex((step) => step.id === 'many');
    switcher.tourStep(many);
    expect(document.documentElement.classList.contains('tour-picking')).toBe(true);
    const selectedCard = allByTestId('card-tab').find((card) => card.getAttribute('aria-selected') === 'true');
    expect(byTestId('card-pick', selectedCard).classList.contains('tour-highlight')).toBe(true);
    expect(byTestId('dialog-text').textContent).toBe(translate('tourManyBody', { key: 'Ctrl' }));
    switcher.tourStep(many + 1);
    expect(document.documentElement.classList.contains('tour-picking')).toBe(false);
    switcher.tourStep(many);
    key('Escape');
    expect(document.documentElement.classList.contains('tour-picking')).toBe(false);
  });

  it('adds a windows step and a media step when those are on screen', async () => {
    const switcher = await boot({ tabs: defaultTabs, preferences: { allWindows: true }, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'W', url: 'https://w.example/' }); } });
    switcher.state.media = [{ tabId: switcher.state.tabs[0].id, frameId: 0, tab: switcher.state.tabs[0], title: 'Song', site: 'a.example', playing: true }];
    switcher.renderPlayer();
    switcher.tourStep(0);
    const ids = switcher.TOUR.map((step) => step.id);
    expect(ids).toContain('windows');
    expect(ids).toContain('player');
    switcher.tourStep(ids.indexOf('windows'));
    expect(byTestId('windows').classList.contains('tour-highlight')).toBe(true);
    expect(byTestId('dialog-title').textContent).toBe(translate('tourWindowTitle'));
    switcher.tourStep(ids.indexOf('player'));
    expect(byTestId('player').classList.contains('tour-highlight')).toBe(true);
  });

  it('every step says Alt+Q / Alt+W the corrected way: previous / next card in the list, wrapping around', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.tourStep(0);
    expect(byTestId('dialog').textContent).toContain(translate('keyPreviousTab'));
    expect(byTestId('dialog').textContent).toContain(translate('keyNextTab'));
    expect(translate('tourSwitchBody')).toMatch(/Hold Alt and press Q/);
    expect(translate('keyPreviousTab')).toBe('previous card in the list (wraps around)');
  });

  it('placeTour puts the card next to its target, or nowhere in particular without one', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const dialog = byTestId('dialog');
    const target = byTestId('search');
    target.getBoundingClientRect = () => ({ left: 100, right: 300, top: 10, bottom: 40, width: 200, height: 30 });
    switcher.placeTour(target);
    expect(dialog.dataset.side).toBe('below'); // the top strip: below it
    expect(dialog.style.top).toBe('58px');
    switcher.placeTour(null);
    expect(dialog.dataset.side).toBeUndefined();
    expect(dialog.style.left).toBe('');
  });
});

describe('the review prompt', () => {
  it('step 1 offers moods, "don\'t ask again" and "not now"', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.askStep1();
    expect(byTestId('dialog-title').textContent).toBe(translate('askTitle'));
    expect(['good', 'okay', 'bad'].map((mood) => byTestId('ask-mood-' + mood).textContent)).toEqual([translate('moodGood'), translate('moodOkay'), translate('moodBad')]);
    byTestId('ask-not-now').click();
    expect(modalOpen()).toBe(false);
    switcher.askStep1();
    byTestId('ask-dont-ask').click();
    expect(modalOpen()).toBe(false);
    await vi.waitFor(async () => expect((await local('rv')).done).toBe(true));
  });

  it('a good mood offers the store review, which opens it and stops asking', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.askStep1();
    byTestId('ask-mood-good').click();
    expect(byTestId('dialog-title').textContent).toBe(translate('askGoodTitle'));
    expect(byTestId('ask-survey')).toBe(null);
    expect(byTestId('ask-note').textContent).toBe(translate('askNote'));
    byTestId('ask-review').click();
    await waitFor(() => closedMessage());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: REVIEW_URL, windowId: 1, active: true });
    expect((await local('rv')).done).toBe(true);
  });

  it('another mood offers the survey too, with the mood in its address', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.askStep2('bad');
    expect(byTestId('dialog-title').textContent).toBe(translate('askBadTitle'));
    expect(byTestId('ask-review')).not.toBe(null);
    byTestId('ask-survey').click();
    await waitFor(() => closedMessage());
    const url = chrome.tabs.create.mock.calls[0][0].url;
    expect(url).toMatch(/\/survey\?from=extension-prompt&v=[\d.]+&lang=en&mood=bad$/);
    expect(closedMessage().reason).toBe('switch');
  });

  it('Esc puts it off (askLater)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.askStep1();
    key('Escape');
    expect(modalOpen()).toBe(false);
    expect(switcher.state.done).toBe(false);
    expect((await local('rv')).done).toBe(false); // it will ask again
  });

  it('openUrl opens the page in this window and closes the switcher', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await switcher.openUrl('https://x.example/');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://x.example/', windowId: 1, active: true });
    expect(closedMessage().reason).toBe('switch');
  });
});

describe('dialogKey', () => {
  it('lets other keys through to the dialog', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.askStep1();
    const event = key('Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(closedMessage()).toBeUndefined(); // Enter did not open a tab
  });
});

describe('firstRun', () => {
  it('starts the tour on a first open, and counts the open', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await chrome.storage.local.set({ onb: { tour: false, flyout: false } });
    const opens = (await local('rv')).opens;
    await switcher.firstRun();
    expect((await local('rv')).opens).toBe(opens + 1);
    await waitFor(() => switcher.state.modal === 'tour');
    expect(byTestId('tour-step-number').textContent).toBe('1');
    expect((await local('onb')).flyout).toBe(true);
  });

  it('after the tour shows nothing (the review prompt is turned off)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await switcher.firstRun();
    await tick(400);
    expect(modalOpen()).toBe(false);
  });
});

describe('alerts and health checks', () => {
  it('showAlert: text, an optional button, and the detail as a tooltip', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const callback = vi.fn();
    switcher.showAlert('Problem', 'Fix', callback, 'why');
    expect(byTestId('alert').hidden).toBe(false);
    expect(byTestId('alert-text').textContent).toBe('Problem');
    expect(byTestId('alert').title).toBe('why');
    expect(byTestId('alert-button').textContent).toBe('Fix');
    byTestId('alert-button').click();
    expect(callback).toHaveBeenCalled();
    switcher.showAlert('Just this');
    expect(byTestId('alert-button').hidden).toBe(true);
  });

  it('a missing Alt+Q shortcut gets an alert that opens the shortcuts page', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.commands.getAll.mockResolvedValueOnce([{ name: 'open-switcher', shortcut: '' }]);
    await switcher.healthCheck();
    expect(byTestId('alert-text').textContent).toBe(translate('shortcutMissing'));
    expect(byTestId('alert-button').textContent).toBe(translate('settingsShortcut'));
    byTestId('alert-button').click();
    await waitFor(() => closedMessage());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts', windowId: 1, active: true });
  });

  it('withheld site access gets an alert that asks for it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.permissions.contains.mockResolvedValueOnce(false);
    await switcher.healthCheck();
    expect(switcher.state.hostAllowed).toBe(false);
    expect(byTestId('alert-text').textContent).toBe(translate('hostBlocked'));
    expect(byTestId('alert').title).toBe(translate('hostBlockedTip'));
    expect(byTestId('sweep-button').hidden).toBe(true);
    byTestId('alert-button').click();
    await waitFor(() => byTestId('alert-text').textContent === translate('hostThanks'));
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(window.focus).toHaveBeenCalled();
  });

  it('a recent screenshot error on this page is explained', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await chrome.storage.session.set({ capdiag: { t: Date.now(), stage: 'error', message: 'Cannot access contents of the page', host: 'a.example' } });
    await switcher.healthCheck();
    expect(byTestId('alert-text').textContent).toBe(translate('captureErrorPage'));
    expect(byTestId('alert-button').hidden).toBe(true);
    expect(byTestId('alert').title).toBe('a.example: Cannot access contents of the page');
  });

  it('opened from the toolbar icon, it tips Alt+Q', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { via: 'icon' } });
    await switcher.healthCheck();
    expect(toastText()).toBe(translate('iconTip', { key: 'Alt+Q' }));
    expect(byTestId('alert').hidden).toBe(true);
  });

  it('requestHostAccess does nothing more when refused', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.permissions.request.mockResolvedValueOnce(false);
    await switcher.requestHostAccess();
    expect(byTestId('alert').hidden).toBe(true);
  });

  it('updateSweepButton offers to capture the tabs without a preview', async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'C', url: 'https://c.example/' }, { title: 'X', url: 'chrome://extensions/' }] });
    switcher.updateSweepButton();
    expect(byTestId('sweep-button').hidden).toBe(false);
    // compact: a camera and the count; the label and tooltip say the rest
    expect(byTestId('sweep-text').textContent).toBe('2'); // B and C: not the current tab, not chrome://
    expect(byTestId('sweep-button').getAttribute('aria-label')).toBe(translate('sweepAll', { count: 2 }));
    expect(byTestId('sweep-button').title).toContain(translate('sweepTitleAll'));
    switcher.state.query = 'c';
    switcher.updateSweepButton();
    expect(byTestId('sweep-button').getAttribute('aria-label')).toBe(translate('sweepThese', { count: 2 }));
    switcher.state.hostAllowed = false;
    switcher.updateSweepButton();
    expect(byTestId('sweep-button').hidden).toBe(true);
  });
});

describe('Settings', () => {
  const open = async () => { byTestId('settings-button').click(); await waitFor(() => byTestId('settings')); await tick(); return byTestId('settings'); };

  it('Lite mode: on, the screenshots give way to the pages\' icons at once; off, they come back', async () => {
    await boot({ tabs: defaultTabs, beforeImport: () => chrome.storage.local.set(Object.fromEntries(defaultTabs.map((x) => ['pv:' + x.url, { img: 'data:image/jpeg;base64,AAAA', t: 1 }]))) });
    await waitFor(() => allByTestId('card-preview').length === defaultTabs.length);
    await open();
    byTestId('settings-lite').click();
    await waitFor(() => allByTestId('card-preview').length === 0);
    expect(allByTestId('card-icon-only').length).toBe(defaultTabs.length);
    expect(document.documentElement.classList.contains('lite')).toBe(true);
    expect(await preferences()).toMatchObject({ lite: true });
    byTestId('settings-lite').click();
    await waitFor(() => allByTestId('card-preview').length === defaultTabs.length);
    expect(document.documentElement.classList.contains('lite')).toBe(false);
    expect(await preferences()).toMatchObject({ lite: false });
  });
  const tab = (id) => byTestId('settings-tab-' + id);
  const panel = (id) => byTestId('settings-panel-' + id);
  const shownPanels = () => SETTINGS_TABS.filter((id) => !panel(id).hidden);
  const view = () => local('view');
  const backdropClick = () => {
    const back = byTestId('settings-backdrop');
    back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  it('is a modal dialog: a title, its ×, the categories as tabs and the chosen one\'s panel; the rest is inert', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    expect(switcher.SETTINGS_CATEGORIES.map((category) => category.id)).toEqual(SETTINGS_TABS); // what the store accepts
    const dialog = await open();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby'))).toBe(byTestId('settings-title'));
    expect(byTestId('settings-title').textContent).toBe(translate('settings'));
    expect(byTestId('settings-close').getAttribute('aria-label')).toBe(translate('settingsClose'));
    const list = byTestId('settings-tabs');
    expect(list.getAttribute('role')).toBe('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(allByTestId('settings-tab-label').map((x) => x.textContent)).toEqual([translate('settingsGroupLook'), translate('settingsGroupCards'), translate('settingsGroupSearch'), translate('settingsGroupBehave'), translate('settingsGroupKeys')]);
    expect(allByTestId('settings-tab-icon')).toHaveLength(5);
    for (const id of SETTINGS_TABS) {
      expect(tab(id).getAttribute('role')).toBe('tab');
      expect(document.getElementById(tab(id).getAttribute('aria-controls'))).toBe(panel(id));
      expect(panel(id).getAttribute('role')).toBe('tabpanel');
      expect(document.getElementById(panel(id).getAttribute('aria-labelledby'))).toBe(tab(id));
    }
    expect(shownPanels()).toEqual(['look']);
    expect(tab('look').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('look'));
    expect(byTestId('header').hasAttribute('inert')).toBe(true);
    expect(byTestId('scroller').closest('[inert]')).not.toBe(null);
    expect(byTestId('settings-backdrop').hasAttribute('inert')).toBe(false);
  });

  it('closes with ×, Esc, a click on the backdrop or the gear again, giving the focus back to the gear', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const closed = () => {
      expect(byTestId('settings')).toBe(null);
      expect(document.activeElement).toBe(byTestId('menu-button'));
      expect(byTestId('header').hasAttribute('inert')).toBe(false);
    };
    await open();
    byTestId('settings-close').click();
    closed();
    await open();
    key('Escape');
    closed();
    await open();
    byTestId('settings').dispatchEvent(new MouseEvent('click', { bubbles: true })); // inside: stays
    expect(byTestId('settings')).not.toBe(null);
    backdropClick();
    closed();
    await open();
    await switcher.openSettings(byTestId('settings-button')); // what the gear does (behind the backdrop, it can't be clicked)
    closed();
    expect(switcher.state.done).toBe(false);
  });

  it('a press on the backdrop that only closes a select\'s list leaves Settings open', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    byTestId('select-settings-theme').click();
    expect(byTestId('menu')).not.toBe(null);
    expect(byTestId('menu').hasAttribute('inert')).toBe(false);
    await tick(); // the list's press-outside listener
    backdropClick();
    expect(byTestId('menu')).toBe(null);
    expect(byTestId('settings')).not.toBe(null);
  });

  it('↑/↓, Home and End move between the categories and show each at once; the last one is remembered', async () => {
    const switcher = await boot({ tabs: defaultTabs });
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
    expect(switcher.state.done).toBe(false);
  });

  it('opens on the stored category, or on Appearance when that is not one', async () => {
    await boot({ tabs: defaultTabs, beforeImport: () => chrome.storage.local.set({ view: { settingsTab: 'behave' } }) });
    await open();
    expect(shownPanels()).toEqual(['behave']);
    await boot({ tabs: defaultTabs, beforeImport: () => chrome.storage.local.set({ view: { settingsTab: 'nope' } }) });
    await open();
    expect(shownPanels()).toEqual(['look']);
  });

  it('in a narrow window the categories are a row of tabs (horizontal: ←/→ move too)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open();
    switcher.settingsLayout(switcher.SETTINGS_NARROW_WIDTH - 1);
    expect(byTestId('settings').classList.contains('narrow')).toBe(true);
    expect(byTestId('settings-tabs').getAttribute('aria-orientation')).toBe('horizontal');
    key('ArrowRight');
    expect(document.activeElement).toBe(tab('cards'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(tab('look'));
    key('ArrowDown');
    expect(document.activeElement).toBe(tab('cards'));
    switcher.settingsLayout(1280);
    expect(byTestId('settings').classList.contains('narrow')).toBe(false);
    expect(byTestId('settings-tabs').getAttribute('aria-orientation')).toBe('vertical');
  });

  it('every control is in its category', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    const has = (id, ...testids) => { for (const x of testids) expect(panel(id).contains(byTestId(x)), x).toBe(true); };
    has('look', 'settings-language', 'settings-theme', 'settings-accents', 'settings-card-size', 'settings-title-lines');
    has('cards', 'settings-lite', 'settings-pinned-first', 'settings-show-age', 'settings-show-closed', 'settings-show-snoozed', 'settings-all-windows');
    has('search', 'settings-search-history', 'settings-search-bookmarks');
    has('behave', 'settings-own-window', 'settings-startup', 'settings-tour');
    has('keys', 'settings-keys-chrome', 'settings-keys-inside', 'settings-keys-change-all');
    expect(byTestId('settings-shortcut')).toBe(null); // the old links are gone: Shortcuts replaces them
    expect(byTestId('settings-keys')).toBe(null);
  });

  it('shows the stored settings', async () => {
    await boot({ tabs: defaultTabs, preferences: { lang: 'en', startup: true, cardSize: 'small', accent: '#86EFAC', allWindows: true, theme: 'light' } });
    await open();
    expect(byTestId('settings-language').value).toBe('en');
    expect(byTestId('settings-startup').checked).toBe(true);
    expect(byTestId('settings-all-windows').checked).toBe(true);
    expect(byTestId('settings-card-size').value).toBe('small');
    expect(byTestId('settings-theme').value).toBe('light');
    expect(allByTestId('settings-accent').find((button) => button.getAttribute('aria-checked') === 'true').dataset.c).toBe('#86EFAC');
    expect(byTestId('select-label', byTestId('select-settings-card-size')).textContent).toBe(translate('settingsSizeSmall'));
  });

  it('startup and accent persist', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    const start = byTestId('settings-startup');
    start.checked = true;
    start.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await preferences()).startup).toBe(true));
    allByTestId('settings-accent')[3].click();
    await vi.waitFor(async () => expect((await preferences()).accent).toBe('#FCD34D'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#FCD34D');
    expect(allByTestId('settings-accent')[3].getAttribute('aria-checked')).toBe('true');
  });

  it('a custom accent is tried live and kept once chosen', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    const customAccentInput = byTestId('settings-accent-custom');
    customAccentInput.value = '#123456';
    customAccentInput.dispatchEvent(new Event('input'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');
    await tick(20);
    expect((await preferences()) || {}).not.toHaveProperty('accent', '#123456');
    expect(customAccentInput.classList.contains('on')).toBe(true);
    customAccentInput.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await preferences()).accent).toBe('#123456'));
  });

  it('card size (through its themed list) persists and redraws the cards', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open();
    byTestId('select-settings-card-size').click();
    const items = allByTestId('menu-item');
    expect(items.map((x) => x.textContent)).toEqual([translate('settingsSizeDefault'), translate('settingsSizeSmall'), translate('settingsSizeList')]);
    expect(byTestId('settings')).not.toBe(null); // the list opens over Settings, which stays
    items[2].click();
    await waitFor(() => switcher.state.cardSize === 'list');
    expect(byTestId('settings-card-size').value).toBe('list');
    expect(document.activeElement).toBe(byTestId('select-settings-card-size'));
    expect(byTestId('card-thumb', cardOf('B'))).toBe(null); // list cards have no screenshot
    await vi.waitFor(async () => expect((await preferences()).cardSize).toBe('list'));
  });

  it('theme persists and switches the colours', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    const themeSelect = byTestId('settings-theme');
    themeSelect.value = 'light';
    themeSelect.dispatchEvent(new Event('change'));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    await vi.waitFor(async () => expect((await preferences()).theme).toBe('light'));
    themeSelect.value = 'dark';
    themeSelect.dispatchEvent(new Event('change'));
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('with no theme saved, "Match system" is the one chosen', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    expect(byTestId('settings-theme').value).toBe('system');
  });

  it('"all windows" persists and shows the other windows\' tabs', async () => {
    const switcher = await boot({ tabs: defaultTabs, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Far', url: 'https://far.example/' }); } });
    expect(switcher.state.tabs.map((x) => x.title)).not.toContain('Far');
    await open();
    const all = byTestId('settings-all-windows');
    all.checked = true;
    all.dispatchEvent(new Event('change'));
    await waitFor(() => switcher.state.tabs.some((x) => x.title === 'Far'));
    expect((await preferences()).allWindows).toBe(true);
    expect(switcher.state.scope).toBe('all');
  });

  it('every switch shows its stored value and saves', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    const want = { 'pinned-first': ['pinnedFirst', true], 'show-closed': ['showClosed', true], 'show-snoozed': ['showSnoozed', true], 'show-age': ['showAge', true], 'show-groups': ['showGroups', true], 'group-wrap': ['groupWrap', false], 'own-window': ['ownWindow', false], 'search-history': ['searchHistory', true], 'search-bookmarks': ['searchBookmarks', true] };
    for (const [id, [preferenceKey, on]] of Object.entries(want)) {
      const box = byTestId('settings-' + id);
      expect(box.checked, id).toBe(on);
      box.checked = !on;
      box.dispatchEvent(new Event('change'));
      await vi.waitFor(async () => expect((await preferences())[preferenceKey], id).toBe(!on));
    }
  });

  it('Show Recently closed / Show Snoozed off hide those sections at once', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    const snoozedTab = { id: 'z1', url: 'https://snooze.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    const switcher = await boot({ tabs: defaultTabs, beforeImport: () => chrome.storage.local.set({ snoozed: [snoozedTab] }) });
    expect(byTestId('closed-section').hidden).toBe(false);
    expect(byTestId('snoozed-section').hidden).toBe(false);
    await open();
    for (const id of ['show-closed', 'show-snoozed']) { const checkbox = byTestId('settings-' + id); checkbox.checked = false; checkbox.dispatchEvent(new Event('change')); }
    await waitFor(() => byTestId('closed-section').hidden && byTestId('snoozed-section').hidden);
    expect(switcher.state.entries.every((entry) => entry.kind === 'tab')).toBe(true);
  });

  it('Title lines: two by default; one takes html.lines2 away', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open();
    expect(byTestId('settings-title-lines').value).toBe('2');
    byTestId('select-settings-title-lines').click();
    allByTestId('menu-item')[1].click();
    await vi.waitFor(async () => expect((await preferences()).titleLines).toBe(1));
    expect(document.documentElement.classList.contains('lines2')).toBe(false);
    expect(switcher.state.preferences.titleLines).toBe(1);
  });

  it('Search switches change the placeholder', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    const searchHistoryCheckbox = byTestId('settings-search-history');
    searchHistoryCheckbox.checked = false;
    searchHistoryCheckbox.dispatchEvent(new Event('change'));
    await waitFor(() => byTestId('search').placeholder === translate('searchPlaceholderNoHistory'));
  });

  it('a new language persists and redraws Settings, still open, on the same category, the focus on the language', async () => {
    await boot({ tabs: defaultTabs });
    await open();
    tab('cards').click();
    tab('look').click();
    byTestId('select-settings-language').click();
    allByTestId('menu-item').find((x) => x.textContent === 'Русский').click();
    await waitFor(() => byTestId('settings-title')?.textContent === RU.settings);
    expect(allByTestId('settings')).toHaveLength(1);
    expect(allByTestId('settings-backdrop')).toHaveLength(1);
    expect(shownPanels()).toEqual(['look']);
    expect(byTestId('settings-tab-label', tab('keys')).textContent).toBe(RU.settingsGroupKeys);
    expect(document.activeElement).toBe(byTestId('select-settings-language'));
    expect(document.documentElement.lang).toBe('ru');
    expect(byTestId('new-tab-label').textContent).toBe(RU.newTab); // the page too
    expect((await preferences()).lang).toBe('ru');
    expect(byTestId('header').hasAttribute('inert')).toBe(true);
  });

  it('Ctrl+H over Settings: Settings closes and the history comes in its place, usable; Esc closes it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open();
    key('h', { code: 'KeyH', ctrlKey: true });
    await waitFor(() => switcher.historyOpen());
    expect(byTestId('settings')).toBe(null);
    expect(byTestId('settings-backdrop')).toBe(null);
    expect(byTestId('history-overlay').hasAttribute('inert')).toBe(false);
    key('Escape', { target: byTestId('history-search') });
    expect(switcher.historyOpen()).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  it('Ctrl+Shift+O over Settings: Settings closes and the bookmarks come in its place, usable; Esc closes them', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open();
    key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true });
    await waitFor(() => switcher.bookmarksOpen());
    expect(byTestId('settings')).toBe(null);
    expect(byTestId('settings-backdrop')).toBe(null);
    expect(byTestId('bookmarks-overlay').hasAttribute('inert')).toBe(false);
    key('Escape', { target: byTestId('bookmarks-search') });
    expect(switcher.bookmarksOpen()).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  it('"Replay the tour" closes Settings and starts the tour', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open();
    byTestId('settings-tour').click();
    expect(byTestId('settings')).toBe(null);
    expect(switcher.state.modal).toBe('tour');
    expect(byTestId('tour-step-number').textContent).toBe('1');
  });
});

describe('Settings -> Shortcuts', () => {
  const open = async () => {
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings'));
    byTestId('settings-tab-keys').click();
    await waitFor(() => allByTestId('settings-command').length);
    return byTestId('settings-panel-keys');
  };
  const rows = () => allByTestId('settings-command');
  const keysOf = (row) => allByTestId('settings-command-key', row).map((keyElement) => keyElement.textContent);
  const commands = (shortcuts) => Object.entries(shortcuts).map(([name, shortcut]) => ({ name, description: '', shortcut }));

  it('lists every command of manifest.json with the key Chrome has for it; an unassigned one says "Not set"', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    expect(switcher.COMMANDS.map((command) => command.name)).toEqual(Object.keys(MANIFEST.commands));
    chrome.commands.getAll.mockImplementation(async () => commands({ 'open-switcher': 'Alt+Q', 'open-switcher-reverse': '', 'open-switcher-stay': 'Alt+E', 'open-palette': 'Ctrl+Shift+Y' }));
    const pane = await open();
    expect(byTestId('settings-keys-chrome-title', pane).textContent).toBe(translate('settingsKeysChrome'));
    expect(byTestId('settings-keys-chrome-note', pane).textContent).toBe(translate('settingsKeysChromeNote'));
    expect(allByTestId('settings-command-name').map((x) => x.textContent)).toEqual([translate('settingsKeyPrevious'), translate('settingsKeyNext'), translate('settingsKeyStay'), translate('settingsKeyPalette')]);
    expect(allByTestId('settings-command-description').map((x) => x.textContent)).toEqual([translate('commandOpen'), translate('commandReverse'), translate('commandStay'), translate('commandPalette')]);
    const [previousRow, next, stay, palette] = rows();
    expect(keysOf(previousRow)).toEqual(['Alt', 'Q']);
    expect(keysOf(stay)).toEqual(['Alt', 'E']);
    expect(keysOf(palette)).toEqual(['Ctrl', 'Shift', 'Y']);
    expect(keysOf(next)).toEqual([]);
    expect(byTestId('settings-command-unset', next).textContent).toBe(translate('settingsKeysUnset'));
    expect(byTestId('settings-command-unset-note', next).textContent).toBe(translate('settingsKeysUnsetNote', { key: 'Alt+W' }));
    expect(byTestId('settings-command-unset', previousRow)).toBe(null);
    expect(allByTestId('settings-command-change').map((button) => button.getAttribute('aria-label'))).toEqual(
      [translate('settingsKeyPrevious'), translate('settingsKeyNext'), translate('settingsKeyStay'), translate('settingsKeyPalette')].map((name) => translate('settingsKeysChangeAria', { name })));
  });

  it('Chrome\'s Mac form ("⌥Q") gets one keycap per key; a failed read shows them all as not set', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    expect(switcher.keyCaps('⌥Q')).toEqual(['⌥', 'Q']);
    expect(switcher.keyCaps('Ctrl+Shift+Y')).toEqual(['Ctrl', 'Shift', 'Y']);
    chrome.commands.getAll.mockImplementation(async () => { throw new Error('no'); });
    await open();
    expect(allByTestId('settings-command-unset')).toHaveLength(4);
  });

  it('"Change" on a row and "Change in Chrome" open Chrome\'s shortcuts page', async () => {
    for (const testid of ['settings-command-change', 'settings-keys-change-all']) {
      await boot({ tabs: defaultTabs });
      await open();
      byTestId(testid).click();
      await waitFor(() => closedMessage());
      expect(chrome.tabs.create, testid).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts', windowId: 1, active: true });
      chrome.runtime.sendMessage.mockClear();
      chrome.tabs.create.mockClear();
    }
  });

  it('reads the keys again when the window gets the focus back (from Chrome\'s page), only while open', async () => {
    await boot({ tabs: defaultTabs });
    chrome.commands.getAll.mockImplementation(async () => commands({ 'open-switcher': '', 'open-switcher-reverse': 'Alt+W', 'open-switcher-stay': 'Alt+E', 'open-palette': 'Alt+R' }));
    await open();
    expect(byTestId('settings-command-unset', rows()[0])).not.toBe(null);
    chrome.commands.getAll.mockImplementation(async () => commands({ 'open-switcher': 'Alt+Z', 'open-switcher-reverse': 'Alt+W', 'open-switcher-stay': 'Alt+E', 'open-palette': 'Alt+R' }));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => keysOf(rows()[0]).join('+') === 'Alt+Z');
    expect(allByTestId('settings-command-unset')).toHaveLength(0);
    key('Escape');
    const calls = chrome.commands.getAll.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await tick(10);
    expect(chrome.commands.getAll.mock.calls.length).toBe(calls);
  });

  it('"Inside Tabazing" lists the keys inside the switcher, as the ⓘ card does', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const pane = await open();
    const inside = byTestId('settings-keys-inside', pane);
    expect(byTestId('settings-keys-inside-title', inside).textContent).toBe(translate('settingsKeysInside'));
    expect(allByTestId('keys-group-title', inside).map((x) => x.textContent)).toEqual(switcher.shortcutGroups().map(([, name]) => name));
    const keys = allByTestId('keys-key', inside).map((x) => x.textContent);
    for (const keyCombo of ['Alt+Q', 'Enter', 'Ctrl+Z', 'Esc']) expect(keys, keyCombo).toContain(keyCombo);
    expect(new Set(allByTestId('keys-group-title', inside).map((x) => x.id)).size).toBe(switcher.shortcutGroups().length);
    expect(allByTestId('keys-group-title', inside).every((x) => x.id.startsWith('skg-'))).toBe(true);
  });
});

describe('the toolbar-icon tip', () => {
  it('shows at most three times, counting in preferences.iconTips', async () => {
    let switcher = await boot({ tabs: defaultTabs, context: { via: 'icon' }, preferences: { iconTips: 2 } });
    await switcher.healthCheck();
    expect(toastText()).toBe(translate('iconTip', { key: 'Alt+Q' }));
    await vi.waitFor(async () => expect((await preferences()).iconTips).toBe(3));
    switcher = await boot({ tabs: defaultTabs, context: { via: 'icon' } });
    switcher.toast('');
    await switcher.healthCheck();
    expect(toastText()).not.toBe(translate('iconTip', { key: 'Alt+Q' }));
  });
});

describe('the shortcuts card (ⓘ)', () => {
  const openKeys = async () => { byTestId('keys-button').click(); return waitFor(() => byTestId('keys-popover')); };

  it('opens below ⓘ with the focus in it, lists every shortcut in groups, and closes with ⓘ again', async () => {
    await boot({ tabs: defaultTabs });
    const popover = await openKeys();
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-modal')).toBe('true');
    expect(byTestId('keys-button').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(byTestId('keys-close'));
    expect(allByTestId('keys-group-title').map((x) => x.textContent)).toEqual([translate('keysGroupOpen'), translate('keysGroupMove'), translate('keysGroupAction'), translate('keysGroupSearch'), translate('keysGroupPalette'), translate('keysGroupViews'), translate('keysGroupEscape')]);
    const keys = allByTestId('keys-key').map((x) => x.textContent);
    for (const keyCombo of ['Alt+Q', 'Alt+W', 'Alt+E', 'Alt+Tab', 'Alt+1', 'Ctrl+←', 'Enter', 'Shift+Enter', 'Space', 'Del', 'Ctrl+Z', 'Alt+S', 'Alt+P', 'Shift+F10', 'Ctrl+Space', 'Ctrl+F', 'Esc']) expect(keys, keyCombo).toContain(keyCombo);
    for (const phrase of [translate('keyboardClick', { key: 'Shift' }), translate('keyboardClick', { key: 'Ctrl' }), translate('keyboardClickBox', { key: 'Shift' }), translate('keyboardRight'), translate('keyboardMiddle'), translate('keyboardLetGo', { key: 'Alt' }), translate('keyboardWheel', { key: 'Alt' })]) expect(keys, phrase).toContain(phrase);
    const actions = allByTestId('keys-action').map((x) => x.textContent);
    expect(actions).toContain(translate('keyPreviousTab'));
    expect(actions).toContain(translate('keyNextTab'));
    expect(actions).toContain(translate('keyEscape'));
    expect(byTestId('keys-settings-note', popover).textContent).toBe(translate('keysInSettings')); // where the keys that open Tabazing change
    byTestId('keys-button').click();
    await tick(20);
    expect(byTestId('keys-popover')).toBe(null);
    expect(byTestId('keys-button').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps Tab inside, and Esc, its × or a press outside close it, with the focus back on ⓘ', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await openKeys();
    expect(document.activeElement).toBe(byTestId('keys-close'));
    // Its × and its list, which the keyboard scrolls (it is longer than the card); Tab goes round them.
    expect(switcher.tabbables(byTestId('keys-popover'))).toEqual([byTestId('keys-close'), byTestId('keys-body')]);
    byTestId('keys-body').focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byTestId('keys-close'));
    key('Escape');
    expect(byTestId('keys-popover')).toBe(null);
    expect(document.activeElement).toBe(byTestId('keys-button'));
    expect(switcher.state.done).toBe(false);
    await openKeys();
    byTestId('keys-close').click();
    expect(byTestId('keys-popover')).toBe(null);
    await openKeys();
    await tick();
    byTestId('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('keys-popover')).toBe(null);
    expect(document.activeElement).toBe(byTestId('keys-button'));
  });

  it('names the keys as on this keyboard (not a Mac here: Alt, Ctrl)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    expect(switcher.IS_MAC).toBe(false);
    const keys = switcher.shortcutGroups().flatMap(([, , rows]) => rows.flatMap(([keyCombo]) => keyCombo));
    expect(keys).toContain('Alt+Q');
    expect(keys).not.toContain('⌥Q');
  });
});

describe('Recently closed: Show more', () => {
  const closed = (count) => Array.from({ length: count }, (value, i) => ({ lastModified: Math.floor(Date.now() / 1000) - 60 - i, tab: { sessionId: 's' + i, url: `https://gone${i}.example/`, title: 'Gone ' + i } }));

  it('shows the first few; "Show more" (a button, reachable by Tab) shows up to the search limit, "Show fewer" goes back', async () => {
    chrome._data.closed = closed(14);
    const switcher = await boot({ tabs: defaultTabs });
    const closedCount = () => switcher.state.entries.filter((entry) => entry.kind === 'closed').length;
    expect(closedCount()).toBe(8);
    const more = byTestId('closed-more');
    expect(more.hidden).toBe(false);
    expect(more.tagName).toBe('BUTTON');
    expect(more.textContent).toBe(translate('closedMore'));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    expect(closedCount()).toBe(14);
    expect(byTestId('closed-more').textContent).toBe(translate('closedFewer'));
    expect(byTestId('closed-more').getAttribute('aria-expanded')).toBe('true');
    byTestId('closed-more').click();
    expect(closedCount()).toBe(8);
  });

  it('is not offered when everything already shows', async () => {
    chrome._data.closed = closed(3);
    await boot({ tabs: defaultTabs });
    expect(byTestId('closed-more').hidden).toBe(true);
  });
});

describe('one dialog at a time, keys that do what they show, colours by name', () => {
  it('Ctrl+H over Backup & Restore: the history comes in its place', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('backup-button').click();
    await waitFor(() => switcher.backupOpen());
    key('h', { ctrlKey: true, code: 'KeyH' });
    await waitFor(() => switcher.historyOpen());
    expect(switcher.backupOpen()).toBe(false);
    expect(byTestId('history-overlay').hasAttribute('inert')).toBe(false);
  });

  it('the archive: Enter on its focused × closes it, and does not open (and un-archive) the selected page', async () => {
    const folder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, title: 'Old one', url: 'https://old.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('archive-button').click();
    await waitFor(() => switcher.archiveOpen());
    byTestId('archive-close').focus();
    const event = key('Enter');
    await tick(50);
    expect(event.defaultPrevented).toBe(false); // (Chrome then clicks the button)
    expect(chrome._findBookmark(folder.id).children).toHaveLength(1);
    expect(chrome._data.tabs.some((tab) => tab.url === 'https://old.example/')).toBe(false);
  });

  it('accent colours: named in words, one Tab stop, → chooses the next', async () => {
    await boot({ tabs: defaultTabs });
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings'));
    byTestId('settings-tab-look').click();
    const swatches = allByTestId('settings-accent');
    expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual(['Sky blue', 'Teal', 'Green', 'Yellow', 'Orange', 'Red', 'Pink', 'Lavender']);
    expect(swatches.filter((swatch) => swatch.tabIndex === 0)).toHaveLength(1);
    swatches[0].focus();
    key('ArrowRight', { target: swatches[0] });
    expect(document.activeElement).toBe(swatches[1]);
    expect(swatches[1].getAttribute('aria-checked')).toBe('true');
    expect(swatches[1].tabIndex).toBe(0);
  });
});
