// storage.local settings and user data: review/onboarding/nudge counters, snoozed tabs, notes, stars, view, prefs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS, SNOOZE_ALARM } from '../../utils/constants.js';
import { DEFAULT_ACCENT } from '../../utils/accent.js';

const L = chrome.storage.local;
const NOW = 1_800_000_000_000;

let s;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  s = await import('../../utils/store.js');
});
afterEach(() => vi.useRealTimers());

describe('review counters', () => {
  const empty = { since: NOW, opens: 0, soft: 0, lastSoft: 0, asks: 0, lastAsk: 0, done: false, day: '' };

  it('getReview starts empty and validates every field', async () => {
    expect(await s.getReview()).toEqual(empty);
    L._data.set(KEY.REVIEW, 'x');
    expect(await s.getReview()).toEqual(empty);
    L._data.set(KEY.REVIEW, { since: 5, opens: 3.7, soft: -1, lastSoft: 'x', asks: Infinity, lastAsk: 9, done: 'yes', day: '2026-1-1' });
    expect(await s.getReview()).toEqual({ since: 5, opens: 3, soft: 0, lastSoft: 0, asks: 0, lastAsk: 9, done: false, day: '2026-1-1' });
    L._data.set(KEY.REVIEW, { since: -5, done: true, day: 'x'.repeat(13) });
    expect(await s.getReview()).toEqual({ ...empty, done: true });
  });

  it('updateReview applies the change, cleans and stores the result', async () => {
    const next = await s.updateReview((r) => ({ ...r, opens: r.opens + 1, done: 1 }));
    expect(next).toEqual({ ...empty, opens: 1 });
    expect(L._data.get(KEY.REVIEW)).toEqual(next);
  });

  it('concurrent updates are not lost', async () => {
    await Promise.all(Array.from({ length: 10 }, () => s.updateReview((r) => ({ ...r, opens: r.opens + 1 }))));
    expect((await s.getReview()).opens).toBe(10);
  });
});

describe('onboarding flags', () => {
  it('getOnboard validates', async () => {
    expect(await s.getOnboard()).toEqual({ at: 0, flyout: false, tour: false });
    L._data.set(KEY.ONBOARD, { at: 'x', flyout: 1, tour: 0, junk: true });
    expect(await s.getOnboard()).toEqual({ at: 0, flyout: true, tour: false });
  });

  it('updateOnboard merges a patch', async () => {
    await s.updateOnboard({ at: 5 });
    expect(await s.updateOnboard({ tour: true })).toEqual({ at: 5, flyout: false, tour: true });
    expect(await s.getOnboard()).toEqual({ at: 5, flyout: false, tour: true });
  });
});

describe('nudge counters', () => {
  it('getNudge validates', async () => {
    expect(await s.getNudge()).toEqual({ day: '', runs: 0, shown: 0, last: 0, never: false });
    L._data.set(KEY.NUDGE, { day: 3, runs: 2.5, shown: -1, last: NOW, never: 'true' });
    expect(await s.getNudge()).toEqual({ day: '', runs: 2, shown: 0, last: NOW, never: false });
  });

  it('updateNudge stores what the change returns', async () => {
    expect(await s.updateNudge((n) => ({ ...n, runs: n.runs + 1, day: 'd' }))).toEqual({ day: 'd', runs: 1, shown: 0, last: 0, never: false });
    await Promise.all([1, 2, 3].map(() => s.updateNudge((n) => ({ ...n, runs: n.runs + 1 }))));
    expect((await s.getNudge()).runs).toBe(4);
  });
});

describe('snoozed tabs', () => {
  const item = (id, at, p = {}) => ({ id, url: `https://${id}.com/`, title: id, at, ...p });
  const alarm = () => chrome._data.alarms.get(SNOOZE_ALARM);

  it('getSnoozed validates and fills defaults', async () => {
    L._data.set(KEY.SNOOZED, [
      item('a', 10, { windowId: 3, pinned: true, t: 4, junk: 1 }),
      item('b', 20, { title: 'x'.repeat(400), windowId: -1, pinned: 'yes', t: 'x' }),
      { ...item('c', 30), id: 5 }, { ...item('d', 30), url: 'https://d/' + 'x'.repeat(LIMITS.MAX_URL_KEY) }, item('e', 0), null,
    ]);
    expect(await s.getSnoozed()).toEqual([
      { id: 'a', url: 'https://a.com/', title: 'a', at: 10, windowId: 3, pinned: true, t: 4 },
      { id: 'b', url: 'https://b.com/', title: 'x'.repeat(300), at: 20, windowId: null, pinned: false, t: 20 },
    ]);
    L._data.set(KEY.SNOOZED, {});
    expect(await s.getSnoozed()).toEqual([]);
  });

  it('addSnoozed appends valid items and sets the alarm to the soonest', async () => {
    const list = await s.addSnoozed([item('a', NOW + 50000), item('b', NOW + 20000), { id: 'bad' }]);
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    expect(alarm().scheduledTime).toBe(NOW + 20000);
  });

  it('the alarm is never set in the past', async () => {
    await s.addSnoozed([item('a', NOW - 5000)]);
    expect(alarm().scheduledTime).toBe(NOW + 1000);
  });

  it('addSnoozed keeps the newest MAX_SNOOZED', async () => {
    L._data.set(KEY.SNOOZED, Array.from({ length: LIMITS.MAX_SNOOZED }, (_, i) => item('p' + i, NOW + 1000 + i)));
    const list = await s.addSnoozed([item('new', NOW + 5000)]);
    expect(list).toHaveLength(LIMITS.MAX_SNOOZED);
    expect(list[0].id).toBe('p1');
    expect(list.at(-1).id).toBe('new');
  });

  it('removeSnoozed drops by id, and clears the alarm when none are left', async () => {
    await s.addSnoozed([item('a', NOW + 5000), item('b', NOW + 9000)]);
    expect((await s.removeSnoozed(['a'])).map((x) => x.id)).toEqual(['b']);
    expect(alarm().scheduledTime).toBe(NOW + 9000);
    expect(await s.removeSnoozed(['b'])).toEqual([]);
    expect(alarm()).toBeUndefined();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(SNOOZE_ALARM);
  });

  it('takeDueSnoozed returns the due ones and keeps the rest', async () => {
    await s.addSnoozed([item('a', NOW + 1000), item('b', NOW + 2000), item('c', NOW + 3000)]);
    expect((await s.takeDueSnoozed(NOW + 2000)).map((x) => x.id)).toEqual(['a', 'b']);
    expect((await s.getSnoozed()).map((x) => x.id)).toEqual(['c']);
    expect(alarm().scheduledTime).toBe(NOW + 3000);
    L.set.mockClear();
    expect(await s.takeDueSnoozed(NOW + 2500)).toEqual([]);
    expect(L.set).not.toHaveBeenCalled(); // nothing due: no write
  });

  it('takeDueSnoozed defaults to now', async () => {
    await s.addSnoozed([item('a', NOW - 1), item('b', NOW + 1)]);
    expect((await s.takeDueSnoozed()).map((x) => x.id)).toEqual(['a']);
  });

  it('a failing alarms API does not fail the change', async () => {
    chrome.alarms.create.mockRejectedValueOnce(new Error('no'));
    expect(await s.addSnoozed([item('a', NOW + 1000)])).toHaveLength(1);
  });

  it('concurrent adds are not lost', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => s.addSnoozed([item(id, NOW + 1000)])));
    expect(await s.getSnoozed()).toHaveLength(4);
  });
});

describe('notes', () => {
  it('setNote stores trimmed text keyed by normalized URL', async () => {
    const notes = await s.setNote('https://a.com/x/#frag', '  hello  ');
    expect(notes).toEqual({ 'https://a.com/x': { u: 'https://a.com/x/#frag', n: 'hello', t: NOW } });
    expect(await s.getNotes()).toEqual(notes);
  });

  it('caps the text, and empty text removes the note', async () => {
    await s.setNote('https://a.com', 'x'.repeat(LIMITS.NOTE_MAX + 50));
    expect((await s.getNotes())['https://a.com/'].n).toHaveLength(LIMITS.NOTE_MAX);
    expect(await s.setNote('https://a.com', '   ')).toEqual({});
    expect(await s.getNotes()).toEqual({});
  });

  it('does not write when nothing changed or the URL is unusable', async () => {
    await s.setNote('https://a.com', 'hi');
    L.set.mockClear();
    await s.setNote('https://a.com/', ' hi ');
    await s.setNote('https://b.com', '');
    expect(await s.setNote('not a url', 'hi')).toHaveProperty(['https://a.com/']);
    expect(L.set).not.toHaveBeenCalled();
  });

  it('keeps the newest MAX_NOTES', async () => {
    const many = {};
    for (let i = 0; i < LIMITS.MAX_NOTES; i++) many[`https://p${i}/`] = { u: `https://p${i}/`, n: 'x', t: NOW - 100000 + i };
    L._data.set(KEY.NOTES, many);
    const notes = await s.setNote('https://new.com', 'hi');
    expect(Object.keys(notes)).toHaveLength(LIMITS.MAX_NOTES);
    expect(notes).toHaveProperty(['https://new.com/']);
    expect(notes).not.toHaveProperty(['https://p0/']);
  });

  it('getNotes validates', async () => {
    L._data.set(KEY.NOTES, {
      'https://a/': { u: 5, n: 'x'.repeat(LIMITS.NOTE_MAX + 1), t: 1 },
      'https://b/': { n: '', t: 1 }, 'https://c/': { n: 'x', t: 0 }, 'https://d/': { n: 3, t: 1 }, 'https://e/': null,
    });
    expect(await s.getNotes()).toEqual({ 'https://a/': { u: '5', n: 'x'.repeat(LIMITS.NOTE_MAX), t: 1 } });
    L._data.set(KEY.NOTES, ['x']);
    expect(await s.getNotes()).toEqual({});
  });
});

describe('stars', () => {
  it('toggleStar stars and unstars by normalized URL', async () => {
    expect(await s.toggleStar('https://a.com/#x', 'A')).toBe(true);
    expect(await s.getStars()).toEqual({ 'https://a.com/': { u: 'https://a.com/#x', ti: 'A', t: NOW } });
    expect(await s.toggleStar('https://a.com', 'A')).toBe(false);
    expect(await s.getStars()).toEqual({});
  });

  it('caps the title, rejects unusable URLs', async () => {
    await s.toggleStar('https://a.com', 'x'.repeat(400));
    expect((await s.getStars())['https://a.com/'].ti).toHaveLength(300);
    expect(await s.toggleStar('', 'x')).toBe(false);
    expect(await s.toggleStar('https://b.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY), 'x')).toBe(false);
  });

  it('keeps the newest MAX_STARS', async () => {
    const many = {};
    for (let i = 0; i < LIMITS.MAX_STARS; i++) many[`https://p${i}/`] = { u: `https://p${i}/`, t: NOW - 100000 + i };
    L._data.set(KEY.STARS, many);
    await s.toggleStar('https://new.com', 'N');
    const stars = await s.getStars();
    expect(Object.keys(stars)).toHaveLength(LIMITS.MAX_STARS);
    expect(stars).toHaveProperty(['https://new.com/']);
    expect(stars).not.toHaveProperty(['https://p0/']);
  });

  it('getStars validates', async () => {
    L._data.set(KEY.STARS, { 'https://a/': { u: 'https://a/', ti: 7, t: 1 }, 'https://b/': { u: 1, t: 1 }, 'https://c/': { u: 'https://c/', t: -1 }, 'https://d/': 'x' });
    expect(await s.getStars()).toEqual({ 'https://a/': { u: 'https://a/', ti: '7', t: 1 } });
    L._data.set(KEY.STARS, []);
    expect(await s.getStars()).toEqual({});
  });

  it('concurrent toggles of different pages are not lost', async () => {
    await Promise.all(['a', 'b', 'c'].map((x) => s.toggleStar(`https://${x}.com`, x)));
    expect(Object.keys(await s.getStars())).toHaveLength(3);
  });
});

describe('view', () => {
  it('SORTS lists the sort orders', () => {
    expect(s.SORTS).toEqual(['recent', 'order', 'name']);
    expect(Object.isFrozen(s.SORTS)).toBe(true);
  });

  it('SETTINGS_TABS lists the categories of Settings', () => {
    expect(s.SETTINGS_TABS).toEqual(['look', 'cards', 'search', 'behave', 'keys']);
    expect(Object.isFrozen(s.SETTINGS_TABS)).toBe(true);
  });

  it('getView validates', async () => {
    expect(await s.getView()).toEqual({ sort: 'recent', collapsed: [], settingsTab: 'look', markFolder: '' });
    L._data.set(KEY.VIEW, { sort: 'name', collapsed: ['a', 3, 'x'.repeat(301), 'b'], settingsTab: 'keys', markFolder: '12' });
    expect(await s.getView()).toEqual({ sort: 'name', collapsed: ['a', 'b'], settingsTab: 'keys', markFolder: '12' });
    L._data.set(KEY.VIEW, { sort: 'size', collapsed: 'a', settingsTab: 'colours', markFolder: 'no such id!' });
    expect(await s.getView()).toEqual({ sort: 'recent', collapsed: [], settingsTab: 'look', markFolder: '' });
    L._data.set(KEY.VIEW, { settingsTab: ['keys'] });
    expect((await s.getView()).settingsTab).toBe('look');
    L._data.set(KEY.VIEW, { collapsed: Array.from({ length: LIMITS.MAX_COLLAPSED + 5 }, (_, i) => 'c' + i) });
    expect((await s.getView()).collapsed).toHaveLength(LIMITS.MAX_COLLAPSED);
  });

  it('updateView merges and keeps the newest MAX_COLLAPSED', async () => {
    expect(await s.updateView({ sort: 'order' })).toEqual({ sort: 'order', collapsed: [], settingsTab: 'look', markFolder: '' });
    const collapsed = Array.from({ length: LIMITS.MAX_COLLAPSED + 5 }, (_, i) => 'c' + i);
    const next = await s.updateView({ collapsed });
    expect(next.sort).toBe('order');
    expect(next.collapsed).toEqual(collapsed.slice(5));
    expect(L._data.get(KEY.VIEW)).toEqual(next);
  });
});

describe('prefs', () => {
  const defaults = {
    lang: 'auto', startup: false, cardSize: 'default', accent: DEFAULT_ACCENT, allWindows: false, theme: 'system',
    pinnedFirst: true, showClosed: true, showSnoozed: true, showAge: true, showGroups: true, ownWindow: false, titleLines: 2,
    searchHistory: true, searchBookmarks: true, iconTips: 0,
  };
  const SWITCHES = ['pinnedFirst', 'showClosed', 'showSnoozed', 'showAge', 'showGroups', 'searchHistory', 'searchBookmarks']; // on unless set to false

  it('defaults', async () => {
    expect(await s.getPrefs()).toEqual(defaults);
  });

  it('accepts every valid value', async () => {
    for (const lang of ['auto', 'en', 'ru', 'es']) { L._data.set(KEY.PREFS, { lang }); expect((await s.getPrefs()).lang).toBe(lang); }
    for (const cardSize of ['small', 'list']) { L._data.set(KEY.PREFS, { cardSize }); expect((await s.getPrefs()).cardSize).toBe(cardSize); }
    for (const theme of ['dark', 'light', 'system']) { L._data.set(KEY.PREFS, { theme }); expect((await s.getPrefs()).theme).toBe(theme); }
    L._data.set(KEY.PREFS, { startup: true, allWindows: true, accent: '#abcdef' });
    expect(await s.getPrefs()).toEqual({ ...defaults, startup: true, allWindows: true, accent: '#ABCDEF' });
    L._data.set(KEY.PREFS, { ...Object.fromEntries(SWITCHES.map((k) => [k, false])), ownWindow: true, titleLines: 1, iconTips: 3 });
    expect(await s.getPrefs()).toEqual({ ...defaults, ...Object.fromEntries(SWITCHES.map((k) => [k, false])), ownWindow: true, titleLines: 1, iconTips: 3 });
  });

  it('replaces every invalid field with its default', async () => {
    L._data.set(KEY.PREFS, { lang: 'de', startup: 'true', cardSize: 'huge', accent: 'red', allWindows: 1, theme: 'neon', junk: 1 });
    expect(await s.getPrefs()).toEqual(defaults);
    L._data.set(KEY.PREFS, { accent: '#abc' });
    expect((await s.getPrefs()).accent).toBe(DEFAULT_ACCENT);
    L._data.set(KEY.PREFS, { ...Object.fromEntries(SWITCHES.map((k) => [k, 'false'])), ownWindow: 'true', titleLines: 3, iconTips: -1 });
    expect(await s.getPrefs()).toEqual(defaults);
    for (const iconTips of [1.5, '2', null]) { L._data.set(KEY.PREFS, { iconTips }); expect((await s.getPrefs()).iconTips).toBe(0); }
    L._data.set(KEY.PREFS, { titleLines: '1' });
    expect((await s.getPrefs()).titleLines).toBe(2);
  });

  it('updatePrefs merges a patch; reads validate it', async () => {
    expect(await s.updatePrefs({ theme: 'light' })).toEqual({ ...defaults, theme: 'light' });
    await s.updatePrefs({ startup: true });
    expect(await s.getPrefs()).toEqual({ ...defaults, theme: 'light', startup: true });
    await s.updatePrefs({ theme: 'bogus' });
    expect((await s.getPrefs()).theme).toBe('system');
    await s.updatePrefs({ iconTips: 1, showAge: false });
    expect(await s.getPrefs()).toMatchObject({ iconTips: 1, showAge: false, startup: true });
  });

  it('concurrent updates are not lost', async () => {
    await Promise.all([s.updatePrefs({ theme: 'light' }), s.updatePrefs({ startup: true }), s.updatePrefs({ lang: 'ru' })]);
    expect(await s.getPrefs()).toEqual({ ...defaults, theme: 'light', startup: true, lang: 'ru' });
  });
});

describe('the command palette’s recent actions', () => {
  it('getPaletteRecent: valid ids only, no repeats, capped', async () => {
    expect(await s.getPaletteRecent()).toEqual([]);
    L._data.set(KEY.PALETTE_RECENT, 'zoom-in');
    expect(await s.getPaletteRecent()).toEqual([]);
    L._data.set(KEY.PALETTE_RECENT, ['zoom-in', 'zoom-in', 5, 'Bad Id', '<x>', 'new-tab', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(await s.getPaletteRecent()).toEqual(['zoom-in', 'new-tab', 'a', 'b', 'c', 'd'].slice(0, LIMITS.PALETTE_RECENT));
  });

  it('notePaletteRecent puts an id first, once, and keeps at most PALETTE_RECENT', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await s.notePaletteRecent(id);
    expect(await s.notePaletteRecent('c')).toEqual(['c', 'g', 'f', 'e', 'd', 'b'].slice(0, LIMITS.PALETTE_RECENT));
    expect(L._data.get(KEY.PALETTE_RECENT)[0]).toBe('c');
    expect(await s.notePaletteRecent('Not valid!')).toEqual(L._data.get(KEY.PALETTE_RECENT)); // nothing written
  });
});

describe('"Recently closed" entries removed from the list', () => {
  it('closedKey: the page\'s normalized address, "w:" before it for a closed window', () => {
    expect(s.closedKey({ kind: 'tab', url: 'https://a.com/x/#top' })).toBe('https://a.com/x');
    expect(s.closedKey({ kind: 'window', url: 'https://a.com/' })).toBe('w:https://a.com/');
  });

  it('hideClosed keeps the newest time per key; with `show` it forgets them again', async () => {
    expect(await s.getClosedHidden()).toEqual({});
    await s.hideClosed({ a: NOW - 100 });
    await s.hideClosed({ a: NOW - 500, b: NOW - 200 });
    expect(await s.getClosedHidden()).toEqual({ a: NOW - 100, b: NOW - 200 });
    expect(await s.hideClosed({ a: 0 }, true)).toEqual({ b: NOW - 200 });
  });

  it('getClosedHidden validates and drops what is older than a month; at most MAX_CLOSED_HIDDEN are kept', async () => {
    L._data.set(KEY.CLOSED_HIDDEN, { old: NOW - LIMITS.CLOSED_HIDDEN_TTL_MS - 1, bad: 'x', ok: NOW - 1000 });
    expect(await s.getClosedHidden()).toEqual({ ok: NOW - 1000 });
    const many = Object.fromEntries(Array.from({ length: LIMITS.MAX_CLOSED_HIDDEN + 5 }, (_, i) => ['k' + i, NOW - i]));
    const kept = await s.hideClosed(many);
    expect(Object.keys(kept)).toHaveLength(LIMITS.MAX_CLOSED_HIDDEN);
    expect(kept.k0).toBe(NOW); // the newest stay
  });
});
