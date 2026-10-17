// background.js: the "use Alt+Q" nudge (Ctrl+Tab runs) and the first-run flyout.
import { describe, it, expect, vi } from 'vitest';
import { MSG, KEY, LIMITS, NUDGE } from '../lib/constants.js';
import { dayOf } from '../lib/review.js';
import { env, flush, freshWorker } from './background.shared.js';

freshWorker();
const bg = () => env.bg;
const L = () => chrome.storage.local._data;
const nudgeCalls = () => chrome.scripting.executeScript.mock.calls.filter(([o]) => o.func === bg().injectNudge);
const flyoutCalls = () => chrome.scripting.executeScript.mock.calls.filter(([o]) => o.func === bg().injectFlyout);

// A window with `n` web tabs, the first one active.
function windowOf(n = 5) {
  const w = chrome._addWindow();
  const tabs = Array.from({ length: n }, (_, i) => chrome._addTab({ windowId: w.id, url: `https://t${i}.com/`, active: i === 0 }));
  return { w, tabs };
}
// Steps through tab indexes like Ctrl+Tab would, 200 ms apart.
async function stepThrough(windowId, indexes) {
  for (const index of indexes) {
    vi.advanceTimersByTime(200);
    await bg().watchCycling({ windowId, index });
  }
}
// Everything in place for the nudge to show on this run.
const secondRunToday = () => L().set(KEY.NUDGE, { day: dayOf(Date.now()), runs: 1, shown: 0, last: 0, never: false });

describe('watchCycling', () => {
  it('counts switches to the neighbouring tab, each soon after the last', async () => {
    const { w } = windowOf();
    vi.advanceTimersByTime(NUDGE.QUIET_AFTER_EVENT_MS + 1);
    await stepThrough(w.id, [0, 1, 2]);
    expect(bg().steps.get(w.id)).toMatchObject({ index: 2, n: 2 });
    expect(bg().settleTimer).toBeNull();
    await stepThrough(w.id, [3]);
    expect(bg().steps.get(w.id).n).toBe(NUDGE.RUN_STEPS);
    expect(bg().settleTimer).not.toBeNull();
  });

  it('a jump, a slow step or the same tab start over', async () => {
    const { w } = windowOf();
    await stepThrough(w.id, [0, 1, 3]);
    expect(bg().steps.get(w.id).n).toBe(0);
    await stepThrough(w.id, [4]);
    expect(bg().steps.get(w.id).n).toBe(1);
    vi.advanceTimersByTime(NUDGE.STEP_MS);
    await bg().watchCycling({ windowId: w.id, index: 3 });
    expect(bg().steps.get(w.id).n).toBe(0);
    await stepThrough(w.id, [3]);
    expect(bg().steps.get(w.id).n).toBe(0);
  });

  it('wrapping from the last tab to the first counts as a step', async () => {
    const { w } = windowOf(4);
    await stepThrough(w.id, [2, 3, 0]);
    expect(bg().steps.get(w.id).n).toBe(2);
    await stepThrough(w.id, [3]); // and back
    expect(bg().steps.get(w.id).n).toBe(3);
  });

  it('a switch right after a tab opened or closed does not count', async () => {
    const { w, tabs } = windowOf();
    await stepThrough(w.id, [0]);
    chrome.tabs.onCreated._emit(tabs[1]);
    await stepThrough(w.id, [1]);
    expect(bg().steps.get(w.id).n).toBe(0);
  });

  it('windows are counted separately', async () => {
    const a = windowOf(), b = windowOf();
    await stepThrough(a.w.id, [0, 1]);
    await stepThrough(b.w.id, [3]);
    await stepThrough(a.w.id, [2]);
    expect(bg().steps.get(a.w.id).n).toBe(2); // b's switch in between doesn't break a's run
    expect(bg().steps.get(b.w.id).n).toBe(0);
  });

  it('once the run settles, the nudge shows on the tab the user landed on', async () => {
    const { w, tabs } = windowOf();
    secondRunToday();
    await stepThrough(w.id, [0, 1, 2, 3]);
    await stepThrough(w.id, [4]); // still switching: the wait starts again
    await vi.advanceTimersByTimeAsync(NUDGE.SETTLE_MS - 1);
    expect(nudgeCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(nudgeCalls()).toHaveLength(1);
    expect(nudgeCalls()[0][0].target).toEqual({ tabId: tabs[0].id }); // the active tab in the fake
    expect(bg().settleTimer).toBeNull();
  });

  it('activation events feed it', async () => {
    const { w, tabs } = windowOf();
    for (const t of tabs.slice(0, 4)) {
      vi.advanceTimersByTime(200);
      await chrome.tabs.onActivated._emit({ tabId: t.id, windowId: w.id })[0];
    }
    expect(bg().steps.get(w.id).n).toBe(3);
  });
});

describe('onCyclingRun', () => {
  const tab = () => ({ id: 1, active: true, url: 'https://a.com/', incognito: false });

  it('shows the nudge on the second run of the day, and counts it', async () => {
    secondRunToday();
    await bg().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(1);
    const [o] = nudgeCalls()[0];
    expect(o.target).toEqual({ tabId: 1 });
    expect(o.args).toEqual([MSG.NUDGE, NUDGE.SHOW_MS, {
      title: 'Looking for a tab?', body: 'Alt+Q shows all of them at once, with previews. Type to find one.',
      tryIt: expect.any(String), ok: expect.any(String), never: expect.any(String), close: expect.any(String),
    }, 'Alt+Q']);
    expect(L().get(KEY.NUDGE)).toMatchObject({ runs: 2, shown: 1, last: Date.now() });
  });

  it('names Option+Q on a Mac', async () => {
    secondRunToday();
    chrome.runtime.getPlatformInfo.mockResolvedValueOnce({ os: 'mac' });
    await bg().onCyclingRun(tab());
    expect(nudgeCalls()[0][0].args[3]).toBe('Option+Q');
    expect(nudgeCalls()[0][0].args[2].body).toMatch(/^Option\+Q /);
  });

  it('the first run of a day only counts', async () => {
    L().set(KEY.NUDGE, { day: '2000-1-1', runs: 5, shown: 0, last: 0 });
    await bg().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
    expect(L().get(KEY.NUDGE)).toMatchObject({ day: dayOf(Date.now()), runs: 1 });
  });

  it.each([
    ['turned off', { never: true }],
    ['shown three times already', { shown: NUDGE.MAX }],
    ['shown less than a day ago', { last: 1 }], // "1" is replaced with now - 1 h below
  ])('keeps quiet when %s', async (_, patch) => {
    secondRunToday();
    const nd = { ...L().get(KEY.NUDGE), ...patch };
    if (patch.last) nd.last = Date.now() - 3600 * 1000;
    L().set(KEY.NUDGE, nd);
    await bg().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
  });

  it('stops for good once the habit is there', async () => {
    secondRunToday();
    L().set(KEY.REVIEW, { opens: NUDGE.HABIT_OPENS });
    await bg().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
    expect(L().get(KEY.NUDGE).never).toBe(true);
  });

  it('keeps quiet soon after Tabazing was used, or while the first-run flyout still applies', async () => {
    secondRunToday();
    chrome.storage.session._data.set(KEY.LAST_OPEN, Date.now() - 60000);
    await bg().onCyclingRun(tab());
    chrome.storage.session._data.delete(KEY.LAST_OPEN);
    L().set(KEY.ONBOARD, { at: Date.now() - 60000 });
    await bg().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
  });

  it('not on hidden, incognito or non-web tabs', async () => {
    for (const t of [{ ...tab(), active: false }, { ...tab(), incognito: true }, { ...tab(), url: 'chrome://newtab/' }]) {
      secondRunToday();
      await bg().onCyclingRun(t);
    }
    expect(nudgeCalls()).toHaveLength(0);
  });

  it('a page that refuses the script is not counted as shown', async () => {
    secondRunToday();
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('no'));
    await expect(bg().onCyclingRun(tab())).rejects.toThrow('no');
    expect(L().get(KEY.NUDGE).shown).toBe(0);
  });
});

describe('offerFlyout', () => {
  const tab = (p) => ({ id: 3, url: 'https://a.com/', incognito: false, ...p });
  const fresh = () => L().set(KEY.ONBOARD, { at: Date.now(), flyout: false, tour: false });

  it('right after install, shows the flyout on a web page', async () => {
    fresh();
    await bg().offerFlyout(tab());
    expect(flyoutCalls()).toHaveLength(1);
    expect(flyoutCalls()[0][0]).toEqual({
      target: { tabId: 3 }, func: bg().injectFlyout,
      args: [MSG.FLYOUT_DONE, LIMITS.FLYOUT_SHOW_MS, { title: expect.any(String), body: 'Press $KEY$ to see all your tabs.', sub: expect.any(String), close: expect.any(String) }],
    });
  });

  it('not on pages it cannot reach', async () => {
    fresh();
    for (const t of [null, tab({ url: 'chrome://extensions/' }), tab({ incognito: true }), tab({ url: undefined })]) await bg().offerFlyout(t);
    expect(flyoutCalls()).toHaveLength(0);
  });

  it('not before install was recorded, nor once dismissed or the tour seen', async () => {
    await bg().offerFlyout(tab());
    L().set(KEY.ONBOARD, { at: Date.now(), flyout: true });
    await bg().offerFlyout(tab());
    L().set(KEY.ONBOARD, { at: Date.now(), tour: true });
    await bg().offerFlyout(tab());
    expect(flyoutCalls()).toHaveLength(0);
  });

  it('once the offer is over it stops looking (flyoutOver)', async () => {
    L().set(KEY.ONBOARD, { at: Date.now() - LIMITS.FLYOUT_WINDOW_MS - 1 });
    await bg().offerFlyout(tab());
    expect(bg().flyoutOver).toBe(true);
    fresh();
    chrome.storage.local.get.mockClear();
    await bg().offerFlyout(tab());
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(flyoutCalls()).toHaveLength(0);
  });

  it('a page that refuses the script is swallowed', async () => {
    fresh();
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('no'));
    await expect(bg().offerFlyout(tab())).resolves.toBeUndefined();
  });
});
