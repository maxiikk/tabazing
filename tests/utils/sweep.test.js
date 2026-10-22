import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEY, LIMITS, PREVIEW_PREFIX, previewKey } from '../../utils/constants.js';

// The screenshot itself is capture.js's business (tests/utils/capture.test.js): here we only see who gets captured.
vi.mock('../../utils/capture.js', () => ({ captureTab: vi.fn(async () => {}) }));
const { captureTab } = await import('../../utils/capture.js');
const { runSweep, cancelSweep, isSweeping, sweepJobs } = await import('../../utils/sweep.js');

const SWEEP_URL = chrome.runtime.getURL('markup/sweep.html');
let progress; // every KEY.SWEEP value written, in order

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-17T12:00:00Z') });
  captureTab.mockReset();
  progress = [];
  chrome.storage.onChanged.addListener(record);
});
afterEach(() => {
  chrome.storage.onChanged.removeListener(record);
  vi.useRealTimers();
});
function record(changes, area) { if (area === 'session' && changes[KEY.SWEEP]) progress.push(changes[KEY.SWEEP].newValue); }

// A saved preview, as savePreview leaves it: the image and its entry in the index (`url` already normalized).
async function preview(url, age) {
  const time = Date.now() - age;
  const index = (await chrome.storage.local.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX] || {};
  index[url] = { t: time, n: 10, s: time };
  await chrome.storage.local.set({ [previewKey(url)]: { img: PREVIEW_PREFIX + 'x', t: time }, [KEY.PREVIEW_INDEX]: index });
}

// One focused window: an active tab (1) and two background ones (2, 3).
function seed() {
  const testWindow = chrome._addWindow({ focused: true, left: 100, top: 50, width: 1000, height: 700 });
  const tabA = chrome._addTab({ windowId: testWindow.id, url: 'https://a.com/', active: true });
  const tabB = chrome._addTab({ windowId: testWindow.id, url: 'https://b.com/' });
  const tabC = chrome._addTab({ windowId: testWindow.id, url: 'https://c.com/' });
  return { w: testWindow, a: tabA, b: tabB, c: tabC };
}

async function sweep(options) {
  const promise = runSweep(options);
  await vi.runAllTimersAsync();
  return promise;
}

describe('sweepJobs', () => {
  it('lists awake, capturable background tabs without a recent preview', async () => {
    const { w: testWindow, b: tabB, c: tabC } = seed();
    chrome._addTab({ windowId: testWindow.id, url: 'https://d.com/', discarded: true });
    chrome._addTab({ windowId: testWindow.id, url: 'chrome://settings/' });
    chrome._addTab({ windowId: testWindow.id, url: 'https://chromewebstore.google.com/detail/x' });
    chrome._addTab({ windowId: testWindow.id, url: 'https://fresh.com/' });
    const stale = chrome._addTab({ windowId: testWindow.id, url: 'https://stale.com/' });
    await preview('https://fresh.com/', LIMITS.SWEEP_STALE_MILLISECONDS - 1000);
    await preview('https://stale.com/', LIMITS.SWEEP_STALE_MILLISECONDS + 1000);
    expect(await sweepJobs()).toEqual([
      { windowId: testWindow.id, tabId: tabB.id, url: 'https://b.com/' },
      { windowId: testWindow.id, tabId: tabC.id, url: 'https://c.com/' },
      { windowId: testWindow.id, tabId: stale.id, url: 'https://stale.com/' },
    ]);
  });

  it('reads the preview index once, not each preview', async () => {
    const { w: testWindow } = seed();
    for (let i = 0; i < 10; i++) chrome._addTab({ windowId: testWindow.id, url: `https://x.com/${i}` });
    await preview('https://x.com/3', 1000);
    chrome.storage.local.get.mockClear();
    expect((await sweepJobs()).map((j) => j.url)).not.toContain('https://x.com/3');
    expect(chrome.storage.local.get.mock.calls).toEqual([[KEY.PREVIEW_INDEX]]);
  });

  it('with `force`, does not read the previews at all', async () => {
    seed();
    await sweepJobs({ force: true });
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('skips minimized, incognito and non-normal windows', async () => {
    for (const windowOptions of [{ state: 'minimized' }, { incognito: true }, { type: 'popup' }]) {
      const testWindow = chrome._addWindow(windowOptions);
      chrome._addTab({ windowId: testWindow.id, url: 'https://x.com/' });
    }
    expect(await sweepJobs()).toEqual([]);
  });

  it('`only` limits the run; `force` takes the active tab and fresh previews too', async () => {
    const { a: tabA, b: tabB, c: tabC } = seed();
    await preview('https://b.com/', 1000);
    expect((await sweepJobs({ only: [tabA.id, tabB.id] })).map((j) => j.tabId)).toEqual([]);
    expect((await sweepJobs({ only: [tabA.id, tabB.id], force: true })).map((j) => j.tabId)).toEqual([tabA.id, tabB.id]);
    expect((await sweepJobs({ force: true })).map((j) => j.tabId)).toEqual([tabA.id, tabB.id, tabC.id]);
  });

  it(`visits at most ${LIMITS.SWEEP_MAX_TABS} tabs`, async () => {
    const testWindow = chrome._addWindow();
    for (let i = 0; i < LIMITS.SWEEP_MAX_TABS + 5; i++) chrome._addTab({ windowId: testWindow.id, url: `https://x.com/${i}` });
    expect(await sweepJobs()).toHaveLength(LIMITS.SWEEP_MAX_TABS);
  });
});

describe('runSweep', () => {
  it('visits and captures each job, reporting progress', async () => {
    const { w: testWindow, b: tabB, c: tabC } = seed();
    expect(await sweep()).toBe(2);
    expect(captureTab.mock.calls).toEqual([
      [testWindow.id, expect.objectContaining({ id: tabB.id, url: 'https://b.com/' })],
      [testWindow.id, expect.objectContaining({ id: tabC.id, url: 'https://c.com/' })],
    ]);
    const startedAt = Date.parse('2026-10-17T12:00:00Z'); // (the fake clock)
    expect(progress).toEqual([
      { running: true, done: 0, total: 2, startedAt },
      { running: true, done: 1, total: 2, startedAt },
      { running: true, done: 2, total: 2, startedAt },
      { running: false, done: 0, total: 0 },
    ]);
  });

  it('mutes each tab while it is shown and unmutes it after its capture', async () => {
    const { b: tabB, c: tabC } = seed();
    const mutedAtCapture = [];
    captureTab.mockImplementation(async (_window, tab) => { mutedAtCapture.push(chrome._data.tabs.find((entry) => entry.id === tab.id).mutedInfo.muted); });
    await sweep();
    expect(mutedAtCapture).toEqual([true, true]);
    const calls = chrome.tabs.update.mock.calls.filter(([id]) => id === tabB.id || id === tabC.id).map(([id, properties]) => [id, properties]);
    expect(calls).toEqual([
      [tabB.id, { muted: true }], [tabB.id, { active: true }], [tabB.id, { muted: false }],
      [tabC.id, { muted: true }], [tabC.id, { active: true }], [tabC.id, { muted: false }],
    ]);
    expect(chrome._data.tabs.every((tab) => !tab.mutedInfo.muted)).toBe(true);
  });

  it('leaves a tab the user muted muted', async () => {
    const { b: tabB } = seed();
    chrome._data.tabs.find((tab) => tab.id === tabB.id).mutedInfo = { muted: true };
    await sweep({ only: [tabB.id] });
    expect(chrome.tabs.update.mock.calls.filter(([, properties]) => 'muted' in properties)).toEqual([]);
    expect(chrome._data.tabs.find((tab) => tab.id === tabB.id).mutedInfo.muted).toBe(true);
  });

  it('unmutes even when the capture fails or the run is cancelled', async () => {
    const { b: tabB } = seed();
    captureTab.mockImplementationOnce(async () => { cancelSweep(); throw new Error('boom'); });
    expect(await sweep()).toBe(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabB.id, { muted: false });
    expect(chrome._data.tabs.every((tab) => !tab.mutedInfo.muted)).toBe(true);
  });

  it('captures only once the page has loaded and painted', async () => {
    const { b: tabB } = seed();
    chrome._data.tabs.find((tab) => tab.id === tabB.id).status = 'loading';
    const promise = runSweep({ only: [tabB.id] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(captureTab).not.toHaveBeenCalled();
    chrome._data.tabs.find((tab) => tab.id === tabB.id).status = 'complete';
    await vi.advanceTimersByTimeAsync(100 + LIMITS.SWEEP_PAINT_MILLISECONDS - 1);
    expect(captureTab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(captureTab).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(1);
  });

  it('gives up waiting for a slow page and captures it anyway', async () => {
    const { b: tabB } = seed();
    chrome._data.tabs.find((tab) => tab.id === tabB.id).status = 'loading';
    const promise = runSweep({ only: [tabB.id] });
    await vi.advanceTimersByTimeAsync(LIMITS.SWEEP_LOAD_MILLISECONDS - 100);
    expect(captureTab).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await promise;
    expect(captureTab).toHaveBeenCalledTimes(1);
  });

  it('skips a tab that closed or left the web meanwhile, but still counts it', async () => {
    const { b: tabB } = seed();
    chrome.tabs.get.mockImplementation(async (id) => {
      if (id === tabB.id) throw new Error('No tab');
      return { ...chrome._data.tabs.find((tab) => tab.id === id), url: 'chrome://newtab/' };
    });
    expect(await sweep()).toBe(2);
    expect(captureTab).not.toHaveBeenCalled();
  });

  it('a failing visit does not stop the run', async () => {
    const { b: tabB, c: tabC } = seed();
    captureTab.mockRejectedValueOnce(new Error('boom'));
    expect(await sweep()).toBe(2);
    expect(captureTab.mock.calls.map((x) => x[1].id)).toEqual([tabB.id, tabC.id]);
  });

  it('puts every window back on its tab, refocuses, and restores the MRU', async () => {
    const { w: testWindow, a: tabA } = seed();
    const secondWindow = chrome._addWindow();
    const x = chrome._addTab({ windowId: secondWindow.id, url: 'https://x.com/', active: true });
    chrome._addTab({ windowId: secondWindow.id, url: 'https://y.com/' });
    await chrome.storage.session.set({ [KEY.MRU]: [tabA.id, x.id] });
    captureTab.mockImplementation(() => chrome.storage.session.set({ [KEY.MRU]: [99] }));
    await sweep();
    const active = chrome._data.tabs.filter((tab) => tab.active).map((tab) => tab.id);
    expect(active).toEqual(expect.arrayContaining([tabA.id, x.id]));
    expect(chrome.windows.update).toHaveBeenLastCalledWith(testWindow.id, { focused: true });
    expect(chrome.storage.session._data.get(KEY.MRU)).toEqual([tabA.id, x.id]);
  });

  it("the MRU put back follows a tab Chrome replaced meanwhile (one card's capture too)", async () => {
    const { a: tabA, b: tabB, c: tabC } = seed();
    await chrome.storage.session.set({ [KEY.MRU]: [tabA.id, tabC.id, tabB.id] });
    captureTab.mockImplementationOnce(async () => { chrome.tabs.onReplaced._emit(99, tabC.id); });
    await sweep({ only: [tabB.id], quiet: true });
    expect(chrome.storage.session._data.get(KEY.MRU)).toEqual([tabA.id, 99, tabB.id]);
  });

  it('...and leaves out a tab closed meanwhile', async () => {
    const { a: tabA, b: tabB, c: tabC } = seed();
    await chrome.storage.session.set({ [KEY.MRU]: [tabA.id, tabC.id, tabB.id] });
    captureTab.mockImplementationOnce(() => chrome.tabs.remove(tabC.id));
    await sweep({ only: [tabB.id], quiet: true });
    expect(chrome.storage.session._data.get(KEY.MRU)).toEqual([tabA.id, tabB.id]);
    expect(chrome.tabs.onRemoved.removeListener).toHaveBeenCalled(); // the run's own listeners go with it
  });

  it('opens a progress popup centred on the focused window and closes it after', async () => {
    seed();
    await sweep();
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: SWEEP_URL, type: 'popup', width: 460, height: 250, left: 370, top: 275, focused: true });
    const popup = await chrome.windows.create.mock.results[0].value;
    expect(chrome.windows.remove).toHaveBeenCalledWith(popup.id);
  });

  it('retries the popup without a position if Chrome refuses the bounds', async () => {
    seed();
    chrome.windows.create.mockRejectedValueOnce(new Error('Invalid value for bounds'));
    await sweep();
    expect(chrome.windows.create).toHaveBeenLastCalledWith({ url: SWEEP_URL, type: 'popup', width: 460, height: 250, focused: true });
    expect(chrome.windows.remove).toHaveBeenCalled();
  });

  it('quiet: no popup', async () => {
    const { b: tabB } = seed();
    expect(await sweep({ only: [tabB.id], quiet: true })).toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('nothing to do: reports an idle state and returns 0', async () => {
    seed();
    expect(await sweep({ only: [] })).toBe(0);
    expect(progress.length).toBeGreaterThan(0); // (written twice: once on the way out, once in `finally`)
    expect(progress.every((entry) => entry.running === false && entry.total === 0)).toBe(true);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('isSweeping while it runs; a second run meanwhile is refused', async () => {
    seed();
    expect(isSweeping()).toBe(false);
    const promise = runSweep();
    expect(isSweeping()).toBe(true);
    expect(await runSweep()).toBe(0);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(2);
    expect(isSweeping()).toBe(false);
  });

  it('cancelSweep stops after the current tab and still restores everything', async () => {
    const { a: tabA } = seed();
    captureTab.mockImplementationOnce(async () => cancelSweep());
    expect(await sweep()).toBe(1);
    expect(captureTab).toHaveBeenCalledTimes(1);
    expect(chrome._data.tabs.find((tab) => tab.active).id).toBe(tabA.id);
    expect(progress.at(-1)).toEqual({ running: false, done: 0, total: 0 });
    expect(isSweeping()).toBe(false);
  });

  it('a cancel left over from an earlier run does not stop the next one', async () => {
    seed();
    cancelSweep();
    expect(await sweep()).toBe(2);
  });
});
