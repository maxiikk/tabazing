// background.js: the switcher framed in a page in Firefox (utils/api-bridge.js) asks through its port. Only the switcher's
// page may open one; the worker makes only the calls on the list, runs only the page functions it knows, and asks the
// framed switchers what a switcher in a window hears as a message (MESSAGE.CYCLE: "are you open?").
import { describe, it, expect, vi } from 'vitest';
import { MESSAGE } from '../utils/constants.js';
import { BRIDGE_PORT } from '../utils/api-bridge.js';
import { pageMediaAction } from '../utils/media.js';
import { environment, flush, freshWorker, seed } from './helpers/background.js';

freshWorker();
const background = () => environment.background;
// A port as the framed switcher's chrome.runtime.connect gives the worker one: what the worker posts is kept.
function connect(url = background().SWITCHER_URL + '?standby=1') {
  const messageListeners = [], disconnectListeners = [];
  const port = {
    name: BRIDGE_PORT, sender: { id: chrome.runtime.id, url, tab: { id: 1 } }, posted: [],
    postMessage: vi.fn((message) => port.posted.push(message)), disconnect: vi.fn(),
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    send: (message) => messageListeners.forEach((listener) => listener(message)),
    close: () => disconnectListeners.forEach((listener) => listener()),
  };
  chrome.runtime.onConnect._emit(port);
  return port;
}

describe('callBridged', () => {
  it('makes a call on the list, with its arguments', async () => {
    seed('https://a.example/');
    const tabs = await background().callBridged('tabs.query', [{ active: true }]);
    expect(tabs.map((tab) => tab.url)).toEqual(['https://a.example/']);
    await background().callBridged('storage.session.set', [{ x: 1 }]);
    expect((await chrome.storage.session.get('x')).x).toBe(1);
  });

  it('refuses anything else (a namespace or a method not on the list, arguments that aren’t a list)', async () => {
    await expect(background().callBridged('management.uninstallSelf', [])).rejects.toThrow('not allowed');
    await expect(background().callBridged('tabs.executeScript', [])).rejects.toThrow('not allowed');
    await expect(background().callBridged('storage.local.clear', [])).rejects.toThrow('not allowed');
    await expect(background().callBridged('tabs.query', 'x')).rejects.toThrow('not allowed');
  });

  it('runs in pages only the functions it knows, by name', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    await background().callBridged('scripting.executeScript', [{ target: { tabId: 4 }, world: 'MAIN', func: 'pageMediaAction', args: ['pause'] }]);
    const [options] = chrome.scripting.executeScript.mock.calls[0];
    expect(options).toMatchObject({ target: { tabId: 4 }, world: 'MAIN', args: ['pause'] });
    expect(options.func.name).toBe(pageMediaAction.name); // (the worker's own copy of utils/media.js pageMediaAction)
    await expect(background().callBridged('scripting.executeScript', [{ target: { tabId: 4 }, func: 'alert' }])).rejects.toThrow('not allowed');
  });
});

describe('the port', () => {
  it('only the switcher’s page may open one: a page’s (or another extension page’s) is shut', () => {
    const page = connect('https://evil.example/');
    expect(page.disconnect).toHaveBeenCalled();
    const sweep = connect(chrome.runtime.getURL('markup/sweep.html'));
    expect(sweep.disconnect).toHaveBeenCalled();
    expect(background().bridgePorts.size).toBe(0);
    const switcher = connect();
    expect(switcher.disconnect).not.toHaveBeenCalled();
    expect(background().bridgePorts.size).toBe(1);
    switcher.close();
    expect(background().bridgePorts.size).toBe(0);
  });

  it('a call through it is answered with the same id: its result, or its error', async () => {
    seed('https://a.example/');
    const port = connect();
    port.send({ id: 3, call: 'tabs.query', args: [{}] });
    port.send({ id: 4, call: 'tabs.get', args: [999] });
    port.send({ id: 5, call: 'downloads.download', args: [{ url: 'https://x' }] });
    await flush();
    expect(port.posted.find((message) => message.id === 3).result.map((tab) => tab.url)).toEqual(['https://a.example/']);
    expect(port.posted.find((message) => message.id === 4).error).toMatch(/999/);
    expect(port.posted.find((message) => message.id === 5).error).toMatch('not allowed');
  });

  it('a press while a framed switcher is open is answered by it: the worker opens no other', async () => {
    const { tab } = seed();
    const port = connect();
    port.postMessage.mockImplementation((message) => { port.posted.push(message); if (message.question) port.send({ answer: message.question, value: { ok: true } }); });
    chrome.commands.onCommand._emit('open-switcher-reverse', tab);
    await flush();
    expect(port.posted.find((message) => message.question)).toMatchObject({ body: { type: MESSAGE.CYCLE, direction: 1, hold: true } });
    expect((await chrome.storage.session.get('launch')).launch).toBe(undefined); // (no new launch: it moved the open one)
  });

  it('no answer in time (none open): the worker opens one as usual', async () => {
    const { tab } = seed();
    connect();
    chrome.commands.onCommand._emit('open-switcher-stay', tab);
    await flush();
    vi.advanceTimersByTime(300);
    await flush(10);
    expect((await chrome.storage.session.get('launch')).launch).toBeDefined();
  });
});
