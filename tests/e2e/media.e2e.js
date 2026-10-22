// Media detection end to end: media-hook.js -> media-relay.js -> background.js -> storage.session 'media',
// in headless Chrome for Testing with the unpacked extension. The pages make their media themselves
// (page-media.js: WAV tones; webm recordings made once in beforeAll and served over http).
// Each test opens its own page(s) at a URL of its own (the tab is found by it) and closes them after.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startServers, launch, sleep, QUIET_MILLISECONDS } from './helpers/harness.js';

let server, browser, extension;
let pageCounter = 0;
const pages = [];

// A test page (a tab of its own) at a fresh URL on the main origin, in front.
async function open(name = 'page', origin) {
  const page = await browser.newPage();
  pages.push(page);
  await page.goto(`${origin || server.main}/p/${name}?n=${++pageCounter}`);
  return page;
}
const poll = (check, timeout = 6000) => expect.poll(check, { timeout, interval: 100 });
// Nothing stored for the page's tab, after waiting long enough for a report to have arrived.
async function expectNothing(page) {
  await sleep(QUIET_MILLISECONDS);
  expect(await extension.framesOf(page)).toBeUndefined();
}

// In-page snippets (run with page.evaluate): an element in the body, kept as window.el.
const addAudio = (seconds, options = {}) => {
  const audio = document.createElement('audio');
  audio.src = window.E2E.wav(seconds);
  Object.assign(audio, options);
  document.body.append(audio);
  window.el = audio;
};
const addVideo = (source, options = {}) => {
  const video = document.createElement('video');
  Object.assign(video, options);
  video.src = source === 'wav' ? window.E2E.wav(8) : source;
  document.body.append(video);
  window.el = video;
};
const play = () => window.el.play().then(() => true);
const pause = () => window.el.pause();

beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
  // Two 6 s webm recordings, made at once: a picture with sound, and a picture without (no audio track).
  const page = await browser.newPage();
  await page.goto(`${server.main}/p/recorder`);
  const [sound, silent] = await Promise.all([
    page.evaluate(() => window.E2E.record(6, { sound: true })),
    page.evaluate(() => window.E2E.record(6, { sound: false })),
  ]);
  server.serve('/video-sound.webm', Buffer.from(sound, 'base64'), 'video/webm');
  server.serve('/video-silent.webm', Buffer.from(silent, 'base64'), 'video/webm');
  await page.close();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
afterEach(async () => {
  for (const openPage of pages.splice(0)) await openPage.close().catch(() => {});
});

describe('joining: only media that plays with sound', () => {
  it('1. an <audio> joins when it plays, and stays paused and ended', async () => {
    const page = await open('audio');
    await page.evaluate(addAudio, 8);
    await expectNothing(page); // loaded, never played
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'audio', title: 'audio', muted: false });
    await page.evaluate(pause);
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: false });
    await page.evaluate(() => { window.el.currentTime = 7.6; return window.el.play(); });
    await page.waitForFunction(() => window.el.ended, { timeout: 5000 });
    await sleep(400);
    expect(await extension.topOf(page)).toMatchObject({ media: true, playing: false });
  });

  it('2. a muted autoplay <video> with sound is left out until it is unmuted', async () => {
    const page = await open('muted');
    await page.evaluate(addVideo, '/video-sound.webm', { muted: true, autoplay: true, loop: true });
    await page.waitForFunction(() => !window.el.paused && window.el.currentTime > 0.3);
    await expectNothing(page);
    await page.evaluate(() => { window.el.muted = false; });
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'video', muted: false });
    // ...and muted again it stays (muted).
    await page.evaluate(() => { window.el.muted = true; });
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, muted: true });
  });

  it('3. playing at volume 0 is left out', async () => {
    const page = await open('volume0');
    await page.evaluate(addAudio, 8, { volume: 0 });
    await page.evaluate(play);
    await expectNothing(page);
    await page.evaluate(() => { window.el.volume = 0.5; }); // turned up: it joins
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true });
  });

  it('3b. the page\'s own player joins muted (it names what it plays, and it is big); a small muted one doesn\'t', async () => {
    const small = await open('preview');
    await small.evaluate(() => { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Preview' }); });
    await small.evaluate(addVideo, '/video-sound.webm', { muted: true, autoplay: true, loop: true, width: 320, height: 180 });
    await expectNothing(small);
    const page = await open('mutedplayer');
    await page.evaluate(() => { navigator.mediaSession.metadata = new MediaMetadata({ title: 'A video', artist: 'A channel' }); });
    await page.evaluate(addVideo, '/video-sound.webm', { muted: true, autoplay: true, loop: true, width: 960, height: 540 });
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'video', title: 'A video', muted: true });
  });

  it('4. a sound shorter than 5 s is transient; 5 s and more joins', async () => {
    const page = await open('short');
    await page.evaluate(addAudio, 3);
    await page.evaluate(play);
    await page.waitForFunction(() => window.el.ended, { timeout: 6000 });
    await expectNothing(page);
    await page.evaluate(addAudio, 5);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'audio' });
  });

  it('5. a <video> with a picture and no audio track is left out', async () => {
    const page = await open('silentvideo');
    await page.evaluate(addVideo, '/video-silent.webm');
    await page.evaluate(play);
    await page.waitForFunction(() => window.el.currentTime > 1);
    // Chrome's decoded-audio counter is what tells: it stays 0 for a video without sound.
    expect(await page.evaluate(() => ({ bytes: window.el.webkitAudioDecodedByteCount, w: window.el.videoWidth, d: window.el.duration })))
      .toMatchObject({ bytes: 0, w: 160 });
    await expectNothing(page);
  });

  it('6. a <video> with picture and sound is "video"; a <video> of a WAV (no picture) is "audio"', async () => {
    const page = await open('video');
    await page.evaluate(addVideo, '/video-sound.webm');
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'video' });
    expect(await page.evaluate(() => window.el.duration)).toBeGreaterThanOrEqual(5);

    const radio = await open('radio');
    await radio.evaluate(addVideo, 'wav');
    await radio.evaluate(play);
    await poll(() => extension.topOf(radio)).toMatchObject({ media: true, playing: true, kind: 'audio' });
  });

  it('13. an <audio autoplay> in a closed shadow root (no play() call) joins', async () => {
    const page = await open('shadow');
    await page.evaluate(() => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = host.attachShadow({ mode: 'closed' });
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.src = window.E2E.wav(8);
      root.append(audio);
    });
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'audio' });
  });

  it('14. new Audio() never put in the page joins when played, and stays once dropped', async () => {
    const page = await open('detached');
    await page.evaluate(() => { window.el = new Audio(window.E2E.wav(8)); return window.el.play(); });
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: true, kind: 'audio' });
    await page.evaluate(() => { window.el.pause(); window.el = null; window.gc(); });
    await sleep(QUIET_MILLISECONDS);
    // The hook still holds it (it was never in the page, so it can't be "taken out"): listed, paused.
    expect(await extension.topOf(page)).toMatchObject({ media: true, playing: false });
  });

  it('15. a MediaStream source (a call) is left out', async () => {
    const page = await open('stream');
    await page.evaluate(() => {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const audio = document.createElement('audio');
      audio.srcObject = destination.stream;
      document.body.append(audio);
      window.el = audio;
      return audio.play();
    });
    await page.waitForFunction(() => !window.el.paused);
    await expectNothing(page);
  });

  it('a MediaRecorder webm played from its blob: URL (duration unknown) joins as live', async () => {
    // Chrome reports Infinity for a recording played straight from its blob (no duration in its header);
    // the hook counts Infinity as live (not transient), as Chrome does, even for a 2 s clip.
    const page = await open('blobwebm');
    const duration = await page.evaluate(async () => {
      const base64 = await window.E2E.record(2, { sound: true });
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const video = document.createElement('video');
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      document.body.append(video);
      window.el = video;
      await video.play();
      return video.duration;
    });
    if (duration === Infinity) await poll(() => extension.topOf(page)).toMatchObject({ media: true, kind: 'video' });
    else { expect(duration).toBeLessThan(5); await expectNothing(page); } // Chrome knew the duration: transient
  });
});

describe('what is reported', () => {
  it('7. Media Session metadata and handlers; the hook runs the page\'s nexttrack handler', async () => {
    const page = await open('session');
    await page.evaluate(() => {
      window.calls = [];
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Song One', artist: 'The Band' });
      navigator.mediaSession.setActionHandler('nexttrack', (details) => window.calls.push(details.action));
    });
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true, title: 'Song One', artist: 'The Band', canPrevious: false, canNext: true });
    // After it plays: a previous-track handler, new metadata.
    await page.evaluate(() => {
      navigator.mediaSession.setActionHandler('previoustrack', (details) => window.calls.push(details.action));
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Song Two', artist: 'Other' });
    });
    await poll(() => extension.topOf(page)).toMatchObject({ title: 'Song Two', artist: 'Other', canPrevious: true, canNext: true });
    // The switcher's "next" (utils/media.js: pageMediaAction), from the extension side.
    const result = await extension.inMain(page, () => window[Symbol.for('tabazing.media')]('nexttrack'));
    expect(result).toBe(true);
    expect(await page.evaluate(() => window.calls)).toEqual(['nexttrack']);
    // A handler taken away: canNext goes.
    await page.evaluate(() => navigator.mediaSession.setActionHandler('nexttrack', null));
    await poll(() => extension.topOf(page)).toMatchObject({ canNext: false, canPrevious: true });
  });

  it('the switcher\'s play / pause (utils/media.js mediaAction) reach the element', async () => {
    const page = await open('buttons');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    const tabId = await extension.tabId(page);
    const switcher = await extension.extensionPage();
    pages.push(switcher);
    // A string, so vitest leaves the page's import() alone.
    const performAction = (action) => switcher.evaluate(`import('/utils/media.js').then((m) => m.mediaAction(${tabId}, 0, '${action}'))`);
    expect(await performAction('pause')).toBe(true);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: false });
    expect(await page.evaluate(() => window.el.paused)).toBe(true);
    expect(await performAction('play')).toBe(true);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    // ...and the player's list (utils/media.js loadMedia) has the tab.
    const list = await switcher.evaluate("import('/utils/media.js').then((m) => m.loadMedia()).then((l) => l.map((e) => ({ tabId: e.tabId, playing: e.playing, kind: e.kind })))");
    expect(list).toContainEqual({ tabId, playing: true, kind: 'audio' });
  });

  it('8. Media Session playbackState overrides the element', async () => {
    const page = await open('pbstate');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    await page.evaluate(() => { navigator.mediaSession.playbackState = 'paused'; });
    await poll(() => extension.topOf(page)).toMatchObject({ playing: false });
    expect(await page.evaluate(() => window.el.paused)).toBe(false);
    await page.evaluate(() => { navigator.mediaSession.playbackState = 'none'; }); // back to the element's own state
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
  });
});

describe('leaving', () => {
  it('9a. taken out of the page: the tab\'s entry goes', async () => {
    const page = await open('removed');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    await page.evaluate(() => window.el.remove());
    await poll(() => extension.framesOf(page)).toBeUndefined();
  });

  it('9b. moved to another parent (paused, and playing): still listed', async () => {
    const page = await open('moved');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    await page.evaluate(pause);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: false });
    await page.evaluate(() => { const section = document.createElement('section'); document.body.append(section); section.append(window.el); });
    await sleep(QUIET_MILLISECONDS);
    expect(await extension.topOf(page)).toMatchObject({ media: true, playing: false });
    // Moved while playing (a mini player): Chrome pauses it only if it stays out; it is back at once.
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    await page.evaluate(() => { const aside = document.createElement('aside'); document.body.append(aside); aside.append(window.el); });
    await sleep(QUIET_MILLISECONDS);
    expect(await extension.topOf(page)).toMatchObject({ media: true, playing: true });
  });

  it('10. its source unloaded after playing (YouTube\'s stop): still listed, paused', async () => {
    const page = await open('unloaded');
    await page.evaluate(addVideo, '/video-sound.webm');
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true, kind: 'video' });
    await page.evaluate(() => { window.el.removeAttribute('src'); window.el.load(); });
    await poll(() => extension.topOf(page)).toMatchObject({ media: true, playing: false });
    await sleep(QUIET_MILLISECONDS);
    expect(await extension.topOf(page)).toMatchObject({ media: true, playing: false });
  });

  it('16a. the tab goes to another page: the entry goes', async () => {
    const page = await open('navaway');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    const tabId = await extension.tabId(page);
    await page.goto(`${server.main}/p/elsewhere?n=${++pageCounter}`);
    await poll(() => extension.framesOf(page, tabId)).toBeUndefined();
    await sleep(QUIET_MILLISECONDS);
    expect(await extension.framesOf(page, tabId)).toBeUndefined();
  });

  it('16b. the page changes its own address (history.pushState) while playing: still listed', async () => {
    const page = await open('spa');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    const tabId = await extension.tabId(page);
    await page.evaluate(() => history.pushState({}, '', '/p/spa-next'));
    await sleep(QUIET_MILLISECONDS);
    await poll(() => extension.framesOf(page, tabId)).toMatchObject({ 0: { media: true, playing: true } });
  });

  it('back from the back/forward cache: listed again (paused)', async (testContext) => {
    const page = await open('bfcache');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    const tabId = await extension.tabId(page);
    await page.goto(`${server.main}/p/next?n=${++pageCounter}`);
    await poll(() => extension.framesOf(page, tabId)).toBeUndefined();
    await page.goBack();
    const restored = await page.evaluate(() => performance.getEntriesByType('navigation')[0].type === 'back_forward' && !!window.el);
    if (!restored) testContext.skip(); // not kept in the back/forward cache (Chrome decides): a fresh page, nothing to test
    await poll(() => extension.framesOf(page, tabId)).toMatchObject({ 0: { media: true, playing: false } });
  });

  it('18. a background tab with paused media is discarded: the entry goes', async () => {
    const page = await open('discard');
    await page.evaluate(addAudio, 8);
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    await page.evaluate(pause);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: false });
    const tabId = await extension.tabId(page);
    await open('front'); // the media tab is in the background now
    const after = await extension.run((id) => chrome.tabs.discard(id).then((discardedTab) => discardedTab && discardedTab.id), tabId);
    expect(Number.isInteger(after)).toBe(true);
    await poll(() => extension.run((tabIds) => chrome.storage.session.get('media').then((result) => tabIds.filter((i) => (result.media || {})[i])), [tabId, after])).toEqual([]);
  });
});

describe('tabs and frames', () => {
  it('11. two tabs: A paused, B playing, both listed', async () => {
    const tabA = await open('tabA');
    await tabA.evaluate(addAudio, 8);
    await tabA.evaluate(play);
    await poll(() => extension.topOf(tabA)).toMatchObject({ playing: true });
    const tabB = await open('tabB');
    await tabB.evaluate(addAudio, 8);
    await tabB.evaluate(play);
    await poll(() => extension.topOf(tabB)).toMatchObject({ playing: true });
    await tabA.evaluate(pause);
    await poll(() => extension.topOf(tabA)).toMatchObject({ playing: false });
    expect(await extension.topOf(tabB)).toMatchObject({ playing: true });
  });

  for (const [label, cross] of [['same-origin', false], ['cross-site', true]]) {
    it(`12. a ${label} iframe's media is stored under its frameId; removed, it goes (after the switcher's check)`, async () => {
      const page = await open(`host-${cross ? 'x' : 's'}`);
      const frameUrl = `${cross ? server.cross : server.main}/frame/player-${pageCounter}`;
      await page.evaluate((url) => new Promise((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.src = url; iframe.allow = 'autoplay'; iframe.onload = resolve;
        document.body.append(iframe);
      }), frameUrl);
      const frame = page.frames().find((candidateFrame) => candidateFrame.url() === frameUrl);
      await frame.evaluate(addAudio, 8);
      await frame.evaluate(play);
      const frameId = (await extension.frames(page)).find((entry) => entry.url === frameUrl).frameId;
      expect(frameId).toBeGreaterThan(0);
      await poll(() => extension.framesOf(page)).toEqual({ [frameId]: expect.objectContaining({ media: true, playing: true, kind: 'audio' }) });
      await page.evaluate(() => document.querySelector('iframe').remove());
      await sleep(400);
      // The frame's own "nothing" (pagehide) may or may not get out before it goes; the switcher's check
      // (MESSAGE.MEDIA_CHECK, which it sends as it opens) asks the tab's frames that are left.
      const switcher = await extension.extensionPage();
      pages.push(switcher);
      await switcher.evaluate(() => chrome.runtime.sendMessage({ type: 'tabazing:media-check' }));
      await poll(() => extension.framesOf(page)).toBeUndefined();
    });
  }

  it('an about:srcdoc iframe (match_about_blank) reports under its own frameId', async () => {
    const page = await open('srcdoc');
    await page.evaluate(() => new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.srcdoc = '<!doctype html><title>inner</title><body></body>';
      iframe.onload = resolve;
      document.body.append(iframe);
    }));
    await page.evaluate(() => {
      const iframeDocument = document.querySelector('iframe').contentDocument;
      const audio = iframeDocument.createElement('audio');
      audio.src = window.E2E.wav(8);
      iframeDocument.body.append(audio);
      return audio.play();
    });
    const frameId = (await extension.frames(page)).find((entry) => entry.url === 'about:srcdoc').frameId;
    await poll(() => extension.framesOf(page)).toEqual({ [frameId]: expect.objectContaining({ media: true, playing: true }) });
  });
});

describe('the extension restarting', () => {
  it('17. reloaded while a tab plays: the page says again what it plays', async () => {
    const page = await open('reload');
    await page.evaluate(addAudio, 8, { loop: true });
    await page.evaluate(play);
    await poll(() => extension.topOf(page)).toMatchObject({ playing: true });
    // A new worker starts (storage.session is cleared with the old one); onInstalled (update) puts
    // media-relay.js into the open tabs, and the new relay's start asks the page's media-hook.js for everything again.
    await extension.reload();
    await poll(() => extension.topOf(page), 10000).toMatchObject({ media: true, playing: true });
  });
});
