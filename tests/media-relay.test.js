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
const PLAYING = JSON.stringify({ media: true, playing: true, kind: 'video', title: 'A', artist: '', canPrev: false, canNext: false, muted: false });

function unload() {
  const r = window.__tabazingMedia;
  if (r) document.removeEventListener('tabazing:media', r.onMedia, true);
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
    report(JSON.stringify({ media: false }));
    expect(sent()).toEqual([{ type: MSG.MEDIA, state: PLAYING }, { type: MSG.MEDIA, state: '{"media":false}' }]);
  });

  it('the same text twice in a row is sent once', () => {
    report(PLAYING);
    report(PLAYING);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('drops what isn\'t a string, an empty one, and one over the limit', () => {
    report({ media: true });
    report(null);
    report('');
    report('x'.repeat(LIMITS.MEDIA_STATE_MAX + 1));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    report('x'.repeat(LIMITS.MEDIA_STATE_MAX));
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
      chrome.runtime.id = EXT_ID;
      report(PLAYING);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
