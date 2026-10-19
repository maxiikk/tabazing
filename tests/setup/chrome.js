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
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

// ---- events: addListener / removeListener / hasListener, and _emit(...args) for tests (returns the results)
const events = [];
function event() {
  const ls = new Set();
  const ev = {
    addListener: vi.fn((fn) => ls.add(fn)),
    removeListener: vi.fn((fn) => ls.delete(fn)),
    hasListener: vi.fn((fn) => ls.has(fn)),
    hasListeners: () => ls.size > 0,
    _listeners: ls,
    _emit: (...args) => [...ls].map((fn) => fn(...args)),
  };
  events.push(ev);
  return ev;
}

// ---- storage areas (async, structured-cloned like Chrome's)
const onChanged = event();
function area(name) {
  const data = new Map();
  const get = async (keys) => {
    const out = {};
    if (keys === null || keys === undefined) { for (const [k, v] of data) out[k] = clone(v); return out; }
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) { for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k)); return out; }
    for (const [k, def] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : def; // { key: default }
    return out;
  };
  const set = async (items) => {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: clone(data.get(k)), newValue: clone(v) };
      data.set(k, clone(v));
    }
    if (Object.keys(changes).length) onChanged._emit(changes, name);
  };
  const remove = async (keys) => {
    const changes = {};
    for (const k of [].concat(keys)) if (data.has(k)) { changes[k] = { oldValue: data.get(k) }; data.delete(k); }
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
const D = { tabs: [], windows: [], groups: [], nextTab: 1, nextWin: 1, nextGroup: 1, bookmarks: null, nextMark: 100, history: [], closed: [], alarms: new Map(), zoom: new Map(), lang: 'en' };

function freshBookmarks() {
  return {
    id: '0', title: '', children: [
      { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] },
      { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
    ],
  };
}
function findMark(id, n = D.bookmarks) {
  if (n.id === String(id)) return n;
  for (const c of n.children || []) { const f = findMark(id, c); if (f) return f; }
  return null;
}
const markOut = (n) => { const { children, ...rest } = n; return children ? { ...rest, children: children.map(markOut) } : { ...rest }; };

function reindex(windowId) {
  D.tabs.filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
}
// Put tab `t` at position `index` among the other tabs of its window, and renumber them.
function place(t, index) {
  const others = D.tabs.filter((x) => x !== t && x.windowId === t.windowId).sort((a, b) => a.index - b.index);
  others.splice(Math.min(Math.max(0, index), others.length), 0, t);
  others.forEach((x, i) => { x.index = i; });
}
function makeTab(p = {}) {
  if (!D.windows.length && p.windowId === undefined) makeWindow();
  const windowId = p.windowId ?? D.windows[0].id;
  if (!D.windows.some((w) => w.id === windowId)) makeWindow({ id: windowId });
  const inWin = D.tabs.filter((t) => t.windowId === windowId);
  const tab = {
    id: D.nextTab++, windowId, index: inWin.length, url: 'https://example.com/', title: 'Example', active: false, pinned: false,
    audible: false, discarded: false, highlighted: false, incognito: false, status: 'complete', mutedInfo: { muted: false },
    lastAccessed: Date.now(), favIconUrl: '', groupId: -1, ...p,
  };
  if (p.index !== undefined) { inWin.forEach((t) => { if (t.index >= p.index) t.index++; }); }
  D.tabs.push(tab);
  if (tab.id >= D.nextTab) D.nextTab = tab.id + 1;
  if (tab.active) D.tabs.forEach((t) => { if (t !== tab && t.windowId === windowId) t.active = false; });
  reindex(windowId);
  return tab;
}
function makeWindow(p = {}) {
  const w = { id: p.id ?? D.nextWin++, focused: !D.windows.length, type: 'normal', state: 'normal', incognito: false, left: 0, top: 0, width: 1200, height: 800, ...p };
  if (w.id >= D.nextWin) D.nextWin = w.id + 1;
  D.windows.push(w);
  return w;
}
function makeGroup(p = {}) {
  const g = { id: p.id ?? D.nextGroup++, title: '', color: 'grey', collapsed: false, windowId: p.windowId ?? (D.windows[0] && D.windows[0].id), ...p };
  if (g.id >= D.nextGroup) D.nextGroup = g.id + 1;
  D.groups.push(g);
  return g;
}
const tabOut = (t) => clone(t);
function needTab(id) {
  const t = D.tabs.find((x) => x.id === id);
  if (!t) throw new Error(`No tab with id: ${id}.`);
  return t;
}

// A URL, or a match pattern like Chrome's ("<all_urls>", "http://*/*", "*://*.example.com/*").
function matchPattern(pattern, url) {
  if (!pattern.includes('*') && pattern !== '<all_urls>') return pattern === url;
  if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?):/.test(url);
  const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m;
  const re = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const schemeRe = scheme === '*' ? '(https?|wss?)' : scheme;
  const hostRe = host === '*' ? '[^/]*' : host.startsWith('*.') ? `([^/]*\\.)?${re(host.slice(2))}` : re(host);
  return new RegExp(`^${schemeRe}://${hostRe}${re(path)}$`).test(url);
}

const tabsEv = { onActivated: event(), onCreated: event(), onRemoved: event(), onUpdated: event(), onReplaced: event(), onMoved: event(), onAttached: event(), onDetached: event() };

const chrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    getURL: vi.fn((p = '') => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, '')}`),
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
    query: vi.fn(async (q = {}) => D.tabs.filter((t) => {
      const w = D.windows.find((x) => x.id === t.windowId);
      if (q.windowId !== undefined && q.windowId !== -2 && t.windowId !== q.windowId) return false;
      if (q.groupId !== undefined && t.groupId !== q.groupId) return false;
      if (q.windowType && (!w || w.type !== q.windowType)) return false;
      if ((q.currentWindow || q.lastFocusedWindow) && (!w || !w.focused)) return false;
      for (const k of ['active', 'pinned', 'audible', 'discarded', 'highlighted', 'status']) if (q[k] !== undefined && t[k] !== q[k]) return false;
      if (q.url !== undefined && ![].concat(q.url).some((u) => matchPattern(u, t.url))) return false;
      return true;
    }).sort((a, b) => a.windowId - b.windowId || a.index - b.index).map(tabOut)),
    get: vi.fn(async (id) => tabOut(needTab(id))),
    create: vi.fn(async (p = {}) => {
      const t = makeTab({ url: p.url ?? 'chrome://newtab/', title: p.url ?? 'New Tab', windowId: p.windowId, index: p.index, pinned: !!p.pinned, active: p.active !== false, openerTabId: p.openerTabId });
      tabsEv.onCreated._emit(tabOut(t));
      return tabOut(t);
    }),
    update: vi.fn(async (id, p = {}) => {
      const t = needTab(id);
      if (p.active) D.tabs.forEach((x) => { if (x.windowId === t.windowId) x.active = false; });
      if (p.muted !== undefined) t.mutedInfo = { muted: !!p.muted };
      const pinChange = p.pinned !== undefined && !!p.pinned !== !!t.pinned;
      for (const k of ['active', 'pinned', 'url', 'highlighted']) if (p[k] !== undefined) t[k] = p[k];
      // Like Chrome: a tab being pinned goes to the end of the pinned tabs, one being unpinned to just after them.
      if (pinChange) place(t, D.tabs.filter((x) => x !== t && x.windowId === t.windowId && x.pinned).length);
      tabsEv.onUpdated._emit(id, p, tabOut(t));
      return tabOut(t);
    }),
    remove: vi.fn(async (ids) => {
      for (const id of [].concat(ids)) {
        const t = needTab(id);
        D.tabs = D.tabs.filter((x) => x !== t);
        reindex(t.windowId);
        D.groups = D.groups.filter((g) => D.tabs.some((x) => x.groupId === g.id));
        tabsEv.onRemoved._emit(id, { windowId: t.windowId, isWindowClosing: false });
      }
    }),
    move: vi.fn(async (ids, p) => {
      const out = [];
      for (const id of [].concat(ids)) {
        // Like Chrome: the tab ends up AT `index` among the window's other tabs (-1 = the end).
        const t = needTab(id);
        const from = t.windowId;
        t.windowId = p.windowId ?? t.windowId;
        if (t.windowId !== from) { t.groupId = -1; D.groups = D.groups.filter((g) => D.tabs.some((x) => x.groupId === g.id)); }
        place(t, p.index === -1 ? Infinity : p.index);
        reindex(from);
        out.push(tabOut(t));
      }
      return Array.isArray(ids) ? out : out[0];
    }),
    // Tab groups: like Chrome, a group goes away with its last tab.
    group: vi.fn(async ({ tabIds, groupId, createProperties = {} } = {}) => {
      const ids = [].concat(tabIds);
      let g = groupId !== undefined ? D.groups.find((x) => x.id === groupId) : null;
      if (groupId !== undefined && !g) throw new Error(`No group with id: ${groupId}.`);
      if (!g) g = makeGroup({ windowId: createProperties.windowId ?? needTab(ids[0]).windowId });
      for (const id of ids) { const t = needTab(id); t.groupId = g.id; t.pinned = false; }
      return g.id;
    }),
    ungroup: vi.fn(async (tabIds) => {
      for (const id of [].concat(tabIds)) needTab(id).groupId = -1;
      D.groups = D.groups.filter((g) => D.tabs.some((t) => t.groupId === g.id));
    }),
    reload: vi.fn(async () => {}),
    getZoom: vi.fn(async (id) => { needTab(id); return D.zoom.get(id) ?? 1; }),
    setZoom: vi.fn(async (id, z) => { needTab(id); D.zoom.set(id, z); }),
    discard: vi.fn(async (id) => { const t = needTab(id); t.discarded = true; return tabOut(t); }),
    captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
    sendMessage: vi.fn(async () => undefined),
    ...tabsEv,
  },
  windows: {
    WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
    getAll: vi.fn(async (q = {}) => D.windows.filter((w) => !q.windowTypes || q.windowTypes.includes(w.type)).map((w) => ({ ...clone(w), tabs: q.populate ? D.tabs.filter((t) => t.windowId === w.id).map(tabOut) : undefined }))),
    get: vi.fn(async (id, q = {}) => {
      const w = D.windows.find((x) => x.id === id);
      if (!w) throw new Error(`No window with id: ${id}.`);
      return { ...clone(w), tabs: q.populate ? D.tabs.filter((t) => t.windowId === w.id).map(tabOut) : undefined };
    }),
    getLastFocused: vi.fn(async () => clone(D.windows.find((w) => w.focused) || D.windows[0])),
    getCurrent: vi.fn(async () => clone(D.windows.find((w) => w.focused) || D.windows[0])),
    create: vi.fn(async (p = {}) => {
      const w = makeWindow({ type: p.type || 'normal', state: p.state || 'normal', focused: !!p.focused });
      if (p.tabId !== undefined) { const t = needTab(p.tabId); const from = t.windowId; t.windowId = w.id; t.index = 0; t.groupId = -1; reindex(from); D.groups = D.groups.filter((g) => D.tabs.some((x) => x.groupId === g.id)); }
      else if (p.url) makeTab({ windowId: w.id, url: [].concat(p.url)[0], active: true });
      return { ...clone(w), tabs: D.tabs.filter((t) => t.windowId === w.id).map(tabOut) };
    }),
    update: vi.fn(async (id, p = {}) => {
      const w = D.windows.find((x) => x.id === id);
      if (!w) throw new Error(`No window with id: ${id}.`);
      if (p.focused) D.windows.forEach((x) => { x.focused = x === w; });
      Object.assign(w, p);
      return clone(w);
    }),
    remove: vi.fn(async (id) => { D.windows = D.windows.filter((w) => w.id !== id); D.tabs = D.tabs.filter((t) => t.windowId !== id); }),
    onRemoved: event(), onFocusChanged: event(), onCreated: event(), onBoundsChanged: event(),
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    query: vi.fn(async (q = {}) => clone(D.groups.filter((g) => q.windowId === undefined || g.windowId === q.windowId))),
    get: vi.fn(async (id) => { const g = D.groups.find((x) => x.id === id); if (!g) throw new Error(`No group with id: ${id}.`); return clone(g); }),
    update: vi.fn(async (id, p = {}) => { const g = D.groups.find((x) => x.id === id); if (!g) throw new Error(`No group with id: ${id}.`); Object.assign(g, p); return clone(g); }),
    // Like Chrome: the group's tabs go together, in their order, to `index` in `windowId` (-1: the end).
    move: vi.fn(async (id, p = {}) => {
      const g = D.groups.find((x) => x.id === id);
      if (!g) throw new Error(`No group with id: ${id}.`);
      const tabs = D.tabs.filter((t) => t.groupId === id).sort((a, b) => a.index - b.index);
      const from = g.windowId;
      g.windowId = p.windowId ?? g.windowId;
      // As one block, `index` counted among the other tabs of the window it goes to.
      const others = D.tabs.filter((t) => t.windowId === g.windowId && t.groupId !== id).sort((a, b) => a.index - b.index);
      const at = p.index === -1 || p.index === undefined ? others.length : Math.min(Math.max(0, p.index), others.length);
      for (const t of tabs) t.windowId = g.windowId;
      [...others.slice(0, at), ...tabs, ...others.slice(at)].forEach((t, i) => { t.index = i; });
      reindex(from);
      return clone(g);
    }),
    onCreated: event(), onUpdated: event(), onRemoved: event(),
  },
  sessions: {
    MAX_SESSION_RESULTS: 25,
    getRecentlyClosed: vi.fn(async (q = {}) => clone(D.closed.slice(0, q.maxResults ?? 25))),
    restore: vi.fn(async (sessionId) => ({ sessionId })),
    onChanged: event(),
  },
  bookmarks: {
    getTree: vi.fn(async () => [markOut(D.bookmarks)]),
    getChildren: vi.fn(async (id) => {
      const n = findMark(id);
      if (!n) throw new Error("Can't find bookmark for id.");
      return (n.children || []).map((c, index) => { const { children, ...rest } = c; return { ...rest, index }; });
    }),
    get: vi.fn(async (ids) => [].concat(ids).map((id) => { const n = findMark(id); if (!n) throw new Error("Can't find bookmark for id."); const { children, ...rest } = n; return rest; })),
    create: vi.fn(async (p) => {
      const parent = findMark(p.parentId ?? '2');
      if (!parent || !parent.children) throw new Error("Can't find parent bookmark for id.");
      const n = { id: String(D.nextMark++), parentId: parent.id, title: p.title || '', dateAdded: Date.now() };
      if (p.url) n.url = p.url; else n.children = [];
      parent.children.push(n);
      const { children, ...rest } = n;
      return { ...rest, index: parent.children.length - 1 };
    }),
    remove: vi.fn(async (id) => {
      const n = findMark(id);
      if (!n) throw new Error("Can't find bookmark for id.");
      const parent = findMark(n.parentId);
      parent.children = parent.children.filter((c) => c !== n);
    }),
    // { url }: the bookmarks of exactly that address; a string: those whose title or address has it.
    search: vi.fn(async (q) => {
      const out = [];
      const walk = (n) => { if (n.url && (typeof q === 'string' ? (n.title + ' ' + n.url).toLowerCase().includes(q.toLowerCase()) : n.url === q.url)) out.push(n); (n.children || []).forEach(walk); };
      walk(D.bookmarks);
      return out.map((n) => ({ ...n }));
    }),
    update: vi.fn(async (id, p = {}) => {
      const n = findMark(id);
      if (!n) throw new Error("Can't find bookmark for id.");
      for (const k of ['title', 'url']) if (p[k] !== undefined) n[k] = p[k];
      const { children, ...rest } = n;
      return rest;
    }),
    onCreated: event(), onRemoved: event(), onChanged: event(),
  },
  history: {
    search: vi.fn(async (q = {}) => {
      const text = (q.text || '').toLowerCase();
      return clone(D.history
        .filter((x) => (!q.startTime || (x.lastVisitTime || 0) >= q.startTime) && (!text || (x.title || '').toLowerCase().includes(text) || x.url.toLowerCase().includes(text)))
        .slice(0, q.maxResults ?? 100));
    }),
    deleteUrl: vi.fn(async () => {}),
  },
  alarms: {
    create: vi.fn(async (name, info) => { D.alarms.set(name, { name, scheduledTime: info.when ?? Date.now() + (info.delayInMinutes || 0) * 60000 }); }),
    clear: vi.fn(async (name) => D.alarms.delete(name)),
    get: vi.fn(async (name) => clone(D.alarms.get(name))),
    getAll: vi.fn(async () => clone([...D.alarms.values()])),
    onAlarm: event(),
  },
  commands: {
    getAll: vi.fn(async () => Object.entries(MANIFEST.commands || {}).map(([name, c]) => ({ name, description: c.description, shortcut: (c.suggested_key && c.suggested_key.default) || '' }))),
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
  i18n: { getUILanguage: vi.fn(() => D.lang), getMessage: vi.fn((k) => k) },
};

// ---- test helpers
chrome._data = D;
chrome._addWindow = (p) => makeWindow(p);
chrome._addTab = (p) => makeTab(p);
chrome._addGroup = (p) => makeGroup(p);
chrome._addBookmark = (p) => {
  const parent = findMark(p.parentId ?? '2');
  const n = { id: String(p.id ?? D.nextMark++), parentId: parent.id, title: p.title || '', dateAdded: p.dateAdded ?? Date.now() };
  if (p.url) n.url = p.url; else n.children = [];
  parent.children.push(n);
  return n;
};
chrome._findBookmark = (id) => findMark(id);
chrome._clearListeners = () => events.forEach((ev) => ev._listeners.clear());
chrome._reset = () => {
  for (const a of [chrome.storage.local, chrome.storage.session, chrome.storage.sync]) a._data.clear();
  Object.assign(D, { tabs: [], windows: [], groups: [], nextTab: 1, nextWin: 1, nextGroup: 1, bookmarks: freshBookmarks(), nextMark: 100, history: [], closed: [], lang: 'en' });
  D.alarms.clear();
  D.zoom.clear();
  chrome.runtime.lastError = undefined;
  // mockReset also undoes a test's mockImplementation (vitest 3+: back to the original implementation)
  const walk = (o) => { for (const v of Object.values(o)) { if (typeof v === 'function' && v.mock) v.mockReset(); else if (v && typeof v === 'object' && !(v instanceof Map) && v !== D) walk(v); } };
  walk(chrome);
};
chrome._reset();

globalThis.chrome = chrome;
beforeEach(() => chrome._reset());
