// The e2e suite's harness: a local http server for the test pages, and Chrome for Testing (puppeteer) with
// the unpacked extension loaded. Content scripts need http(s) pages; file:// would need extra permission.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../..');
const PAGE_MEDIA = readFileSync(resolve(HERE, 'page-media.js'));

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// How long a "nothing is listed" check waits: well past the hook's 150 ms debounce and a few timeupdates.
export const QUIET_MILLISECONDS = 1500;

// One handler, two listeners: the main origin (127.0.0.1:A) and a cross-site one (localhost:B) for iframes.
// /p/<name> and /frame/<name>: an empty page titled <name> with page-media.js; files added with serve().
export async function startServers() {
  const files = new Map();
  const handler = (request, response) => {
    const path = request.url.split('?')[0];
    if (path === '/page-media.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(PAGE_MEDIA); }
    if (files.has(path)) {
      const file = files.get(path);
      response.writeHead(200, { 'content-type': file.type, 'content-length': file.body.length });
      return response.end(file.body);
    }
    const match = /^\/(p|frame)\/([\w-]+)$/.exec(path);
    if (!match) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${match[2]}</title><script src="/page-media.js"></script><body></body>`);
  };
  const listen = () => new Promise((resolve) => { const httpServer = http.createServer(handler); httpServer.listen(0, () => resolve(httpServer)); });
  const [mainServer, crossServer] = await Promise.all([listen(), listen()]);
  return {
    main: `http://127.0.0.1:${mainServer.address().port}`,
    cross: `http://localhost:${crossServer.address().port}`,
    serve: (path, body, type) => files.set(path, { body, type }),
    close: () => Promise.all([mainServer, crossServer].map((httpServer) => new Promise((resolve) => { httpServer.closeAllConnections(); httpServer.close(resolve); }))),
  };
}

// Headless (the new headless, which loads extensions) Chrome for Testing: branded Chrome 137+ no longer
// loads unpacked extensions from the command line. --mute-audio only silences the output: element.muted, the
// volume and the decoded-audio counters the hook reads are unchanged by it.
export async function launch() {
  const browser = await puppeteer.launch({
    headless: true,
    enableExtensions: true,
    pipe: true,
    args: [
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--js-flags=--expose-gc',
    ],
  });
  const serviceWorkerTarget = await browser.waitForTarget((target) => target.type() === 'service_worker' && target.url().endsWith('/background.js'));
  const id = new URL(serviceWorkerTarget.url()).host;
  return { browser, extension: new Extension(browser, id) };
}

// The extension's side: its service worker, its storage, its view of the tabs.
export class Extension {
  constructor(browser, id) {
    this.browser = browser;
    this.id = id;
    this.serviceWorkerTarget = browser.targets().filter((target) => this.isWorker(target)).pop();
    // After a reload puppeteer still lists the old worker's target: the newest one is the live one.
    browser.on('targetcreated', (target) => { if (this.isWorker(target)) this.serviceWorkerTarget = target; });
  }
  isWorker(target) { return target.type() === 'service_worker' && target.url() === `chrome-extension://${this.id}/background.js`; }

  async worker() { return this.serviceWorkerTarget.worker(); }
  // Reloads the extension, as "Reload" on chrome://extensions does: puppeteer loads the unpacked folder
  // again (CDP Extensions.loadUnpacked). chrome.runtime.reload() can't be used: Chrome for Testing leaves an
  // extension loaded with --load-extension unloaded after it (its pages then fail with ERR_BLOCKED_BY_CLIENT).
  async reload() {
    const old = this.serviceWorkerTarget;
    await this.browser.installExtension(REPO);
    if (this.serviceWorkerTarget === old) await this.browser.waitForTarget((target) => this.isWorker(target) && target !== old);
  }
  async run(callback, ...parameters) { return (await this.worker()).evaluate(callback, ...parameters); }

  // storage.session 'media': { [tabId]: { [frameId]: state } }
  media() { return this.run(() => chrome.storage.session.get('media').then((result) => result.media || {})); }
  // A page's tab id, by its URL (each test page has its own).
  async tabId(page) {
    const url = page.url();
    const id = await this.run((url) => chrome.tabs.query({}).then((tabs) => (tabs.find((tab) => tab.url === url || tab.pendingUrl === url) || {}).id), url);
    if (!Number.isInteger(id)) throw new Error(`no tab for ${url}`);
    return id;
  }
  // What is stored for a page's tab: { [frameId]: state }, or undefined.
  async framesOf(page, tabId) {
    const id = tabId ?? await this.tabId(page);
    return (await this.media())[id];
  }
  // The top frame's stored state, or undefined.
  async topOf(page) { const frameStates = await this.framesOf(page); return frameStates && frameStates['0']; }
  // Each frame of the tab: [{ frameId, url }].
  async frames(page) {
    const tabId = await this.tabId(page);
    return this.run((id) => chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => location.href })
      .then((results) => results.map((result) => ({ frameId: result.frameId, url: result.result }))), tabId);
  }
  // Runs `func` (its source) in a frame of the page's tab, in the page's world, through
  // chrome.scripting.executeScript from the service worker, as the extension's own calls do. The test pages
  // have no CSP, so the source can be evaluated there.
  async inMain(page, callback, parameters = [], frameId = 0) {
    const tabId = await this.tabId(page);
    return this.run((id, frameId, source, parameters) => chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [frameId] }, world: 'MAIN', args: [source, parameters],
      func: (code, list) => (0, eval)(`(${code})`)(...list),
    }).then((results) => results[0] && results[0].result), tabId, frameId, callback.toString(), parameters);
  }
  // A tab with the extension's markup/switcher.html, loaded without a launch token: it shows nothing, but it is an
  // extension page the background accepts messages from (fromSwitcher) and can import the extension's modules.
  async extensionPage() {
    const page = await this.browser.newPage();
    await page.goto(`chrome-extension://${this.id}/markup/switcher.html`);
    return page;
  }
}
