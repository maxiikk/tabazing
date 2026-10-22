// An in-memory stand-in for the chrome.* extension APIs Tabazing uses, installed as globalThis.chrome before
// any test file runs (vitest.config.js -> setupFiles). Every API method is a vi.fn, so a test can check calls
// (expect(chrome.tabs.create).toHaveBeenCalledWith(...)) or replace one (mockRejectedValueOnce, ...).
//
// Modules keep references to the objects (store.js holds chrome.storage.local), so they are never replaced:
// chrome._reset() (run before every test) empties the data and the call history in place. Event listeners
// survive a reset, because modules register them once when imported; chrome._clearListeners() drops them
// (call it before importing a module afresh with vi.resetModules()).
//
// Seed data with chrome._addWindow() / chrome._addTab() / chrome._addGroup() / chrome._addBookmark(), or read it via chrome._data.
import { vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8'));
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// ---- events: addListener / removeListener / hasListener, and _emit(...args) for tests (returns the results)
const events = [];
function event() {
  const listeners = new Set();
  const event = {
    addListener: vi.fn((listener) => listeners.add(listener)),
    removeListener: vi.fn((listener) => listeners.delete(listener)),
    hasListener: vi.fn((listener) => listeners.has(listener)),
    hasListeners: () => listeners.size > 0,
    _listeners: listeners,
    _emit: (...values) => [...listeners].map((listener) => listener(...values)),
  };
  events.push(event);
  return event;
}

// ---- storage areas (async, structured-cloned like Chrome's)
const onChanged = event();
function area(name) {
  const data = new Map();
  const get = async (keys) => {
    const out = {};
    if (keys === null || keys === undefined) { for (const [storageKey, value] of data) out[storageKey] = clone(value); return out; }
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) { for (const storageKey of keys) if (data.has(storageKey)) out[storageKey] = clone(data.get(storageKey)); return out; }
    for (const [storageKey, defaultValue] of Object.entries(keys)) out[storageKey] = data.has(storageKey) ? clone(data.get(storageKey)) : defaultValue; // { key: default }
    return out;
  };
  const set = async (items) => {
    const changes = {};
    for (const [storageKey, value] of Object.entries(items)) {
      changes[storageKey] = { oldValue: clone(data.get(storageKey)), newValue: clone(value) };
      data.set(storageKey, clone(value));
    }
    if (Object.keys(changes).length) onChanged._emit(changes, name);
  };
  const remove = async (keys) => {
    const changes = {};
    for (const storageKey of [].concat(keys)) if (data.has(storageKey)) { changes[storageKey] = { oldValue: data.get(storageKey) }; data.delete(storageKey); }
    if (Object.keys(changes).length) onChanged._emit(changes, name);
  };
  return {
    get: vi.fn(get), set: vi.fn(set), remove: vi.fn(remove),
    clear: vi.fn(async () => remove([...data.keys()])),
    getBytesInUse: vi.fn(async () => 0),
    setAccessLevel: vi.fn(async () => {}),
    _data: data,
  };
}

// ---- tabs, windows, bookmarks, history, sessions: plain arrays tests can seed
const data = { tabs: [], windows: [], groups: [], nextTab: 1, nextWindow: 1, nextGroup: 1, bookmarks: null, nextMark: 100, history: [], closed: [], alarms: new Map(), zoom: new Map(), lang: 'en' };

function freshBookmarks() {
  return {
    id: '0', title: '', children: [
      { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] },
      { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
    ],
  };
}
function findMark(id, node = data.bookmarks) {
  if (node.id === String(id)) return node;
  for (const child of node.children || []) { const found = findMark(id, child); if (found) return found; }
  return null;
}
const markOut = (node) => { const { children, ...rest } = node; return children ? { ...rest, children: children.map(markOut) } : { ...rest }; };

function reindex(windowId) {
  data.tabs.filter((tab) => tab.windowId === windowId).sort((first, second) => first.index - second.index).forEach((tab, i) => { tab.index = i; });
}
// Put tab `t` at position `index` among the other tabs of its window, and renumber them.
function place(tab, index) {
  const others = data.tabs.filter((x) => x !== tab && x.windowId === tab.windowId).sort((first, second) => first.index - second.index);
  others.splice(Math.min(Math.max(0, index), others.length), 0, tab);
  others.forEach((x, i) => { x.index = i; });
}
function makeTab(options = {}) {
  if (!data.windows.length && options.windowId === undefined) makeWindow();
  const windowId = options.windowId ?? data.windows[0].id;
  if (!data.windows.some((window) => window.id === windowId)) makeWindow({ id: windowId });
  const tabsInWindow = data.tabs.filter((tab) => tab.windowId === windowId);
  const tab = {
    id: data.nextTab++, windowId, index: tabsInWindow.length, url: 'https://example.com/', title: 'Example', active: false, pinned: false,
    audible: false, discarded: false, highlighted: false, incognito: false, status: 'complete', mutedInfo: { muted: false },
    lastAccessed: Date.now(), favIconUrl: '', groupId: -1, ...options,
  };
  if (options.index !== undefined) { tabsInWindow.forEach((tab) => { if (tab.index >= options.index) tab.index++; }); }
  data.tabs.push(tab);
  if (tab.id >= data.nextTab) data.nextTab = tab.id + 1;
  if (tab.active) data.tabs.forEach((otherTab) => { if (otherTab !== tab && otherTab.windowId === windowId) otherTab.active = false; });
  reindex(windowId);
  return tab;
}
function makeWindow(options = {}) {
  const window = { id: options.id ?? data.nextWindow++, focused: !data.windows.length, type: 'normal', state: 'normal', incognito: false, left: 0, top: 0, width: 1200, height: 800, ...options };
  if (window.id >= data.nextWindow) data.nextWindow = window.id + 1;
  data.windows.push(window);
  return window;
}
function makeGroup(options = {}) {
  const group = { id: options.id ?? data.nextGroup++, title: '', color: 'grey', collapsed: false, windowId: options.windowId ?? (data.windows[0] && data.windows[0].id), ...options };
  if (group.id >= data.nextGroup) data.nextGroup = group.id + 1;
  data.groups.push(group);
  return group;
}
const tabOut = (tab) => clone(tab);
function needTab(id) {
  const tab = data.tabs.find((x) => x.id === id);
  if (!tab) throw new Error(`No tab with id: ${id}.`);
  return tab;
}

// A URL, or a match pattern like Chrome's ("<all_urls>", "http://*/*", "*://*.example.com/*").
function matchPattern(pattern, url) {
  if (!pattern.includes('*') && pattern !== '<all_urls>') return pattern === url;
  if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?):/.test(url);
  const match = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!match) return false;
  const [, scheme, host, path] = match;
  const escapeRegex = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const schemeRe = scheme === '*' ? '(https?|wss?)' : scheme;
  const hostRe = host === '*' ? '[^/]*' : host.startsWith('*.') ? `([^/]*\\.)?${escapeRegex(host.slice(2))}` : escapeRegex(host);
  return new RegExp(`^${schemeRe}://${hostRe}${escapeRegex(path)}$`).test(url);
}

const tabsEvent = { onActivated: event(), onCreated: event(), onRemoved: event(), onUpdated: event(), onReplaced: event(), onMoved: event(), onAttached: event(), onDetached: event() };

const chrome = {
  runtime: {
    id: EXTENSION_ID,
    lastError: undefined,
    getURL: vi.fn((path = '') => `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\//, '')}`),
    getManifest: vi.fn(() => clone(MANIFEST)),
    sendMessage: vi.fn(async () => undefined),
    getPlatformInfo: vi.fn(async () => ({ os: 'win', arch: 'x86-64' })),
    setUninstallURL: vi.fn(async () => {}),
    getContexts: vi.fn(async () => []),
    reload: vi.fn(),
    onMessage: event(), onInstalled: event(), onStartup: event(), onConnect: event(),
  },
  storage: { local: area('local'), session: area('session'), sync: area('sync'), onChanged },
  tabs: {
    TAB_ID_NONE: -1,
    query: vi.fn(async (query = {}) => data.tabs.filter((tab) => {
      const window = data.windows.find((x) => x.id === tab.windowId);
      if (query.windowId !== undefined && query.windowId !== -2 && tab.windowId !== query.windowId) return false;
      if (query.groupId !== undefined && tab.groupId !== query.groupId) return false;
      if (query.windowType && (!window || window.type !== query.windowType)) return false;
      if ((query.currentWindow || query.lastFocusedWindow) && (!window || !window.focused)) return false;
      for (const propertyName of ['active', 'pinned', 'audible', 'discarded', 'highlighted', 'status']) if (query[propertyName] !== undefined && tab[propertyName] !== query[propertyName]) return false;
      if (query.url !== undefined && ![].concat(query.url).some((pattern) => matchPattern(pattern, tab.url))) return false;
      return true;
    }).sort((first, second) => first.windowId - second.windowId || first.index - second.index).map(tabOut)),
    get: vi.fn(async (id) => tabOut(needTab(id))),
    create: vi.fn(async (options = {}) => {
      const tab = makeTab({ url: options.url ?? 'chrome://newtab/', title: options.url ?? 'New Tab', windowId: options.windowId, index: options.index, pinned: !!options.pinned, active: options.active !== false, openerTabId: options.openerTabId });
      tabsEvent.onCreated._emit(tabOut(tab));
      return tabOut(tab);
    }),
    update: vi.fn(async (id, options = {}) => {
      const tab = needTab(id);
      if (options.active) data.tabs.forEach((x) => { if (x.windowId === tab.windowId) x.active = false; });
      if (options.muted !== undefined) tab.mutedInfo = { muted: !!options.muted };
      const pinChange = options.pinned !== undefined && !!options.pinned !== !!tab.pinned;
      for (const propertyName of ['active', 'pinned', 'url', 'highlighted']) if (options[propertyName] !== undefined) tab[propertyName] = options[propertyName];
      // Like Chrome: a tab being pinned goes to the end of the pinned tabs, one being unpinned to just after them.
      if (pinChange) place(tab, data.tabs.filter((x) => x !== tab && x.windowId === tab.windowId && x.pinned).length);
      tabsEvent.onUpdated._emit(id, options, tabOut(tab));
      return tabOut(tab);
    }),
    remove: vi.fn(async (ids) => {
      for (const id of [].concat(ids)) {
        const tab = needTab(id);
        data.tabs = data.tabs.filter((x) => x !== tab);
        reindex(tab.windowId);
        data.groups = data.groups.filter((group) => data.tabs.some((x) => x.groupId === group.id));
        tabsEvent.onRemoved._emit(id, { windowId: tab.windowId, isWindowClosing: false });
      }
    }),
    move: vi.fn(async (ids, options) => {
      const out = [];
      for (const id of [].concat(ids)) {
        // Like Chrome: the tab ends up AT `index` among the window's other tabs (-1 = the end).
        const tab = needTab(id);
        const from = tab.windowId;
        tab.windowId = options.windowId ?? tab.windowId;
        if (tab.windowId !== from) { tab.groupId = -1; data.groups = data.groups.filter((group) => data.tabs.some((x) => x.groupId === group.id)); }
        place(tab, options.index === -1 ? Infinity : options.index);
        reindex(from);
        out.push(tabOut(tab));
      }
      return Array.isArray(ids) ? out : out[0];
    }),
    // Tab groups: like Chrome, a group goes away with its last tab.
    group: vi.fn(async ({ tabIds, groupId, createProperties = {} } = {}) => {
      const ids = [].concat(tabIds);
      let group = groupId !== undefined ? data.groups.find((x) => x.id === groupId) : null;
      if (groupId !== undefined && !group) throw new Error(`No group with id: ${groupId}.`);
      if (!group) group = makeGroup({ windowId: createProperties.windowId ?? needTab(ids[0]).windowId });
      for (const id of ids) { const tab = needTab(id); tab.groupId = group.id; tab.pinned = false; }
      return group.id;
    }),
    ungroup: vi.fn(async (tabIds) => {
      for (const id of [].concat(tabIds)) needTab(id).groupId = -1;
      data.groups = data.groups.filter((group) => data.tabs.some((tab) => tab.groupId === group.id));
    }),
    reload: vi.fn(async () => {}),
    getZoom: vi.fn(async (id) => { needTab(id); return data.zoom.get(id) ?? 1; }),
    setZoom: vi.fn(async (id, zoomFactor) => { needTab(id); data.zoom.set(id, zoomFactor); }),
    discard: vi.fn(async (id) => { const tab = needTab(id); tab.discarded = true; return tabOut(tab); }),
    captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
    sendMessage: vi.fn(async () => undefined),
    ...tabsEvent,
  },
  windows: {
    WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
    getAll: vi.fn(async (query = {}) => data.windows.filter((window) => !query.windowTypes || query.windowTypes.includes(window.type)).map((window) => ({ ...clone(window), tabs: query.populate ? data.tabs.filter((tab) => tab.windowId === window.id).map(tabOut) : undefined }))),
    get: vi.fn(async (id, query = {}) => {
      const window = data.windows.find((x) => x.id === id);
      if (!window) throw new Error(`No window with id: ${id}.`);
      return { ...clone(window), tabs: query.populate ? data.tabs.filter((tab) => tab.windowId === window.id).map(tabOut) : undefined };
    }),
    getLastFocused: vi.fn(async () => clone(data.windows.find((window) => window.focused) || data.windows[0])),
    getCurrent: vi.fn(async () => clone(data.windows.find((window) => window.focused) || data.windows[0])),
    create: vi.fn(async (options = {}) => {
      const window = makeWindow({ type: options.type || 'normal', state: options.state || 'normal', focused: !!options.focused });
      if (options.tabId !== undefined) { const tab = needTab(options.tabId); const from = tab.windowId; tab.windowId = window.id; tab.index = 0; tab.groupId = -1; reindex(from); data.groups = data.groups.filter((group) => data.tabs.some((x) => x.groupId === group.id)); }
      else if (options.url) makeTab({ windowId: window.id, url: [].concat(options.url)[0], active: true });
      return { ...clone(window), tabs: data.tabs.filter((tab) => tab.windowId === window.id).map(tabOut) };
    }),
    update: vi.fn(async (id, options = {}) => {
      const window = data.windows.find((x) => x.id === id);
      if (!window) throw new Error(`No window with id: ${id}.`);
      if (options.focused) data.windows.forEach((x) => { x.focused = x === window; });
      Object.assign(window, options);
      return clone(window);
    }),
    remove: vi.fn(async (id) => { data.windows = data.windows.filter((window) => window.id !== id); data.tabs = data.tabs.filter((tab) => tab.windowId !== id); }),
    onRemoved: event(), onFocusChanged: event(), onCreated: event(), onBoundsChanged: event(),
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    query: vi.fn(async (query = {}) => clone(data.groups.filter((group) => query.windowId === undefined || group.windowId === query.windowId))),
    get: vi.fn(async (id) => { const group = data.groups.find((x) => x.id === id); if (!group) throw new Error(`No group with id: ${id}.`); return clone(group); }),
    update: vi.fn(async (id, options = {}) => { const group = data.groups.find((x) => x.id === id); if (!group) throw new Error(`No group with id: ${id}.`); Object.assign(group, options); return clone(group); }),
    // Like Chrome: the group's tabs go together, in their order, to `index` in `windowId` (-1: the end).
    move: vi.fn(async (id, options = {}) => {
      const group = data.groups.find((x) => x.id === id);
      if (!group) throw new Error(`No group with id: ${id}.`);
      const tabs = data.tabs.filter((tab) => tab.groupId === id).sort((first, second) => first.index - second.index);
      const from = group.windowId;
      group.windowId = options.windowId ?? group.windowId;
      // As one block, `index` counted among the other tabs of the window it goes to.
      const others = data.tabs.filter((tab) => tab.windowId === group.windowId && tab.groupId !== id).sort((first, second) => first.index - second.index);
      const at = options.index === -1 || options.index === undefined ? others.length : Math.min(Math.max(0, options.index), others.length);
      for (const tab of tabs) tab.windowId = group.windowId;
      [...others.slice(0, at), ...tabs, ...others.slice(at)].forEach((tab, i) => { tab.index = i; });
      reindex(from);
      return clone(group);
    }),
    onCreated: event(), onUpdated: event(), onRemoved: event(),
  },
  sessions: {
    MAX_SESSION_RESULTS: 25,
    getRecentlyClosed: vi.fn(async (query = {}) => clone(data.closed.slice(0, query.maxResults ?? 25))),
    restore: vi.fn(async (sessionId) => ({ sessionId })),
    onChanged: event(),
  },
  bookmarks: {
    getTree: vi.fn(async () => [markOut(data.bookmarks)]),
    getChildren: vi.fn(async (id) => {
      const node = findMark(id);
      if (!node) throw new Error("Can't find bookmark for id.");
      return (node.children || []).map((child, index) => { const { children, ...rest } = child; return { ...rest, index }; });
    }),
    get: vi.fn(async (ids) => [].concat(ids).map((id) => { const node = findMark(id); if (!node) throw new Error("Can't find bookmark for id."); const { children, ...rest } = node; return rest; })),
    create: vi.fn(async (options) => {
      const parent = findMark(options.parentId ?? '2');
      if (!parent || !parent.children) throw new Error("Can't find parent bookmark for id.");
      const node = { id: String(data.nextMark++), parentId: parent.id, title: options.title || '', dateAdded: Date.now() };
      if (options.url) node.url = options.url; else node.children = [];
      const at = options.index === undefined ? parent.children.length : Math.max(0, Math.min(options.index, parent.children.length));
      parent.children.splice(at, 0, node);
      const { children, ...rest } = node;
      return { ...rest, index: at };
    }),
    remove: vi.fn(async (id) => {
      const node = findMark(id);
      if (!node) throw new Error("Can't find bookmark for id.");
      if (node.children && node.children.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
      const parent = findMark(node.parentId);
      parent.children = parent.children.filter((child) => child !== node);
    }),
    removeTree: vi.fn(async (id) => {
      const node = findMark(id);
      if (!node) throw new Error("Can't find bookmark for id.");
      const parent = findMark(node.parentId);
      parent.children = parent.children.filter((child) => child !== node);
    }),
    move: vi.fn(async (id, options = {}) => {
      const node = findMark(id);
      if (!node) throw new Error("Can't find bookmark for id.");
      const from = findMark(node.parentId), to = findMark(options.parentId ?? node.parentId);
      const was = from.children.indexOf(node);
      from.children = from.children.filter((child) => child !== node);
      // Chrome's index: where it goes as if it were still there (in its own folder, a later place is one less)
      const want = options.index === undefined ? Infinity : from === to && options.index > was ? options.index - 1 : options.index;
      const at = Math.max(0, Math.min(want, to.children.length));
      to.children.splice(at, 0, node);
      node.parentId = to.id;
      const { children, ...rest } = node;
      return { ...rest, index: at };
    }),
    // { url }: the bookmarks of exactly that address; a string: those whose title or address has it.
    search: vi.fn(async (query) => {
      const out = [];
      const walk = (node) => { if (node.url && (typeof query === 'string' ? (node.title + ' ' + node.url).toLowerCase().includes(query.toLowerCase()) : node.url === query.url)) out.push(node); (node.children || []).forEach(walk); };
      walk(data.bookmarks);
      return out.map((node) => ({ ...node }));
    }),
    update: vi.fn(async (id, options = {}) => {
      const node = findMark(id);
      if (!node) throw new Error("Can't find bookmark for id.");
      for (const propertyName of ['title', 'url']) if (options[propertyName] !== undefined) node[propertyName] = options[propertyName];
      const { children, ...rest } = node;
      return rest;
    }),
    onCreated: event(), onRemoved: event(), onChanged: event(),
  },
  history: {
    search: vi.fn(async (query = {}) => {
      const text = (query.text || '').toLowerCase();
      return clone(data.history
        .filter((x) => (!query.startTime || (x.lastVisitTime || 0) >= query.startTime) && (!text || (x.title || '').toLowerCase().includes(text) || x.url.toLowerCase().includes(text)))
        .sort((first, second) => (second.lastVisitTime || 0) - (first.lastVisitTime || 0)) // newest first, as Chrome returns them
        .slice(0, query.maxResults ?? 100));
    }),
    deleteUrl: vi.fn(async ({ url }) => { data.history = data.history.filter((x) => x.url !== url); }),
    addUrl: vi.fn(async ({ url, title, visitTime }) => { data.history.push({ url, title: title || '', lastVisitTime: visitTime || Date.now(), visitCount: 1 }); }),
  },
  alarms: {
    create: vi.fn(async (name, details) => { data.alarms.set(name, { name, scheduledTime: details.when ?? Date.now() + (details.delayInMinutes || 0) * 60000 }); }),
    clear: vi.fn(async (name) => data.alarms.delete(name)),
    get: vi.fn(async (name) => clone(data.alarms.get(name))),
    getAll: vi.fn(async () => clone([...data.alarms.values()])),
    onAlarm: event(),
  },
  commands: {
    getAll: vi.fn(async () => Object.entries(MANIFEST.commands || {}).map(([name, command]) => ({ name, description: command.description, shortcut: (command.suggested_key && command.suggested_key.default) || '' }))),
    onCommand: event(),
  },
  permissions: {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
    getAll: vi.fn(async () => ({ permissions: MANIFEST.permissions, origins: MANIFEST.host_permissions })),
    onAdded: event(), onRemoved: event(),
  },
  scripting: { executeScript: vi.fn(async () => [{ result: undefined }]), insertCSS: vi.fn(async () => {}) },
  action: {
    setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setBadgeTextColor: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}), onClicked: event(),
  },
  i18n: { getUILanguage: vi.fn(() => data.lang), getMessage: vi.fn((messageKey) => messageKey) },
};

// ---- test helpers
chrome._data = data;
chrome._addWindow = (options) => makeWindow(options);
chrome._addTab = (options) => makeTab(options);
chrome._addGroup = (options) => makeGroup(options);
chrome._addBookmark = (options) => {
  const parent = findMark(options.parentId ?? '2');
  const node = { id: String(options.id ?? data.nextMark++), parentId: parent.id, title: options.title || '', dateAdded: options.dateAdded ?? Date.now() };
  if (options.url) node.url = options.url; else node.children = [];
  parent.children.push(node);
  return node;
};
chrome._findBookmark = (id) => findMark(id);
chrome._clearListeners = () => events.forEach((event) => event._listeners.clear());
chrome._reset = () => {
  for (const area of [chrome.storage.local, chrome.storage.session, chrome.storage.sync]) area._data.clear();
  Object.assign(data, { tabs: [], windows: [], groups: [], nextTab: 1, nextWindow: 1, nextGroup: 1, bookmarks: freshBookmarks(), nextMark: 100, history: [], closed: [], lang: 'en' });
  data.alarms.clear();
  data.zoom.clear();
  chrome.runtime.lastError = undefined;
  // mockReset also undoes a test's mockImplementation (vitest 3+: back to the original implementation)
  const walk = (object) => { for (const value of Object.values(object)) { if (typeof value === 'function' && value.mock) value.mockReset(); else if (value && typeof value === 'object' && !(value instanceof Map) && value !== data) walk(value); } };
  walk(chrome);
};
chrome._reset();

globalThis.chrome = chrome;
beforeEach(() => chrome._reset());
