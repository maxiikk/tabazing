// Firefox shows an extension page framed in a web page (the switcher's overlay) with what a content script gets: runtime,
// i18n and storage (without storage.session), none of tabs, windows, history, bookmarks... It also can't hear what the
// background broadcasts. So there the switcher keeps a port open to the background (BRIDGE_PORT), which makes the calls
// it can't (callBridged in background.js) and sends back the events it listens to and the background's questions to it.
// Imported before anything else in switcher.js: what is missing is in place before the modules that use it run. In Chrome,
// in Firefox's own windows, and in the tests, the APIs are all there and nothing here is used.

/** The calls the switcher (and the modules it imports) make, by namespace: the only ones the background makes for it. */
export const BRIDGED_CALLS = Object.freeze({
  tabs: ['query', 'get', 'create', 'update', 'remove', 'move', 'group', 'ungroup', 'reload', 'discard', 'getZoom', 'setZoom'],
  windows: ['get', 'getAll', 'getLastFocused', 'create', 'update', 'remove'],
  tabGroups: ['query', 'get', 'update', 'move'],
  sessions: ['getRecentlyClosed', 'restore'],
  history: ['search', 'deleteUrl', 'addUrl'],
  bookmarks: ['get', 'getTree', 'getChildren', 'getSubTree', 'search', 'create', 'update', 'move', 'remove', 'removeTree'],
  scripting: ['executeScript'],
  commands: ['getAll', 'openShortcutSettings'],
  permissions: ['contains', 'request'],
  alarms: ['create', 'clear'],
  'storage.session': ['get', 'set', 'remove'],
});
/** The events it listens to, which the background passes on ('storage.onChanged': its session area only). */
export const BRIDGED_EVENTS = Object.freeze(['tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onRemoved', 'storage.onChanged']);
export const BRIDGE_PORT = 'tabazing:bridge';

const missing = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect === 'function' && !chrome.tabs;
const eventListeners = new Map(); // 'tabs.onRemoved' -> Set of listeners
const messageListeners = new Set(); // what onBackgroundMessage was given
let port = null;
let nextId = 1;
const pending = new Map(); // call id -> { resolve, reject }

function openPort() {
  port = chrome.runtime.connect({ name: BRIDGE_PORT });
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) reject(new Error(message.error)); else resolve(message.result);
    } else if (typeof message.event === 'string') {
      for (const listener of eventListeners.get(message.event) || []) { try { listener(...(message.args || [])); } catch (error) { console.error(error); } }
    } else if (message.question !== undefined) { // the background asks (MESSAGE.CYCLE: "are you open?"); the first answer goes back
      let answered = false;
      const respond = (answer) => { if (!answered) { answered = true; port.postMessage({ answer: message.question, value: answer }); } };
      for (const listener of messageListeners) listener(message.body, { id: chrome.runtime.id }, respond); // (from the background, as a broadcast is)
      if (!answered) port.postMessage({ answer: message.question, value: null });
    }
  });
  port.onDisconnect.addListener(() => { // (the background was stopped: the next call opens it again)
    port = null;
    for (const { reject } of pending.values()) reject(new Error('the background went away'));
    pending.clear();
  });
}
function call(path, args) {
  if (!port) openPort();
  const id = nextId++;
  // A function can't go by message: the background runs the one of that name it knows (callBridged).
  const sent = path === 'scripting.executeScript' && args[0] && typeof args[0].func === 'function' ? [{ ...args[0], func: args[0].func.name }] : args;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); port.postMessage({ id, call: path, args: sent }); });
}
const bridgedEvent = (name) => ({
  addListener: (listener) => { if (!eventListeners.has(name)) eventListeners.set(name, new Set()); eventListeners.get(name).add(listener); if (!port) openPort(); },
  removeListener: (listener) => { eventListeners.get(name)?.delete(listener); },
  hasListener: (listener) => !!eventListeners.get(name)?.has(listener),
});

if (missing) {
  for (const [path, methods] of Object.entries(BRIDGED_CALLS)) {
    if (path === 'storage.session') continue;
    const namespace = Object.fromEntries(methods.map((method) => [method, (...args) => call(`${path}.${method}`, args)]));
    for (const name of BRIDGED_EVENTS) if (name.startsWith(path + '.')) namespace[name.slice(path.length + 1)] = bridgedEvent(name);
    chrome[path] = namespace;
  }
  if (!chrome.storage.session) Object.defineProperty(chrome.storage, 'session', { configurable: true, value: Object.fromEntries(BRIDGED_CALLS['storage.session'].map((method) => [method, (...args) => call(`storage.session.${method}`, args)])) });
  openPort(); // at once: the background asks it whether it is open (CYCLE) from the first press on
}

/** chrome.runtime.onMessage, and what the background asks through the port where it can't reach this page otherwise. */
export function onBackgroundMessage(listener) {
  chrome.runtime.onMessage.addListener(listener);
  if (missing) messageListeners.add(listener);
}
/** chrome.storage.onChanged, with the session area's changes too where only the background can see them. */
export function onStorageChange(listener) {
  chrome.storage.onChanged.addListener(listener);
  if (missing) bridgedEvent('storage.onChanged').addListener(listener);
}
