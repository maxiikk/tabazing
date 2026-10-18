// media-relay.js: passes media-hook.js's reports (a DOM event with a JSON string) to the background.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MSG, LIMITS } from '../lib/constants.js';

const SRC = readFileSync(resolve(process.cwd(), 'media-relay.js'), 'utf8');
const load = () => new Function(SRC)();
const EXT_ID = chrome.runtime.id;
const report = (detail) => document.dispatchEvent(new CustomEvent('tabazing:media', { detail }));
const sent = () => chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);
const PLAYING = JSON.stringify({ v: 2, media: true, playing: true, kind: 'video', title: 'A', artist: '', canPrev: false, canNext: false, muted: false });

function unload() {
  const r = window.__tabazingMedia;
  if (r) { document.removeEventListener('tabazing:media', r.onMedia, true); document.removeEventListener('tabazing:media-sync', r.onSync, true); }
  delete window.__tabazingMedia;
}
beforeEach(() => load());
afterEach(() => { unload(); chrome.runtime.id = EXT_ID; });

describe('media-relay.js', () => {
  it('repeats MSG.MEDIA and the size limit verbatim (it cannot import them)', () => {
    expect(SRC).toContain(`'${MSG.MEDIA}'`);
    expect(SRC).toContain(`const MAX = ${LIMITS.MEDIA_STATE_MAX};`);
  });

  it('sends each report\'s text, as is, to the background', () => {
    report(PLAYING);
    report(JSON.stringify({ v: 2, media: false }));
    expect(sent()).toEqual([{ type: MSG.MEDIA, state: PLAYING }, { type: MSG.MEDIA, state: '{"v":2,"media":false}' }]);
  });

  it('the same text twice in a row is sent once', () => {
    report(PLAYING);
    report(PLAYING);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('after a sync (the background forgot what it knew), the same text is sent again', () => {
    report(PLAYING);
    document.dispatchEvent(new CustomEvent('tabazing:media-sync'));
    report(PLAYING);
    report(PLAYING);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('drops what isn\'t a string, an empty one, and one over the limit', () => {
    report({ media: true });
    report(null);
    report('');
    report('x'.repeat(LIMITS.MEDIA_STATE_MAX + 1));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    const atLimit = (n) => JSON.stringify({ v: 2, pad: 'x'.repeat(n - '{"v":2,"pad":""}'.length) }); // valid JSON, n characters
    expect(atLimit(LIMITS.MEDIA_STATE_MAX)).toHaveLength(LIMITS.MEDIA_STATE_MAX);
    report(atLimit(LIMITS.MEDIA_STATE_MAX + 1));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    report(atLimit(LIMITS.MEDIA_STATE_MAX));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a failed send (the worker restarting) is swallowed', async () => {
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.'));
    report(PLAYING);
    await Promise.resolve();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('an orphaned copy (extension reloaded) sends nothing and unhooks itself', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    chrome.runtime.id = undefined;
    report(PLAYING);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('tabazing:media', window.__tabazingMedia.onMedia, true);
  });

  describe('idempotence', () => {
    it('a second copy is a no-op while the first is alive', () => {
      const first = window.__tabazingMedia;
      load();
      expect(window.__tabazingMedia).toBe(first);
      report(PLAYING);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('replaces an orphaned copy and removes its listener', () => {
      const old = window.__tabazingMedia;
      chrome.runtime.id = undefined;
      const remove = vi.spyOn(document, 'removeEventListener');
      load();
      expect(window.__tabazingMedia).not.toBe(old);
      expect(remove).toHaveBeenCalledWith('tabazing:media', old.onMedia, true);
      expect(remove).toHaveBeenCalledWith('tabazing:media-sync', old.onSync, true);
      chrome.runtime.id = EXT_ID;
      report(PLAYING);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('media-relay.js and media-hook.js versions', () => {
  it('drops reports from hooks older than version 2 (left in pages open from before an update), and broken JSON', () => {
    report(JSON.stringify({ media: true, playing: true, kind: 'video', title: 'old rules', artist: '', canPrev: false, canNext: false, muted: false }));
    report(JSON.stringify({ v: 1, media: false }));
    report('{not json');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    report(PLAYING);
    expect(sent()).toEqual([{ type: MSG.MEDIA, state: PLAYING }]);
  });

  it('asks the page\'s hook for everything again when it starts (after an install, update or reload)', () => {
    unload();
    const asked = vi.fn();
    document.addEventListener('tabazing:media-sync', asked);
    load();
    document.removeEventListener('tabazing:media-sync', asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });
});
