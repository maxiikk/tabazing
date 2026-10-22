// The media player beside the search box, and its list of everything that plays in the tabs (the chevron).
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, toastText, closedMessage } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';
import { KEY, MESSAGE } from '../../utils/constants.js';

const IMAGE = 'data:image/jpeg;base64,AAAA';
const TABS = [
  { title: 'Alpha', url: 'https://alpha.example/' },
  { title: 'Tube video', url: 'https://www.tube.example/watch' },
  { title: 'Radio', url: 'https://radio.example/' },
];
const sessionArea = chrome.storage.session;
const idOf = (title) => chrome._data.tabs.find((x) => x.title === title).id;
const baseTime = Date.now(); // reports are recent (media paused for an hour leaves the list); small offsets order them
const stateOf = (overrides = {}) => ({ media: true, playing: false, kind: 'video', title: 'Clip', artist: '', canPrevious: false, canNext: false, muted: false, t: Date.now(), ...overrides });
// What the pages reported, by tab title: { 'Tube video': { 0: st(...) } }.
const stored = (byTitle) => Object.fromEntries(Object.entries(byTitle).map(([title, frames]) => [idOf(title), frames]));
const seedMedia = (byTitle) => sessionArea.set({ [KEY.MEDIA]: stored(byTitle) });

async function bootWith(byTitle, options = {}) {
  return boot({ tabs: TABS, ...options, beforeImport: async () => { await seedMedia(byTitle); if (options.beforeImport) await options.beforeImport(); } });
}
const PLAYING = { 'Tube video': { 0: stateOf({ playing: true, title: 'Cats', artist: 'CatChannel', canNext: true }) } };
const scriptCalls = () => chrome.scripting.executeScript.mock.calls.map(([options]) => options);
const focused = () => document.activeElement;
const rows = () => allByTestId('media-row');
const rowTitles = () => rows().map((row) => byTestId('media-row-title', row).textContent);
async function openList() {
  byTestId('player-more').click();
  await waitFor(() => byTestId('media-list'));
  await tick(); // its press-outside listener
  return byTestId('media-list');
}

describe('the player', () => {
  it('is hidden when nothing plays', async () => {
    await boot({ tabs: TABS });
    expect(byTestId('player').hidden).toBe(true);
  });

  it('shows what plays: the picture, title, artist, and the buttons', async () => {
    await bootWith(PLAYING, { beforeImport: () => chrome.storage.local.set({ 'pv:https://www.tube.example/watch': { img: IMAGE, t: Date.now() } }) });
    const player = byTestId('player');
    expect(player.hidden).toBe(false);
    expect(player.getAttribute('role')).toBe('group');
    expect(player.getAttribute('aria-label')).toBe(translate('mediaPlayer'));
    expect(byTestId('player-preview', player).getAttribute('src')).toBe(IMAGE);
    expect(byTestId('player-title', player).textContent).toBe('Cats');
    expect(byTestId('player-subtitle', player).textContent).toBe('CatChannel');
    expect(byTestId('player-text', player).title).toBe('Cats');
    // It sits right after the search box, in the header.
    expect(byTestId('search-box').nextElementSibling).toBe(player);
    expect(player.closest('[data-testid="header"]')).toBe(byTestId('header'));
  });

  it('no picture yet: the site\'s icon; no artist: the site', async () => {
    await bootWith({ 'Tube video': { 0: stateOf({ playing: true, title: 'Cats' }) } });
    expect(byTestId('player-favicon')).not.toBe(null);
    expect(byTestId('player-preview')).toBe(null);
    expect(byTestId('player-subtitle').textContent).toBe('tube.example');
  });

  it('labels its buttons; play / pause says what a press does; previous / next only when the page has them', async () => {
    await bootWith(PLAYING);
    const [previousButton, toggle, next, more] = ['player-previous', 'player-toggle', 'player-next', 'player-more'].map((id) => byTestId(id));
    expect(previousButton.getAttribute('aria-label')).toBe(translate('mediaPrevious'));
    expect(previousButton.disabled).toBe(true);
    expect(next.getAttribute('aria-label')).toBe(translate('mediaNext'));
    expect(next.disabled).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe(translate('mediaPause'));
    expect(toggle.title).toBe(translate('mediaPause'));
    expect(more.getAttribute('aria-label')).toBe(translate('mediaList'));
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    for (const button of [previousButton, toggle, next, more]) { expect(button.type).toBe('button'); expect(button.querySelector('svg')).not.toBe(null); }
  });

  it('is reached with Tab (its enabled buttons), after the search box', async () => {
    const switcher = await bootWith(PLAYING);
    const list = switcher.tabbables(byTestId('app'));
    const at = (id) => list.indexOf(byTestId(id));
    expect(at('search')).toBeLessThan(at('player-toggle'));
    expect(at('player-toggle')).toBeLessThan(at('player-next'));
    expect(at('player-next')).toBeLessThan(at('player-more'));
    expect(at('player-previous')).toBe(-1); // disabled
  });

  it('play / pause runs in that tab\'s page (its main world, that frame) and shows the change at once', async () => {
    await bootWith({ 'Tube video': { 2: stateOf({ playing: true, title: 'Cats' }) } });
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    byTestId('player-toggle').click();
    expect(byTestId('player-toggle').getAttribute('aria-label')).toBe(translate('mediaPlay')); // before the page answers
    await tick();
    expect(scriptCalls()).toEqual([expect.objectContaining({ target: { tabId: idOf('Tube video'), frameIds: [2] }, world: 'MAIN', args: ['pause'] })]);
    byTestId('player-toggle').click();
    await tick();
    expect(scriptCalls()[1].args).toEqual(['play']);
    expect(byTestId('player-toggle').getAttribute('aria-label')).toBe(translate('mediaPause'));
  });

  it('previous and next', async () => {
    await bootWith({ 'Tube video': { 0: stateOf({ playing: true, canPrevious: true, canNext: true }) } });
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    byTestId('player-previous').click();
    byTestId('player-next').click();
    await tick();
    expect(scriptCalls().map((options) => options.args[0])).toEqual(['previoustrack', 'nexttrack']);
  });

  it('when the page doesn\'t action, it goes back and says so', async () => {
    const switcher = await bootWith(PLAYING);
    chrome.scripting.executeScript.mockResolvedValueOnce([{ result: false }]);
    byTestId('player-toggle').click();
    await waitFor(() => toastText() === translate('mediaFailed'));
    expect(byTestId('player-toggle').getAttribute('aria-label')).toBe(translate('mediaPause'));
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('No tab with id'));
    byTestId('player-next').click();
    await waitFor(() => toastText() === translate('mediaFailed'));
    expect(switcher.state.done).toBe(false);
  });

  it('clicks on it are not "empty space" (which closes the switcher)', async () => {
    const switcher = await bootWith(PLAYING);
    byTestId('player-title').click();
    byTestId('player-picture').click();
    expect(switcher.state.done).toBe(false);
  });

  it('ignores clicks while the overlay may be covered or hidden (the clickjacking guard)', async () => {
    await bootWith(PLAYING, { overlay: true });
    byTestId('player-toggle').click();
    byTestId('player-more').click();
    await tick();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(byTestId('media-list')).toBe(null);
  });

  it('a tab that makes sound without media (a game, a call) shows no player, as in Chrome', async () => {
    await boot({ tabs: [...TABS, { title: 'A game', url: 'https://game.example/', audible: true }] });
    expect(byTestId('player').hidden).toBe(true);
  });

  it('asks the background, as it opens, to check the list with the pages', async () => {
    await bootWith(PLAYING);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.MEDIA_CHECK });
  });

  it('shows what plays first, then the most recent', async () => {
    await bootWith({ Alpha: { 0: stateOf({ title: 'Paused one', t: Date.now() + 5 }) }, Radio: { 0: stateOf({ kind: 'audio', title: 'Live', playing: true, t: baseTime + 1 }) } });
    expect(byTestId('player-title').textContent).toBe('Live');
  });
});

describe('live updates', () => {
  it('follows what the pages report while open (storage.session changes)', async () => {
    await boot({ tabs: TABS });
    expect(byTestId('player').hidden).toBe(true);
    await seedMedia(PLAYING);
    await waitFor(() => !byTestId('player').hidden);
    expect(byTestId('player-title').textContent).toBe('Cats');
    await seedMedia({ 'Tube video': { 0: stateOf({ playing: false, title: 'Dogs' }) } });
    await waitFor(() => byTestId('player-title').textContent === 'Dogs');
    expect(byTestId('player-toggle').getAttribute('aria-label')).toBe(translate('mediaPlay'));
    await sessionArea.set({ [KEY.MEDIA]: {} });
    await waitFor(() => byTestId('player').hidden);
  });

  it('a button pressed in the player keeps showing that media, even once another plays first', async () => {
    await bootWith({ 'Tube video': { 0: stateOf({ playing: true, title: 'Cats' }) }, Radio: { 0: stateOf({ playing: false, title: 'Live', t: baseTime + 1 }) } });
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    byTestId('player-toggle').click(); // pause the cats
    await tick();
    await seedMedia({ 'Tube video': { 0: stateOf({ playing: false, title: 'Cats' }) }, Radio: { 0: stateOf({ playing: true, title: 'Live' }) } });
    await tick(20);
    expect(byTestId('player-title').textContent).toBe('Cats');
  });

  it('the focus stays on the player as it changes', async () => {
    await bootWith(PLAYING);
    byTestId('player-next').focus();
    await seedMedia({ 'Tube video': { 0: stateOf({ playing: true, title: 'Next video', canNext: true }) } });
    await waitFor(() => byTestId('player-title').textContent === 'Next video');
    expect(focused()).toBe(byTestId('player-next'));
  });

  it('when the media goes, a focused player hands the focus to the search box', async () => {
    await bootWith(PLAYING);
    byTestId('player-toggle').focus();
    await sessionArea.set({ [KEY.MEDIA]: {} });
    await waitFor(() => byTestId('player').hidden);
    expect(focused()).toBe(byTestId('search'));
  });
});

describe('the list (chevron)', () => {
  const ALL = {
    'Tube video': { 0: stateOf({ playing: true, title: 'Cats', canNext: true, t: baseTime + 3 }) },
    Radio: { 0: stateOf({ kind: 'audio', title: 'Live', t: baseTime + 2 }) },
    Alpha: { 4: stateOf({ title: 'Embedded', canPrevious: true, t: baseTime + 1 }) },
  };

  it('opens as a dialog that takes the focus, and keeps Tab inside', async () => {
    const switcher = await bootWith(ALL);
    const mediaList = await openList();
    expect(mediaList.getAttribute('role')).toBe('dialog');
    expect(mediaList.getAttribute('aria-modal')).toBe('true');
    expect(mediaList.getAttribute('aria-label')).toBe(translate('mediaList'));
    expect(byTestId('media-list-title', mediaList).textContent).toBe(translate('mediaList'));
    expect(byTestId('player-more').getAttribute('aria-expanded')).toBe('true');
    expect(byTestId('player-more').getAttribute('aria-controls')).toBe(mediaList.id);
    expect(focused()).toBe(byTestId('media-row-toggle', rows()[0])); // the one the player shows: its play / pause
    expect(switcher.tabbables(mediaList).some((element) => element.dataset.testid === 'media-row-pick')).toBe(false); // a row is not a control: only its buttons are
    const list = switcher.tabbables(mediaList);
    list[list.length - 1].focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(list[list.length - 1]);
  });

  it('Esc closes it and gives the focus back to the chevron (the switcher stays)', async () => {
    const switcher = await bootWith(ALL);
    await openList();
    key('Escape');
    expect(byTestId('media-list')).toBe(null);
    expect(focused()).toBe(byTestId('player-more'));
    expect(byTestId('player-more').getAttribute('aria-expanded')).toBe('false');
    expect(switcher.state.done).toBe(false);
  });

  it('so do the chevron again and a press outside', async () => {
    await bootWith(ALL);
    await openList();
    byTestId('player-more').click();
    expect(byTestId('media-list')).toBe(null);
    expect(focused()).toBe(byTestId('player-more'));
    await openList();
    byTestId('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('media-list')).toBe(null);
    expect(focused()).toBe(byTestId('player-more'));
  });

  it('typing there stays there (it is modal)', async () => {
    await bootWith(ALL);
    const mediaList = await openList();
    key('x');
    expect(mediaList.contains(focused())).toBe(true);
  });

  it('a row per tab: picture, title, site, whether it plays, and its own buttons', async () => {
    await bootWith(ALL);
    await openList();
    expect(rowTitles()).toEqual(['Cats', 'Live', 'Embedded']);
    const [cats, live, embedded] = rows();
    expect(byTestId('media-row-site', cats).textContent).toBe('tube.example');
    expect(byTestId('media-row-picture', cats).firstElementChild).not.toBe(null);
    expect(byTestId('media-row-state', cats).textContent).toBe(translate('mediaPlaying'));
    expect(byTestId('media-row-state', live).textContent).toBe(translate('mediaPaused'));
    expect(byTestId('media-row-eq', cats).getAttribute('aria-hidden')).toBe('true');
    expect(allByTestId('media-row-eq-bar', cats)).toHaveLength(3);
    expect(cats.getAttribute('aria-current')).toBe('true'); // the one the player shows (no look of its own)
    expect(live.hasAttribute('aria-current')).toBe(false);
    expect(byTestId('media-row-pick', cats).tagName).toBe('SPAN');
    expect(byTestId('media-row-toggle', cats).getAttribute('aria-label')).toBe(translate('mediaPause'));
    expect(byTestId('media-row-toggle', live).getAttribute('aria-label')).toBe(translate('mediaPlay'));
    expect(byTestId('media-row-previous', cats).disabled).toBe(true);
    expect(byTestId('media-row-next', cats).disabled).toBe(false);
    expect(byTestId('media-row-previous', embedded).disabled).toBe(false);
    expect(byTestId('media-row-next', embedded).disabled).toBe(true);
    expect(byTestId('media-row-goto', cats).getAttribute('aria-label')).toBe(translate('mediaGoTo'));
    for (const id of ['media-row-previous', 'media-row-next', 'media-row-goto']) expect(byTestId(id, cats).getAttribute('aria-label')).toBeTruthy();
  });

  it('a row\'s buttons action on its own tab and frame', async () => {
    await bootWith(ALL);
    await openList();
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    byTestId('media-row-toggle', rows()[1]).click();
    byTestId('media-row-previous', rows()[2]).click();
    await tick();
    expect(scriptCalls().map((options) => [options.target, options.args[0], options.world])).toEqual([
      [{ tabId: idOf('Radio'), frameIds: [0] }, 'play', 'MAIN'],
      [{ tabId: idOf('Alpha'), frameIds: [4] }, 'previoustrack', 'MAIN'],
    ]);
    expect(byTestId('media-row-toggle', rows()[1]).getAttribute('aria-label')).toBe(translate('mediaPause'));
    expect(byTestId('player-title').textContent).toBe('Cats'); // a row's buttons don't change what the player shows
    expect(byTestId('media-list')).not.toBe(null);
  });

  it('pressing a row (not its buttons) shows it in the player', async () => {
    await bootWith(ALL);
    await openList();
    rows()[1].click();
    expect(byTestId('player-title').textContent).toBe('Live');
    expect(rows()[1].getAttribute('aria-current')).toBe('true');
    expect(rows()[0].hasAttribute('aria-current')).toBe(false);
    byTestId('media-row-pick', rows()[2]).click(); // its picture and title
    expect(byTestId('player-title').textContent).toBe('Embedded');
    expect(byTestId('media-list')).not.toBe(null);
  });

  it('double-clicking a row plays or pauses it (and shows it in the player)', async () => {
    await bootWith(ALL);
    await openList();
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    const live = () => rows().find((row) => byTestId('media-row-title', row).textContent === 'Live');
    live().click();
    expect(scriptCalls()).toEqual([]); // one press only picks it
    live().click(); // the second press of a double click (the list was redrawn in between)
    await tick();
    expect(scriptCalls()).toEqual([expect.objectContaining({ args: ['play'] })]); // it was paused
    expect(byTestId('player-title').textContent).toBe('Live');
    live().click(); // a third press starts a new count: picks only
    await tick();
    expect(scriptCalls()).toHaveLength(1);
  });

  it('two presses far apart, or on two different rows, are not a double click', async () => {
    await bootWith(ALL);
    await openList();
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    rows()[0].click();
    rows()[1].click(); // another row
    await tick();
    expect(scriptCalls()).toEqual([]);
    const at = performance.now();
    const now = vi.spyOn(performance, 'now').mockReturnValue(at + 10000);
    rows()[1].click(); // the same row, but long after
    await tick();
    now.mockRestore();
    expect(scriptCalls()).toEqual([]);
  });

  it('"Go to tab" switches to it and closes the switcher, like choosing its card', async () => {
    await bootWith(ALL);
    await openList();
    byTestId('media-row-goto', rows()[1]).click();
    await waitFor(() => closedMessage());
    expect(chrome.tabs.update).toHaveBeenCalledWith(idOf('Radio'), { active: true });
    expect(closedMessage().reason).toBe('switch');
  });

  it('follows the reports while open, without moving the rows under the pointer', async () => {
    await bootWith(ALL);
    await openList();
    byTestId('media-row-toggle', rows()[1]).focus();
    // The radio starts and the video stops: sorted afresh, the radio would come first.
    await seedMedia({ ...ALL, 'Tube video': { 0: stateOf({ title: 'Cats', t: baseTime + 3 }) }, Radio: { 0: stateOf({ kind: 'audio', title: 'Live', playing: true, t: baseTime + 9 }) } });
    await waitFor(() => byTestId('media-row-state', rows()[1]).textContent === translate('mediaPlaying'));
    expect(rowTitles()).toEqual(['Cats', 'Live', 'Embedded']);
    expect(focused()).toBe(byTestId('media-row-toggle', rows()[1])); // the same button of the same row
    await seedMedia({ ...ALL, Radio: undefined, Alpha: undefined, 'Tube video': ALL['Tube video'] });
    await waitFor(() => rows().length === 1);
    expect(focused()).toBe(byTestId('media-row-toggle', rows()[0])); // its row went: the focus stays in the list
    await sessionArea.set({ [KEY.MEDIA]: {} });
    await waitFor(() => !byTestId('media-list'));
    expect(focused()).toBe(byTestId('search')); // nothing left: no list, no player
  });

  it('lists media in other windows too', async () => {
    await bootWith(ALL, {
      beforeImport: async () => {
        const other = chrome._addTab({ windowId: 2, title: 'Elsewhere', url: 'https://else.example/', active: true });
        const current = (await sessionArea.get(KEY.MEDIA))[KEY.MEDIA];
        await sessionArea.set({ [KEY.MEDIA]: { ...current, [other.id]: { 0: stateOf({ title: 'Far away', t: baseTime + 1 }) } } });
      },
    });
    await openList();
    expect(rowTitles()).toContain('Far away');
  });
});
