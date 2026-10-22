// background.js: the "use Alt+Q" nudge (Ctrl+Tab runs) and the first-run flyout.
import { describe, it, expect, vi } from 'vitest';
import { MESSAGE, KEY, LIMITS, NUDGE } from '../utils/constants.js';
import { dayOf } from '../utils/review.js';
import { environment, flush, freshWorker } from './helpers/background.js';

freshWorker();
const background = () => environment.background;
const localData = () => chrome.storage.local._data;
const nudgeCalls = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.func === background().injectNudge);
const flyoutCalls = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.func === background().injectFlyout);

// A window with `n` web tabs, the first one active.
function windowOf(count = 5) {
  const chromeWindow = chrome._addWindow();
  const tabs = Array.from({ length: count }, (unused, i) => chrome._addTab({ windowId: chromeWindow.id, url: `https://t${i}.com/`, active: i === 0 }));
  return { w: chromeWindow, tabs };
}
// Steps through tab indexes like Ctrl+Tab would, 200 ms apart.
async function stepThrough(windowId, indexes) {
  for (const index of indexes) {
    vi.advanceTimersByTime(200);
    await background().watchCycling({ windowId, index });
  }
}
// Everything in place for the nudge to show on this run.
const secondRunToday = () => localData().set(KEY.NUDGE, { day: dayOf(Date.now()), runs: 1, shown: 0, last: 0, never: false });

describe('watchCycling', () => {
  it('counts switches to the neighbouring tab, each soon after the last', async () => {
    const { w: chromeWindow } = windowOf();
    vi.advanceTimersByTime(NUDGE.QUIET_AFTER_EVENT_MILLISECONDS + 1);
    await stepThrough(chromeWindow.id, [0, 1, 2]);
    expect(background().steps.get(chromeWindow.id)).toMatchObject({ index: 2, n: 2 });
    expect(background().settleTimer).toBeNull();
    await stepThrough(chromeWindow.id, [3]);
    expect(background().steps.get(chromeWindow.id).n).toBe(NUDGE.RUN_STEPS);
    expect(background().settleTimer).not.toBeNull();
  });

  it('a jump, a slow step or the same tab start over', async () => {
    const { w: chromeWindow } = windowOf();
    await stepThrough(chromeWindow.id, [0, 1, 3]);
    expect(background().steps.get(chromeWindow.id).n).toBe(0);
    await stepThrough(chromeWindow.id, [4]);
    expect(background().steps.get(chromeWindow.id).n).toBe(1);
    vi.advanceTimersByTime(NUDGE.STEP_MILLISECONDS);
    await background().watchCycling({ windowId: chromeWindow.id, index: 3 });
    expect(background().steps.get(chromeWindow.id).n).toBe(0);
    await stepThrough(chromeWindow.id, [3]);
    expect(background().steps.get(chromeWindow.id).n).toBe(0);
  });

  it('wrapping from the last tab to the first counts as a step', async () => {
    const { w: chromeWindow } = windowOf(4);
    await stepThrough(chromeWindow.id, [2, 3, 0]);
    expect(background().steps.get(chromeWindow.id).n).toBe(2);
    await stepThrough(chromeWindow.id, [3]); // and back
    expect(background().steps.get(chromeWindow.id).n).toBe(3);
  });

  it('a switch right after a tab opened or closed does not count', async () => {
    const { w: chromeWindow, tabs } = windowOf();
    await stepThrough(chromeWindow.id, [0]);
    chrome.tabs.onCreated._emit(tabs[1]);
    await stepThrough(chromeWindow.id, [1]);
    expect(background().steps.get(chromeWindow.id).n).toBe(0);
  });

  it('windows are counted separately', async () => {
    const firstWindow = windowOf(), secondWindow = windowOf();
    await stepThrough(firstWindow.w.id, [0, 1]);
    await stepThrough(secondWindow.w.id, [3]);
    await stepThrough(firstWindow.w.id, [2]);
    expect(background().steps.get(firstWindow.w.id).n).toBe(2); // b's switch in between doesn't break a's run
    expect(background().steps.get(secondWindow.w.id).n).toBe(0);
  });

  it('once the run settles, the nudge shows on the tab the user landed on', async () => {
    const { w: chromeWindow, tabs } = windowOf();
    secondRunToday();
    await stepThrough(chromeWindow.id, [0, 1, 2, 3]);
    await stepThrough(chromeWindow.id, [4]); // still switching: the wait starts again
    await vi.advanceTimersByTimeAsync(NUDGE.SETTLE_MILLISECONDS - 1);
    expect(nudgeCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(nudgeCalls()).toHaveLength(1);
    expect(nudgeCalls()[0][0].target).toEqual({ tabId: tabs[0].id }); // the active tab in the fake
    expect(background().settleTimer).toBeNull();
  });

  it('activation events feed it', async () => {
    const { w: chromeWindow, tabs } = windowOf();
    for (const tab of tabs.slice(0, 4)) {
      vi.advanceTimersByTime(200);
      await chrome.tabs.onActivated._emit({ tabId: tab.id, windowId: chromeWindow.id })[0];
    }
    expect(background().steps.get(chromeWindow.id).n).toBe(3);
  });
});

describe('onCyclingRun', () => {
  const tab = () => ({ id: 1, active: true, url: 'https://a.com/', incognito: false });

  it('shows the nudge on the second run of the day, and counts it', async () => {
    secondRunToday();
    await background().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(1);
    const [options] = nudgeCalls()[0];
    expect(options.target).toEqual({ tabId: 1 });
    expect(options.args).toEqual([MESSAGE.NUDGE, NUDGE.SHOW_MILLISECONDS, {
      title: 'Looking for a tab?', body: 'Press Alt+Q and keep holding Alt: all your tabs, with previews. Let go of Alt to switch.',
      tryIt: expect.any(String), ok: expect.any(String), never: expect.any(String), close: expect.any(String),
    }, 'Alt+Q']);
    expect(localData().get(KEY.NUDGE)).toMatchObject({ runs: 2, shown: 1, last: Date.now() });
  });

  it('names Option+Q on a Mac', async () => {
    secondRunToday();
    chrome.runtime.getPlatformInfo.mockResolvedValueOnce({ os: 'mac' });
    await background().onCyclingRun(tab());
    expect(nudgeCalls()[0][0].args[3]).toBe('Option+Q');
    expect(nudgeCalls()[0][0].args[2].body).toMatch(/^Press Option\+Q /);
  });

  it('the first run of a day only counts', async () => {
    localData().set(KEY.NUDGE, { day: '2000-1-1', runs: 5, shown: 0, last: 0 });
    await background().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
    expect(localData().get(KEY.NUDGE)).toMatchObject({ day: dayOf(Date.now()), runs: 1 });
  });

  it.each([
    ['turned off', { never: true }],
    ['shown three times already', { shown: NUDGE.MAX }],
    ['shown less than a day ago', { last: 1 }], // "1" is replaced with now - 1 h below
  ])('keeps quiet when %s', async (unused, patch) => {
    secondRunToday();
    const nudge = { ...localData().get(KEY.NUDGE), ...patch };
    if (patch.last) nudge.last = Date.now() - 3600 * 1000;
    localData().set(KEY.NUDGE, nudge);
    await background().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
  });

  it('stops for good once the habit is there', async () => {
    secondRunToday();
    localData().set(KEY.REVIEW, { opens: NUDGE.HABIT_OPENS });
    await background().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
    expect(localData().get(KEY.NUDGE).never).toBe(true);
  });

  it('keeps quiet soon after Tabazing was used, or while the first-run flyout still applies', async () => {
    secondRunToday();
    chrome.storage.session._data.set(KEY.LAST_OPEN, Date.now() - 60000);
    await background().onCyclingRun(tab());
    chrome.storage.session._data.delete(KEY.LAST_OPEN);
    localData().set(KEY.ONBOARD, { at: Date.now() - 60000 });
    await background().onCyclingRun(tab());
    expect(nudgeCalls()).toHaveLength(0);
  });

  it('not on hidden, incognito or non-web tabs', async () => {
    for (const testTab of [{ ...tab(), active: false }, { ...tab(), incognito: true }, { ...tab(), url: 'chrome://newtab/' }]) {
      secondRunToday();
      await background().onCyclingRun(testTab);
    }
    expect(nudgeCalls()).toHaveLength(0);
  });

  it('a page that refuses the script is not counted as shown', async () => {
    secondRunToday();
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('no'));
    await expect(background().onCyclingRun(tab())).rejects.toThrow('no');
    expect(localData().get(KEY.NUDGE).shown).toBe(0);
  });
});

describe('offerFlyout', () => {
  const tab = (overrides) => ({ id: 3, url: 'https://a.com/', incognito: false, ...overrides });
  const fresh = () => localData().set(KEY.ONBOARD, { at: Date.now(), flyout: false, tour: false });

  it('right after install, shows the flyout on a web page', async () => {
    fresh();
    await background().offerFlyout(tab());
    expect(flyoutCalls()).toHaveLength(1);
    expect(flyoutCalls()[0][0]).toEqual({
      target: { tabId: 3 }, func: background().injectFlyout,
      args: [MESSAGE.FLYOUT_DONE, LIMITS.FLYOUT_SHOW_MILLISECONDS, { title: expect.any(String), body: 'Press $KEY$ and keep holding Alt to see your tabs; let go to switch.', subtitle: expect.any(String), close: expect.any(String) }],
    });
  });

  it('not on pages it cannot reach', async () => {
    fresh();
    for (const testTab of [null, tab({ url: 'chrome://extensions/' }), tab({ incognito: true }), tab({ url: undefined })]) await background().offerFlyout(testTab);
    expect(flyoutCalls()).toHaveLength(0);
  });

  it('not before install was recorded, nor once dismissed or the tour seen', async () => {
    await background().offerFlyout(tab());
    localData().set(KEY.ONBOARD, { at: Date.now(), flyout: true });
    await background().offerFlyout(tab());
    localData().set(KEY.ONBOARD, { at: Date.now(), tour: true });
    await background().offerFlyout(tab());
    expect(flyoutCalls()).toHaveLength(0);
  });

  it('once the offer is over it stops looking (flyoutOver)', async () => {
    localData().set(KEY.ONBOARD, { at: Date.now() - LIMITS.FLYOUT_WINDOW_MILLISECONDS - 1 });
    await background().offerFlyout(tab());
    expect(background().flyoutOver).toBe(true);
    fresh();
    chrome.storage.local.get.mockClear();
    await background().offerFlyout(tab());
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(flyoutCalls()).toHaveLength(0);
  });

  it('a page that refuses the script is swallowed', async () => {
    fresh();
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('no'));
    await expect(background().offerFlyout(tab())).resolves.toBeUndefined();
  });
});
