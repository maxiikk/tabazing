// The media player beside the search box, and its list of everything that plays in the tabs (the chevron).
import { describe, it, expect } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, tid, tids, toastText, closedMsg } from './quiet-boot.js';
import { t } from '../../lib/translations.js';
import { KEY } from '../../lib/constants.js';

const IMG = 'data:image/jpeg;base64,AAAA';
const TABS = [
  { title: 'Alpha', url: 'https://alpha.example/' },
  { title: 'Tube video', url: 'https://www.tube.example/watch' },
  { title: 'Radio', url: 'https://radio.example/' },
];
const S = chrome.storage.session;
const idOf = (title) => chrome._data.tabs.find((x) => x.title === title).id;
const T0 = Date.now(); // reports are recent (media paused for an hour leaves the list); small offsets order them
const st = (p = {}) => ({ media: true, playing: false, kind: 'video', title: 'Clip', artist: '', canPrev: false, canNext: false, muted: false, t: Date.now(), ...p });
// What the pages reported, by tab title: { 'Tube video': { 0: st(...) } }.
const stored = (byTitle) => Object.fromEntries(Object.entries(byTitle).map(([title, frames]) => [idOf(title), frames]));
const seedMedia = (byTitle) => S.set({ [KEY.MEDIA]: stored(byTitle) });

async function bootWith(byTitle, opts = {}) {
  return boot({ tabs: TABS, ...opts, beforeImport: async () => { await seedMedia(byTitle); if (opts.beforeImport) await opts.beforeImport(); } });
}
const PLAYING = { 'Tube video': { 0: st({ playing: true, title: 'Cats', artist: 'CatChannel', canNext: true }) } };
const scriptCalls = () => chrome.scripting.executeScript.mock.calls.map(([o]) => o);
const focused = () => document.activeElement;
const rows = () => tids('media-row');
const rowTitles = () => rows().map((r) => tid('media-row-title', r).textContent);
async function openList() {
  tid('player-more').click();
  await waitFor(() => tid('media-list'));
  await tick(); // its press-outside listener
  return tid('media-list');
}

describe('the player', () => {
  it('is hidden when nothing plays', async () => {
    await boot({ tabs: TABS });
    expect(tid('player').hidden).toBe(true);
  });

  it('shows what plays: the picture, title, artist, and the buttons', async () => {
    await bootWith(PLAYING, { beforeImport: () => chrome.storage.local.set({ 'pv:https://www.tube.example/watch': { img: IMG, t: Date.now() } }) });
    const p = tid('player');
    expect(p.hidden).toBe(false);
    expect(p.getAttribute('role')).toBe('group');
    expect(p.getAttribute('aria-label')).toBe(t('mediaPlayer'));
    expect(tid('player-preview', p).getAttribute('src')).toBe(IMG);
    expect(tid('player-title', p).textContent).toBe('Cats');
    expect(tid('player-sub', p).textContent).toBe('CatChannel');
    expect(tid('player-text', p).title).toBe('Cats');
    // It sits right after the search box, in the header.
    expect(tid('search-box').nextElementSibling).toBe(p);
    expect(p.closest('[data-testid="header"]')).toBe(tid('header'));
  });

  it('no picture yet: the site\'s icon; no artist: the site', async () => {
    await bootWith({ 'Tube video': { 0: st({ playing: true, title: 'Cats' }) } });
    expect(tid('player-favicon')).not.toBe(null);
    expect(tid('player-preview')).toBe(null);
    expect(tid('player-sub').textContent).toBe('tube.example');
  });

  it('labels its buttons; play / pause says what a press does; previous / next only when the page has them', async () => {
    await bootWith(PLAYING);
    const [prev, toggle, next, more] = ['player-prev', 'player-toggle', 'player-next', 'player-more'].map((id) => tid(id));
    expect(prev.getAttribute('aria-label')).toBe(t('mediaPrev'));
    expect(prev.disabled).toBe(true);
    expect(next.getAttribute('aria-label')).toBe(t('mediaNext'));
    expect(next.disabled).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe(t('mediaPause'));
    expect(toggle.title).toBe(t('mediaPause'));
    expect(more.getAttribute('aria-label')).toBe(t('mediaList'));
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    for (const b of [prev, toggle, next, more]) { expect(b.type).toBe('button'); expect(b.querySelector('svg')).not.toBe(null); }
  });

  it('is reached with Tab (its enabled buttons), after the search box', async () => {
    const sw = await bootWith(PLAYING);
    const list = sw.tabbables(tid('app'));
    const at = (id) => list.indexOf(tid(id));
    expect(at('search')).toBeLessThan(at('player-toggle'));
    expect(at('player-toggle')).toBeLessThan(at('player-next'));
    expect(at('player-next')).toBeLessThan(at('player-more'));
    expect(at('player-prev')).toBe(-1); // disabled
  });

  it('play / pause runs in that tab\'s page (its main world, that frame) and shows the change at once', async () => {
    await bootWith({ 'Tube video': { 2: st({ playing: true, title: 'Cats' }) } });
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    tid('player-toggle').click();
    expect(tid('player-toggle').getAttribute('aria-label')).toBe(t('mediaPlay')); // before the page answers
    await tick();
    expect(scriptCalls()).toEqual([expect.objectContaining({ target: { tabId: idOf('Tube video'), frameIds: [2] }, world: 'MAIN', args: ['pause'] })]);
    tid('player-toggle').click();
    await tick();
    expect(scriptCalls()[1].args).toEqual(['play']);
    expect(tid('player-toggle').getAttribute('aria-label')).toBe(t('mediaPause'));
  });

  it('previous and next', async () => {
    await bootWith({ 'Tube video': { 0: st({ playing: true, canPrev: true, canNext: true }) } });
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    tid('player-prev').click();
    tid('player-next').click();
    await tick();
    expect(scriptCalls().map((o) => o.args[0])).toEqual(['previoustrack', 'nexttrack']);
  });

  it('when the page doesn\'t act, it goes back and says so', async () => {
    const sw = await bootWith(PLAYING);
    chrome.scripting.executeScript.mockResolvedValueOnce([{ result: false }]);
    tid('player-toggle').click();
    await waitFor(() => toastText() === t('mediaFailed'));
    expect(tid('player-toggle').getAttribute('aria-label')).toBe(t('mediaPause'));
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('No tab with id'));
    tid('player-next').click();
    await waitFor(() => toastText() === t('mediaFailed'));
    expect(sw.state.done).toBe(false);
  });

  it('clicks on it are not "empty space" (which closes the switcher)', async () => {
    const sw = await bootWith(PLAYING);
    tid('player-title').click();
    tid('player-pic').click();
    expect(sw.state.done).toBe(false);
  });

  it('ignores clicks while the overlay may be covered or hidden (the clickjacking guard)', async () => {
    await bootWith(PLAYING, { overlay: true });
    tid('player-toggle').click();
    tid('player-more').click();
    await tick();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(tid('media-list')).toBe(null);
  });

  it('lists a tab that makes sound without a report (open from before Tabazing), with its title', async () => {
    await boot({ tabs: [...TABS, { title: 'Old music', url: 'https://music.example/', audible: true }] });
    expect(tid('player').hidden).toBe(false);
    expect(tid('player-title').textContent).toBe('Old music');
    expect(tid('player-prev').disabled).toBe(true);
    expect(tid('player-next').disabled).toBe(true);
  });

  it('shows what plays first, then the most recent', async () => {
    await bootWith({ Alpha: { 0: st({ title: 'Paused one', t: Date.now() + 5 }) }, Radio: { 0: st({ kind: 'audio', title: 'Live', playing: true, t: T0 + 1 }) } });
    expect(tid('player-title').textContent).toBe('Live');
  });
});

describe('live updates', () => {
  it('follows what the pages report while open (storage.session changes)', async () => {
    await boot({ tabs: TABS });
    expect(tid('player').hidden).toBe(true);
    await seedMedia(PLAYING);
    await waitFor(() => !tid('player').hidden);
    expect(tid('player-title').textContent).toBe('Cats');
    await seedMedia({ 'Tube video': { 0: st({ playing: false, title: 'Dogs' }) } });
    await waitFor(() => tid('player-title').textContent === 'Dogs');
    expect(tid('player-toggle').getAttribute('aria-label')).toBe(t('mediaPlay'));
    await S.set({ [KEY.MEDIA]: {} });
    await waitFor(() => tid('player').hidden);
  });

  it('a button pressed in the player keeps showing that media, even once another plays first', async () => {
    await bootWith({ 'Tube video': { 0: st({ playing: true, title: 'Cats' }) }, Radio: { 0: st({ playing: false, title: 'Live', t: T0 + 1 }) } });
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    tid('player-toggle').click(); // pause the cats
    await tick();
    await seedMedia({ 'Tube video': { 0: st({ playing: false, title: 'Cats' }) }, Radio: { 0: st({ playing: true, title: 'Live' }) } });
    await tick(20);
    expect(tid('player-title').textContent).toBe('Cats');
  });

  it('the focus stays on the player as it changes', async () => {
    await bootWith(PLAYING);
    tid('player-next').focus();
    await seedMedia({ 'Tube video': { 0: st({ playing: true, title: 'Next video', canNext: true }) } });
    await waitFor(() => tid('player-title').textContent === 'Next video');
    expect(focused()).toBe(tid('player-next'));
  });

  it('when the media goes, a focused player hands the focus to the search box', async () => {
    await bootWith(PLAYING);
    tid('player-toggle').focus();
    await S.set({ [KEY.MEDIA]: {} });
    await waitFor(() => tid('player').hidden);
    expect(focused()).toBe(tid('search'));
  });
});

describe('the list (chevron)', () => {
  const ALL = {
    'Tube video': { 0: st({ playing: true, title: 'Cats', canNext: true, t: T0 + 3 }) },
    Radio: { 0: st({ kind: 'audio', title: 'Live', t: T0 + 2 }) },
    Alpha: { 4: st({ title: 'Embedded', canPrev: true, t: T0 + 1 }) },
  };

  it('opens as a dialog that takes the focus, and keeps Tab inside', async () => {
    const sw = await bootWith(ALL);
    const pop = await openList();
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.getAttribute('aria-modal')).toBe('true');
    expect(pop.getAttribute('aria-label')).toBe(t('mediaList'));
    expect(tid('media-list-title', pop).textContent).toBe(t('mediaList'));
    expect(tid('player-more').getAttribute('aria-expanded')).toBe('true');
    expect(tid('player-more').getAttribute('aria-controls')).toBe(pop.id);
    expect(focused()).toBe(tid('media-row-pick', rows()[0])); // the one the player shows
    const list = sw.tabbables(pop);
    list[list.length - 1].focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(list[list.length - 1]);
  });

  it('Esc closes it and gives the focus back to the chevron (the switcher stays)', async () => {
    const sw = await bootWith(ALL);
    await openList();
    key('Escape');
    expect(tid('media-list')).toBe(null);
    expect(focused()).toBe(tid('player-more'));
    expect(tid('player-more').getAttribute('aria-expanded')).toBe('false');
    expect(sw.state.done).toBe(false);
  });

  it('so do the chevron again and a press outside', async () => {
    await bootWith(ALL);
    await openList();
    tid('player-more').click();
    expect(tid('media-list')).toBe(null);
    expect(focused()).toBe(tid('player-more'));
    await openList();
    tid('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('media-list')).toBe(null);
    expect(focused()).toBe(tid('player-more'));
  });

  it('typing there stays there (it is modal)', async () => {
    await bootWith(ALL);
    const pop = await openList();
    key('x');
    expect(pop.contains(focused())).toBe(true);
  });

  it('a row per tab: picture, title, site, whether it plays, and its own buttons', async () => {
    await bootWith(ALL);
    await openList();
    expect(rowTitles()).toEqual(['Cats', 'Live', 'Embedded']);
    const [cats, live, embedded] = rows();
    expect(tid('media-row-site', cats).textContent).toBe('tube.example');
    expect(tid('media-row-pic', cats).firstElementChild).not.toBe(null);
    expect(tid('media-row-state', cats).textContent).toBe(t('mediaPlaying'));
    expect(tid('media-row-state', live).textContent).toBe(t('mediaPaused'));
    expect(tid('media-row-eq', cats).getAttribute('aria-hidden')).toBe('true');
    expect(tids('media-row-eq-bar', cats)).toHaveLength(3);
    expect(tid('media-row-pick', cats).getAttribute('aria-pressed')).toBe('true');
    expect(tid('media-row-pick', live).getAttribute('aria-pressed')).toBe('false');
    expect(tid('media-row-toggle', cats).getAttribute('aria-label')).toBe(t('mediaPause'));
    expect(tid('media-row-toggle', live).getAttribute('aria-label')).toBe(t('mediaPlay'));
    expect(tid('media-row-prev', cats).disabled).toBe(true);
    expect(tid('media-row-next', cats).disabled).toBe(false);
    expect(tid('media-row-prev', embedded).disabled).toBe(false);
    expect(tid('media-row-next', embedded).disabled).toBe(true);
    expect(tid('media-row-goto', cats).getAttribute('aria-label')).toBe(t('mediaGoTo'));
    for (const id of ['media-row-prev', 'media-row-next', 'media-row-goto']) expect(tid(id, cats).getAttribute('aria-label')).toBeTruthy();
  });

  it('a row\'s buttons act on its own tab and frame', async () => {
    await bootWith(ALL);
    await openList();
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    tid('media-row-toggle', rows()[1]).click();
    tid('media-row-prev', rows()[2]).click();
    await tick();
    expect(scriptCalls().map((o) => [o.target, o.args[0], o.world])).toEqual([
      [{ tabId: idOf('Radio'), frameIds: [0] }, 'play', 'MAIN'],
      [{ tabId: idOf('Alpha'), frameIds: [4] }, 'previoustrack', 'MAIN'],
    ]);
    expect(tid('media-row-toggle', rows()[1]).getAttribute('aria-label')).toBe(t('mediaPause'));
    expect(tid('player-title').textContent).toBe('Cats'); // a row's buttons don't change what the player shows
    expect(tid('media-list')).not.toBe(null);
  });

  it('pressing a row (not its buttons) shows it in the player', async () => {
    await bootWith(ALL);
    await openList();
    rows()[1].click();
    expect(tid('player-title').textContent).toBe('Live');
    expect(tid('media-row-pick', rows()[1]).getAttribute('aria-pressed')).toBe('true');
    expect(tid('media-row-pick', rows()[0]).getAttribute('aria-pressed')).toBe('false');
    tid('media-row-pick', rows()[2]).focus();
    tid('media-row-pick', rows()[2]).click(); // its main button (what Enter presses)
    expect(tid('player-title').textContent).toBe('Embedded');
    expect(focused()).toBe(tid('media-row-pick', rows()[2]));
    expect(tid('media-list')).not.toBe(null);
  });

  it('"Go to tab" switches to it and closes the switcher, like choosing its card', async () => {
    await bootWith(ALL);
    await openList();
    tid('media-row-goto', rows()[1]).click();
    await waitFor(() => closedMsg());
    expect(chrome.tabs.update).toHaveBeenCalledWith(idOf('Radio'), { active: true });
    expect(closedMsg().reason).toBe('switch');
  });

  it('follows the reports while open, without moving the rows under the pointer', async () => {
    await bootWith(ALL);
    await openList();
    tid('media-row-toggle', rows()[1]).focus();
    // The radio starts and the video stops: sorted afresh, the radio would come first.
    await seedMedia({ ...ALL, 'Tube video': { 0: st({ title: 'Cats', t: T0 + 3 }) }, Radio: { 0: st({ kind: 'audio', title: 'Live', playing: true, t: T0 + 9 }) } });
    await waitFor(() => tid('media-row-state', rows()[1]).textContent === t('mediaPlaying'));
    expect(rowTitles()).toEqual(['Cats', 'Live', 'Embedded']);
    expect(focused()).toBe(tid('media-row-toggle', rows()[1])); // the same button of the same row
    await seedMedia({ ...ALL, Radio: undefined, Alpha: undefined, 'Tube video': ALL['Tube video'] });
    await waitFor(() => rows().length === 1);
    expect(focused()).toBe(tid('media-row-pick', rows()[0])); // its row went: the focus stays in the list
    await S.set({ [KEY.MEDIA]: {} });
    await waitFor(() => !tid('media-list'));
    expect(focused()).toBe(tid('search')); // nothing left: no list, no player
  });

  it('lists media in other windows too', async () => {
    await bootWith(ALL, {
      beforeImport: async () => {
        const other = chrome._addTab({ windowId: 2, title: 'Elsewhere', url: 'https://else.example/', active: true });
        const cur = (await S.get(KEY.MEDIA))[KEY.MEDIA];
        await S.set({ [KEY.MEDIA]: { ...cur, [other.id]: { 0: st({ title: 'Far away', t: T0 + 1 }) } } });
      },
    });
    await openList();
    expect(rowTitles()).toContain('Far away');
  });
});
