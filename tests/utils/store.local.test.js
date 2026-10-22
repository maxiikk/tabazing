// storage.local settings and user data: review/onboarding/nudge counters, snoozed tabs, notes, stars, view, prefs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS, SNOOZE_ALARM } from '../../utils/constants.js';
import { DEFAULT_ACCENT } from '../../utils/accent.js';

const localArea = chrome.storage.local;
const NOW = 1_800_000_000_000;

let store;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  store = await import('../../utils/store.js');
});
afterEach(() => vi.useRealTimers());

describe('review counters', () => {
  const empty = { since: NOW, opens: 0, soft: 0, lastSoft: 0, asks: 0, lastAsk: 0, done: false, day: '' };

  it('getReview starts empty and validates every field', async () => {
    expect(await store.getReview()).toEqual(empty);
    localArea._data.set(KEY.REVIEW, 'x');
    expect(await store.getReview()).toEqual(empty);
    localArea._data.set(KEY.REVIEW, { since: 5, opens: 3.7, soft: -1, lastSoft: 'x', asks: Infinity, lastAsk: 9, done: 'yes', day: '2026-1-1' });
    expect(await store.getReview()).toEqual({ since: 5, opens: 3, soft: 0, lastSoft: 0, asks: 0, lastAsk: 9, done: false, day: '2026-1-1' });
    localArea._data.set(KEY.REVIEW, { since: -5, done: true, day: 'x'.repeat(13) });
    expect(await store.getReview()).toEqual({ ...empty, done: true });
  });

  it('updateReview applies the change, cleans and stores the result', async () => {
    const next = await store.updateReview((review) => ({ ...review, opens: review.opens + 1, done: 1 }));
    expect(next).toEqual({ ...empty, opens: 1 });
    expect(localArea._data.get(KEY.REVIEW)).toEqual(next);
  });

  it('concurrent updates are not lost', async () => {
    await Promise.all(Array.from({ length: 10 }, () => store.updateReview((review) => ({ ...review, opens: review.opens + 1 }))));
    expect((await store.getReview()).opens).toBe(10);
  });
});

describe('onboarding flags', () => {
  it('getOnboard validates', async () => {
    expect(await store.getOnboard()).toEqual({ at: 0, flyout: false, tour: false });
    localArea._data.set(KEY.ONBOARD, { at: 'x', flyout: 1, tour: 0, junk: true });
    expect(await store.getOnboard()).toEqual({ at: 0, flyout: true, tour: false });
  });

  it('updateOnboard merges a patch', async () => {
    await store.updateOnboard({ at: 5 });
    expect(await store.updateOnboard({ tour: true })).toEqual({ at: 5, flyout: false, tour: true });
    expect(await store.getOnboard()).toEqual({ at: 5, flyout: false, tour: true });
  });
});

describe('nudge counters', () => {
  it('getNudge validates', async () => {
    expect(await store.getNudge()).toEqual({ day: '', runs: 0, shown: 0, last: 0, never: false });
    localArea._data.set(KEY.NUDGE, { day: 3, runs: 2.5, shown: -1, last: NOW, never: 'true' });
    expect(await store.getNudge()).toEqual({ day: '', runs: 2, shown: 0, last: NOW, never: false });
  });

  it('updateNudge stores what the change returns', async () => {
    expect(await store.updateNudge((nudge) => ({ ...nudge, runs: nudge.runs + 1, day: 'd' }))).toEqual({ day: 'd', runs: 1, shown: 0, last: 0, never: false });
    await Promise.all([1, 2, 3].map(() => store.updateNudge((nudge) => ({ ...nudge, runs: nudge.runs + 1 }))));
    expect((await store.getNudge()).runs).toBe(4);
  });
});

describe('snoozed tabs', () => {
  const item = (id, at, overrides = {}) => ({ id, url: `https://${id}.com/`, title: id, at, ...overrides });
  const alarm = () => chrome._data.alarms.get(SNOOZE_ALARM);

  it('getSnoozed validates and fills defaults', async () => {
    localArea._data.set(KEY.SNOOZED, [
      item('a', 10, { windowId: 3, pinned: true, t: 4, junk: 1, group: { id: 4, title: 'Work', color: 'blue' } }),
      item('b', 20, { title: 'x'.repeat(400), windowId: -1, pinned: 'yes', t: 'x', group: { title: 5 } }),
      { ...item('c', 30), id: 5 }, { ...item('d', 30), url: 'https://d/' + 'x'.repeat(LIMITS.MAX_URL_KEY) }, item('e', 0), null,
    ]);
    expect(await store.getSnoozed()).toEqual([
      { id: 'a', url: 'https://a.com/', title: 'a', at: 10, windowId: 3, pinned: true, t: 4, group: { id: 4, title: 'Work', color: 'blue' } },
      { id: 'b', url: 'https://b.com/', title: 'x'.repeat(300), at: 20, windowId: null, pinned: false, t: 20, group: null },
    ]);
    localArea._data.set(KEY.SNOOZED, {});
    expect(await store.getSnoozed()).toEqual([]);
  });

  it('addSnoozed appends valid items and sets the alarm to the soonest', async () => {
    const list = await store.addSnoozed([item('a', NOW + 50000), item('b', NOW + 20000), { id: 'bad' }]);
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    expect(alarm().scheduledTime).toBe(NOW + 20000);
  });

  it('the alarm is never set in the past', async () => {
    await store.addSnoozed([item('a', NOW - 5000)]);
    expect(alarm().scheduledTime).toBe(NOW + 1000);
  });

  it('addSnoozed keeps the newest MAX_SNOOZED', async () => {
    localArea._data.set(KEY.SNOOZED, Array.from({ length: LIMITS.MAX_SNOOZED }, (unused, i) => item('p' + i, NOW + 1000 + i)));
    const list = await store.addSnoozed([item('new', NOW + 5000)]);
    expect(list).toHaveLength(LIMITS.MAX_SNOOZED);
    expect(list[0].id).toBe('p1');
    expect(list.at(-1).id).toBe('new');
  });

  it('removeSnoozed drops by id, and clears the alarm when none are left', async () => {
    await store.addSnoozed([item('a', NOW + 5000), item('b', NOW + 9000)]);
    expect((await store.removeSnoozed(['a'])).map((x) => x.id)).toEqual(['b']);
    expect(alarm().scheduledTime).toBe(NOW + 9000);
    expect(await store.removeSnoozed(['b'])).toEqual([]);
    expect(alarm()).toBeUndefined();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(SNOOZE_ALARM);
  });

  it('takeDueSnoozed returns the due ones and keeps the rest', async () => {
    await store.addSnoozed([item('a', NOW + 1000), item('b', NOW + 2000), item('c', NOW + 3000)]);
    expect((await store.takeDueSnoozed(NOW + 2000)).map((x) => x.id)).toEqual(['a', 'b']);
    expect((await store.getSnoozed()).map((x) => x.id)).toEqual(['c']);
    expect(alarm().scheduledTime).toBe(NOW + 3000);
    localArea.set.mockClear();
    expect(await store.takeDueSnoozed(NOW + 2500)).toEqual([]);
    expect(localArea.set).not.toHaveBeenCalled(); // nothing due: no write
  });

  it('takeDueSnoozed defaults to now', async () => {
    await store.addSnoozed([item('a', NOW - 1), item('b', NOW + 1)]);
    expect((await store.takeDueSnoozed()).map((x) => x.id)).toEqual(['a']);
  });

  it('takeDueSnoozed takes at most `max`, leaving out the ids in `skip`', async () => {
    await store.addSnoozed([item('a', NOW - 3), item('b', NOW - 2), item('c', NOW - 1), item('d', NOW + 1000)]);
    expect((await store.takeDueSnoozed(NOW, { max: 1, skip: ['a'] })).map((x) => x.id)).toEqual(['b']);
    expect((await store.getSnoozed()).map((x) => x.id)).toEqual(['a', 'c', 'd']); // the rest stay until taken
    expect(alarm().scheduledTime).toBe(NOW + 1000);
    expect(await store.takeDueSnoozed(NOW, { skip: ['a', 'c'] })).toEqual([]);
  });

  it('putBackSnoozed returns a tab that could not be reopened, as it was, once', async () => {
    await store.addSnoozed([item('a', NOW - 1, { windowId: 3 }), item('b', NOW + 5000)]);
    const [dueItem] = await store.takeDueSnoozed(NOW);
    expect(alarm().scheduledTime).toBe(NOW + 5000);
    expect((await store.putBackSnoozed(dueItem)).map((x) => x.id)).toEqual(['b', 'a']);
    expect((await store.getSnoozed()).find((x) => x.id === 'a')).toEqual(dueItem);
    expect(alarm().scheduledTime).toBe(NOW + 1000); // due: the next alarm tries again
    localArea.set.mockClear();
    expect(await store.putBackSnoozed(dueItem)).toHaveLength(2); // there already: not doubled
    expect(await store.putBackSnoozed({ id: 'bad' })).toHaveLength(2);
    expect(localArea.set).not.toHaveBeenCalled();
  });

  it('a failing alarms API does not fail the change', async () => {
    chrome.alarms.create.mockRejectedValueOnce(new Error('no'));
    expect(await store.addSnoozed([item('a', NOW + 1000)])).toHaveLength(1);
  });

  it('concurrent adds are not lost', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.addSnoozed([item(id, NOW + 1000)])));
    expect(await store.getSnoozed()).toHaveLength(4);
  });
});

describe('notes', () => {
  it('setNote stores trimmed text keyed by normalized URL', async () => {
    const notes = await store.setNote('https://a.com/x/#frag', '  hello  ');
    expect(notes).toEqual({ 'https://a.com/x': { u: 'https://a.com/x/#frag', n: 'hello', t: NOW } });
    expect(await store.getNotes()).toEqual(notes);
  });

  it('caps the text, and empty text removes the note', async () => {
    await store.setNote('https://a.com', 'x'.repeat(LIMITS.NOTE_MAX + 50));
    expect((await store.getNotes())['https://a.com/'].n).toHaveLength(LIMITS.NOTE_MAX);
    expect(await store.setNote('https://a.com', '   ')).toEqual({});
    expect(await store.getNotes()).toEqual({});
  });

  it('does not write when nothing changed or the URL is unusable', async () => {
    await store.setNote('https://a.com', 'hi');
    localArea.set.mockClear();
    await store.setNote('https://a.com/', ' hi ');
    await store.setNote('https://b.com', '');
    expect(await store.setNote('not a url', 'hi')).toHaveProperty(['https://a.com/']);
    expect(localArea.set).not.toHaveBeenCalled();
  });

  it('keeps the newest MAX_NOTES', async () => {
    const many = {};
    for (let i = 0; i < LIMITS.MAX_NOTES; i++) many[`https://p${i}/`] = { u: `https://p${i}/`, n: 'x', t: NOW - 100000 + i };
    localArea._data.set(KEY.NOTES, many);
    const notes = await store.setNote('https://new.com', 'hi');
    expect(Object.keys(notes)).toHaveLength(LIMITS.MAX_NOTES);
    expect(notes).toHaveProperty(['https://new.com/']);
    expect(notes).not.toHaveProperty(['https://p0/']);
  });

  it('getNotes validates', async () => {
    localArea._data.set(KEY.NOTES, {
      'https://a/': { u: 5, n: 'x'.repeat(LIMITS.NOTE_MAX + 1), t: 1 },
      'https://b/': { n: '', t: 1 }, 'https://c/': { n: 'x', t: 0 }, 'https://d/': { n: 3, t: 1 }, 'https://e/': null,
    });
    expect(await store.getNotes()).toEqual({ 'https://a/': { u: '5', n: 'x'.repeat(LIMITS.NOTE_MAX), t: 1 } });
    localArea._data.set(KEY.NOTES, ['x']);
    expect(await store.getNotes()).toEqual({});
  });
});

describe('stars', () => {
  it('toggleStar stars and unstars by normalized URL', async () => {
    expect(await store.toggleStar('https://a.com/#x', 'A')).toBe(true);
    expect(await store.getStars()).toEqual({ 'https://a.com/': { u: 'https://a.com/#x', ti: 'A', t: NOW } });
    expect(await store.toggleStar('https://a.com', 'A')).toBe(false);
    expect(await store.getStars()).toEqual({});
  });

  it('caps the title, rejects unusable URLs', async () => {
    await store.toggleStar('https://a.com', 'x'.repeat(400));
    expect((await store.getStars())['https://a.com/'].ti).toHaveLength(300);
    expect(await store.toggleStar('', 'x')).toBe(false);
    expect(await store.toggleStar('https://b.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY), 'x')).toBe(false);
  });

  it('keeps the newest MAX_STARS', async () => {
    const many = {};
    for (let i = 0; i < LIMITS.MAX_STARS; i++) many[`https://p${i}/`] = { u: `https://p${i}/`, t: NOW - 100000 + i };
    localArea._data.set(KEY.STARS, many);
    await store.toggleStar('https://new.com', 'N');
    const stars = await store.getStars();
    expect(Object.keys(stars)).toHaveLength(LIMITS.MAX_STARS);
    expect(stars).toHaveProperty(['https://new.com/']);
    expect(stars).not.toHaveProperty(['https://p0/']);
  });

  it('getStars validates', async () => {
    localArea._data.set(KEY.STARS, { 'https://a/': { u: 'https://a/', ti: 7, t: 1 }, 'https://b/': { u: 1, t: 1 }, 'https://c/': { u: 'https://c/', t: -1 }, 'https://d/': 'x' });
    expect(await store.getStars()).toEqual({ 'https://a/': { u: 'https://a/', ti: '7', t: 1 } });
    localArea._data.set(KEY.STARS, []);
    expect(await store.getStars()).toEqual({});
  });

  it('concurrent toggles of different pages are not lost', async () => {
    await Promise.all(['a', 'b', 'c'].map((x) => store.toggleStar(`https://${x}.com`, x)));
    expect(Object.keys(await store.getStars())).toHaveLength(3);
  });
});

const VIEWS = { historyLayout: 'list', historyRange: 'all', bookmarksViewOpen: [], bookmarksViewSelected: '' }; // the History and Bookmarks views' own
describe('view', () => {
  it('SORTS lists the sort orders', () => {
    expect(store.SORTS).toEqual(['recent', 'order', 'name']);
    expect(Object.isFrozen(store.SORTS)).toBe(true);
  });

  it('SETTINGS_TABS lists the categories of Settings', () => {
    expect(store.SETTINGS_TABS).toEqual(['look', 'cards', 'search', 'behave', 'keys']);
    expect(Object.isFrozen(store.SETTINGS_TABS)).toBe(true);
  });

  it('getView validates', async () => {
    expect(await store.getView()).toEqual({ sort: 'recent', collapsed: [], settingsTab: 'look', markFolder: '', ...VIEWS });
    localArea._data.set(KEY.VIEW, { sort: 'name', collapsed: ['a', 3, 'x'.repeat(301), 'b'], settingsTab: 'keys', markFolder: '12' });
    expect(await store.getView()).toEqual({ sort: 'name', collapsed: ['a', 'b'], settingsTab: 'keys', markFolder: '12', ...VIEWS });
    localArea._data.set(KEY.VIEW, { sort: 'size', collapsed: 'a', settingsTab: 'colours', markFolder: 'no such id!' });
    expect(await store.getView()).toEqual({ sort: 'recent', collapsed: [], settingsTab: 'look', markFolder: '', ...VIEWS });
    localArea._data.set(KEY.VIEW, { historyQuery: 'x'.repeat(300), historyLayout: 'grid', historyRange: 'week', bmvQ: 7, bookmarksViewOpen: ['1', 'bad id!', 5, '22'], bookmarksViewSelected: '9' });
    expect(await store.getView()).toMatchObject({ historyLayout: 'grid', historyRange: 'week', bookmarksViewOpen: ['1', '22'], bookmarksViewSelected: '9' });
    expect('histQ' in (await store.getView()) || 'bmvQ' in (await store.getView())).toBe(false); // (the searches aren't kept)
    localArea._data.set(KEY.VIEW, { historyLayout: 'tiles', historyRange: 'year', bookmarksViewSelected: 'no!' });
    expect(await store.getView()).toMatchObject({ historyLayout: 'list', historyRange: 'all', bookmarksViewSelected: '' });
    // saved before the fields had their full names: still read, and written back under the new ones
    localArea._data.set(KEY.VIEW, { histLayout: 'grid', histRange: 'month', bmvOpen: ['3'], bmvSel: '4' });
    expect(await store.getView()).toMatchObject({ historyLayout: 'grid', historyRange: 'month', bookmarksViewOpen: ['3'], bookmarksViewSelected: '4' });
    await store.updateView({ sort: 'name' });
    expect(Object.keys(localArea._data.get(KEY.VIEW)).filter((name) => ['histLayout', 'histRange', 'bmvOpen', 'bmvSel'].includes(name))).toEqual([]);
    localArea._data.set(KEY.VIEW, { settingsTab: ['keys'] });
    expect((await store.getView()).settingsTab).toBe('look');
    localArea._data.set(KEY.VIEW, { collapsed: Array.from({ length: LIMITS.MAX_COLLAPSED + 5 }, (unused, i) => 'c' + i) });
    expect((await store.getView()).collapsed).toHaveLength(LIMITS.MAX_COLLAPSED);
  });

  it('updateView merges and keeps the newest MAX_COLLAPSED', async () => {
    expect(await store.updateView({ sort: 'order' })).toEqual({ sort: 'order', collapsed: [], settingsTab: 'look', markFolder: '', ...VIEWS });
    const collapsed = Array.from({ length: LIMITS.MAX_COLLAPSED + 5 }, (unused, i) => 'c' + i);
    const next = await store.updateView({ collapsed });
    expect(next.sort).toBe('order');
    expect(next.collapsed).toEqual(collapsed.slice(5));
    expect(localArea._data.get(KEY.VIEW)).toEqual(next);
  });
});

describe('prefs', () => {
  const defaults = {
    lang: 'auto', startup: false, cardSize: 'default', accent: DEFAULT_ACCENT, allWindows: false, theme: 'system',
    pinnedFirst: true, showClosed: true, showSnoozed: true, showAge: true, showGroups: true, groupWrap: false, ownWindow: false, titleLines: 2,
    searchHistory: true, searchBookmarks: true, lite: false, iconTips: 0,
  };
  const SWITCHES = ['pinnedFirst', 'showClosed', 'showSnoozed', 'showAge', 'showGroups', 'searchHistory', 'searchBookmarks']; // on unless set to false

  it('defaults', async () => {
    expect(await store.getPreferences()).toEqual(defaults);
  });

  it('accepts every valid value', async () => {
    for (const lang of ['auto', 'en', 'el', 'de', 'it', 'fr', 'es', 'ru', 'ar', 'he', 'ro']) { localArea._data.set(KEY.PREFERENCES, { lang }); expect((await store.getPreferences()).lang).toBe(lang); }
    for (const cardSize of ['small', 'list']) { localArea._data.set(KEY.PREFERENCES, { cardSize }); expect((await store.getPreferences()).cardSize).toBe(cardSize); }
    for (const theme of ['dark', 'light', 'system']) { localArea._data.set(KEY.PREFERENCES, { theme }); expect((await store.getPreferences()).theme).toBe(theme); }
    localArea._data.set(KEY.PREFERENCES, { startup: true, allWindows: true, accent: '#abcdef', groupWrap: true, lite: true });
    expect(await store.getPreferences()).toEqual({ ...defaults, startup: true, allWindows: true, accent: '#ABCDEF', groupWrap: true, lite: true });
    localArea._data.set(KEY.PREFERENCES, { ...Object.fromEntries(SWITCHES.map((switchName) => [switchName, false])), ownWindow: true, titleLines: 1, iconTips: 3 });
    expect(await store.getPreferences()).toEqual({ ...defaults, ...Object.fromEntries(SWITCHES.map((switchName) => [switchName, false])), ownWindow: true, titleLines: 1, iconTips: 3 });
  });

  it('replaces every invalid field with its default', async () => {
    localArea._data.set(KEY.PREFERENCES, { lang: 'pt', startup: 'true', cardSize: 'huge', accent: 'red', allWindows: 1, theme: 'neon', lite: 'yes', junk: 1 });
    expect(await store.getPreferences()).toEqual(defaults);
    localArea._data.set(KEY.PREFERENCES, { accent: '#abc' });
    expect((await store.getPreferences()).accent).toBe(DEFAULT_ACCENT);
    localArea._data.set(KEY.PREFERENCES, { ...Object.fromEntries(SWITCHES.map((switchName) => [switchName, 'false'])), ownWindow: 'true', titleLines: 3, iconTips: -1 });
    expect(await store.getPreferences()).toEqual(defaults);
    for (const iconTips of [1.5, '2', null]) { localArea._data.set(KEY.PREFERENCES, { iconTips }); expect((await store.getPreferences()).iconTips).toBe(0); }
    localArea._data.set(KEY.PREFERENCES, { titleLines: '1' });
    expect((await store.getPreferences()).titleLines).toBe(2);
  });

  it('updatePrefs merges a patch; reads validate it', async () => {
    expect(await store.updatePreferences({ theme: 'light' })).toEqual({ ...defaults, theme: 'light' });
    await store.updatePreferences({ startup: true });
    expect(await store.getPreferences()).toEqual({ ...defaults, theme: 'light', startup: true });
    await store.updatePreferences({ theme: 'bogus' });
    expect((await store.getPreferences()).theme).toBe('system');
    await store.updatePreferences({ iconTips: 1, showAge: false });
    expect(await store.getPreferences()).toMatchObject({ iconTips: 1, showAge: false, startup: true });
  });

  it('concurrent updates are not lost', async () => {
    await Promise.all([store.updatePreferences({ theme: 'light' }), store.updatePreferences({ startup: true }), store.updatePreferences({ lang: 'ru' })]);
    expect(await store.getPreferences()).toEqual({ ...defaults, theme: 'light', startup: true, lang: 'ru' });
  });
});

describe('the command palette’s recent actions', () => {
  it('getPaletteRecent: valid ids only, no repeats, capped', async () => {
    expect(await store.getPaletteRecent()).toEqual([]);
    localArea._data.set(KEY.PALETTE_RECENT, 'zoom-in');
    expect(await store.getPaletteRecent()).toEqual([]);
    localArea._data.set(KEY.PALETTE_RECENT, ['zoom-in', 'zoom-in', 5, 'Bad Id', '<x>', 'new-tab', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(await store.getPaletteRecent()).toEqual(['zoom-in', 'new-tab', 'a', 'b', 'c', 'd'].slice(0, LIMITS.PALETTE_RECENT));
  });

  it('notePaletteRecent puts an id first, once, and keeps at most PALETTE_RECENT', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await store.notePaletteRecent(id);
    expect(await store.notePaletteRecent('c')).toEqual(['c', 'g', 'f', 'e', 'd', 'b'].slice(0, LIMITS.PALETTE_RECENT));
    expect(localArea._data.get(KEY.PALETTE_RECENT)[0]).toBe('c');
    expect(await store.notePaletteRecent('Not valid!')).toEqual(localArea._data.get(KEY.PALETTE_RECENT)); // nothing written
  });
});

describe('"Recently closed" entries removed from the list', () => {
  it('closedKey: the page\'s normalized address, "w:" before it for a closed window', () => {
    expect(store.closedKey({ kind: 'tab', url: 'https://a.com/x/#top' })).toBe('https://a.com/x');
    expect(store.closedKey({ kind: 'window', url: 'https://a.com/' })).toBe('w:https://a.com/');
  });

  it('hideClosed keeps the newest time per key; with `show` it forgets them again', async () => {
    expect(await store.getClosedHidden()).toEqual({});
    await store.hideClosed({ a: NOW - 100 });
    await store.hideClosed({ a: NOW - 500, b: NOW - 200 });
    expect(await store.getClosedHidden()).toEqual({ a: NOW - 100, b: NOW - 200 });
    expect(await store.hideClosed({ a: 0 }, true)).toEqual({ b: NOW - 200 });
  });

  it('getClosedHidden validates and drops what is older than a month; at most MAX_CLOSED_HIDDEN are kept', async () => {
    localArea._data.set(KEY.CLOSED_HIDDEN, { old: NOW - LIMITS.CLOSED_HIDDEN_TIME_TO_LIVE_MILLISECONDS - 1, bad: 'x', ok: NOW - 1000 });
    expect(await store.getClosedHidden()).toEqual({ ok: NOW - 1000 });
    const many = Object.fromEntries(Array.from({ length: LIMITS.MAX_CLOSED_HIDDEN + 5 }, (unused, i) => ['k' + i, NOW - i]));
    const kept = await store.hideClosed(many);
    expect(Object.keys(kept)).toHaveLength(LIMITS.MAX_CLOSED_HIDDEN);
    expect(kept.k0).toBe(NOW); // the newest stay
  });
});

describe('notes on bookmarks', () => {
  it('are kept by bookmark id, not by address; an empty text removes one', async () => {
    let notes = await store.putBookmarkNotes({ 11: { n: ' read later ', u: 'https://a.example/' }, 12: { n: 'other', u: 'https://a.example/' } });
    expect(notes[11]).toMatchObject({ n: 'read later', u: 'https://a.example/' });
    expect(notes[12].n).toBe('other'); // the same address, its own note
    notes = await store.setBookmarkNote('11', '');
    expect(notes[11]).toBe(undefined);
    expect(Object.keys(await store.getBookmarkNotes())).toEqual(['12']);
  });

});
