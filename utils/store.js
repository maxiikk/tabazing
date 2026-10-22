// Two storage areas, on purpose:
//   - chrome.storage.session: MRU order, overlay flag, launch token. Kept in
//     memory only, wiped when the browser closes, readable only by extension
//     pages - never by content scripts or websites.
//   - chrome.storage.local: tab previews, keyed by normalized URL (tab IDs
//     don't survive a restart). Written to disk, kept 7 days, capped by count
//     and size. Images never leave the device: nothing here touches the network.
//
// Values are still validated on every read. Nothing untrusted can write here
// today, but a bug elsewhere shouldn't be able to turn bad data into bad
// behaviour.

import { KEY, LIMITS, SNOOZE_ALARM, previewKey, sharpKey, tabMetaKey, PREVIEW_PREFIX, WINDOW_STATES, MODES } from './constants.js';
import { normalizeUrl, isWorthReopening } from './extension.js';
import { emptyReview } from './review.js';
import { isAccent, DEFAULT_ACCENT } from './accent.js';
import { getArchived } from './archive.js';
import { cleanGroup } from './groups.js';
import { LANGS } from './i18n.js';

const sessionArea = chrome.storage.session;
const localArea = chrome.storage.local;

// Every read-modify-write goes through one queue so concurrent events
// (e.g. onActivated + onRemoved firing together) can't lose updates.
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// Same, but across contexts: the worker and the switcher page both write some
// keys, and Web Locks are shared by every page of the extension.
export function withLock(name, task) {
  return navigator.locks ? navigator.locks.request('tabazing:' + name, task) : serial(task);
}

// ---------- validation ----------
const isId = (value) => Number.isInteger(value) && value >= 0;
const isTime = (value) => Number.isFinite(value) && value > 0;
const isImage = (value) => typeof value === 'string' && value.startsWith(PREVIEW_PREFIX) && value.length < 4 * 1024 * 1024; // a sharp copy is ~0.2-0.6 MB
const isPreview = (preview) => !!preview && typeof preview === 'object' && isImage(preview.img) && isTime(preview.t);

// The preview index: { [normalizedUrl]: { t: capturedAt, n: imageLength, s: last time an open tab had this URL } }.
// `s` is optional on read (older entries): it then counts as `t`.
function cleanIndex(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      if (key && key.length <= LIMITS.MAX_URL_KEY && entry && isTime(entry.t) && Number.isFinite(entry.n) && entry.n >= 0) out[key] = { t: entry.t, n: entry.n, s: isTime(entry.s) ? entry.s : entry.t };
    }
  }
  return out;
}

// ---------- MRU ----------
export async function getMru() {
  const stored = (await sessionArea.get(KEY.MRU))[KEY.MRU];
  return Array.isArray(stored) ? stored.filter(isId).slice(0, LIMITS.MAX_MRU) : [];
}
export function touchMru(tabId) {
  return serial(async () => {
    const mru = (await getMru()).filter((id) => id !== tabId);
    mru.unshift(tabId);
    await sessionArea.set({ [KEY.MRU]: mru.slice(0, LIMITS.MAX_MRU) });
  });
}
export function removeFromMru(tabId) {
  return serial(async () => {
    await sessionArea.set({ [KEY.MRU]: (await getMru()).filter((id) => id !== tabId) });
  });
}
export function replaceInMru(oldId, newId) {
  return serial(async () => {
    const mru = (await getMru()).filter((id) => id !== newId).map((id) => (id === oldId ? newId : id));
    await sessionArea.set({ [KEY.MRU]: mru });
  });
}
export function seedMru(tabIds) {
  return serial(async () => {
    if (!(await getMru()).length) await sessionArea.set({ [KEY.MRU]: tabIds.filter(isId) });
  });
}

// ---------- previews (storage.local, keyed by normalized URL) ----------
const keyOf = (url) => {
  const key = normalizeUrl(url);
  return key && key.length <= LIMITS.MAX_URL_KEY ? key : '';
};

// Previews have no expiry on read: cleanupPreviews() is the only thing that
// deletes them, and it never touches a URL an open tab still has.
export async function getPreview(url) {
  const key = keyOf(url);
  if (!key) return null;
  const stored = (await localArea.get(previewKey(key)))[previewKey(key)];
  return isPreview(stored) ? stored : null;
}

// When each page's preview was taken: url -> time (0: none). One read of the index, not of the images.
export async function previewTimes() {
  const index = cleanIndex((await localArea.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX]);
  return (url) => { const entry = index[keyOf(url)]; return entry ? entry.t : 0; };
}

// Is the page's preview at most `ms` old? Asked on every Alt+Q, so it is answered from the saves this
// context made itself (only the worker saves previews) rather than by reading a ~40 KB image. Only a
// context younger than `ms` can have missed a save that recent: that one reads storage.
// A time "in the future" (the system clock was set back since) counts as long ago: not fresh.
const loadedAt = Date.now();
const savedAt = new Map(); // normalized url -> capture time, latest saves only
const within = (age, milliseconds) => age >= 0 && age <= milliseconds;
export async function previewFresh(url, milliseconds) {
  const key = keyOf(url);
  if (!key) return false;
  const now = Date.now();
  if (savedAt.has(key)) return within(now - savedAt.get(key), milliseconds);
  if (!within(now - loadedAt, milliseconds)) return false;
  const preview = await getPreview(url);
  return !!preview && within(now - preview.t, milliseconds);
}
function noteSaved(key, capturedAt) {
  savedAt.delete(key);
  savedAt.set(key, capturedAt);
  if (savedAt.size > 50) savedAt.delete(savedAt.keys().next().value); // a few seconds' worth at most
}

// Returns { [normalizedUrl]: { img, t } } for the URLs that have a preview.
// Look entries up with normalizeUrl(url).
export async function getPreviews(urls) {
  const keys = [...new Set(urls.map(keyOf).filter(Boolean))];
  if (!keys.length) return {};
  const retrieved = await localArea.get(keys.map(previewKey));
  const out = {};
  for (const key of keys) {
    const candidate = retrieved[previewKey(key)];
    if (isPreview(candidate)) out[key] = candidate;
  }
  return out;
}

// URLs that open tabs have right now (null if Chrome can't tell us). A preview
// for one of these is kept as long as the tab is open, however old it is.
// Starred and archived pages count as open: their previews are kept even while no tab shows them.
async function openKeys() {
  try {
    const [tabs, stars, archived] = await Promise.all([chrome.tabs.query({ windowType: 'normal' }), getStars(), getArchived()]);
    return new Set([...tabs.map((tab) => keyOf(tab.url || tab.pendingUrl)).filter(Boolean), ...Object.keys(stars), ...archived.map((entry) => keyOf(entry.url)).filter(Boolean)]);
  } catch {
    return null;
  }
}

// openKeys() at most once, and only if asked: a save may need it for both its caps and its sharp copy.
function lazyOpenKeys() {
  let cached = null;
  return () => (cached = cached || openKeys());
}

const seen = (entry) => Math.max(entry.t, entry.s);

// Who goes first when over a cap: previews no open tab uses (oldest first),
// then previews open tabs use (oldest capture first). `keep` is never listed.
function evictionOrder(index, open, keep) {
  const used = (key) => open.has(key);
  return Object.keys(index)
    .filter((key) => key !== keep)
    .sort((firstKey, secondKey) => (used(firstKey) - used(secondKey)) || (used(firstKey) ? index[firstKey].t - index[secondKey].t : seen(index[firstKey]) - seen(index[secondKey])));
}

const PREVIEW_LIMITS = { count: LIMITS.MAX_PREVIEWS, bytes: LIMITS.MAX_PREVIEW_BYTES };
const SHARP_LIMITS = { count: LIMITS.MAX_SHARP, bytes: LIMITS.MAX_SHARP_BYTES };
const overLimit = (index, caps = PREVIEW_LIMITS) => {
  const keys = Object.keys(index);
  return keys.length > caps.count || keys.reduce((sum, key) => sum + index[key].n, 0) > caps.bytes;
};

// Keys to delete so the cache fits both caps.
function overflow(index, open, keep, caps = PREVIEW_LIMITS) {
  let count = Object.keys(index).length;
  let bytes = Object.keys(index).reduce((sum, key) => sum + index[key].n, 0);
  const out = [];
  for (const key of evictionOrder(index, open, keep)) {
    if (count <= caps.count && bytes <= caps.bytes) break;
    out.push(key);
    count--;
    bytes -= index[key].n;
  }
  return out;
}

export function savePreview(url, data) {
  const key = keyOf(url);
  if (!key || !isPreview(data)) return Promise.resolve();
  const saved = serial(async () => {
    const getOpen = lazyOpenKeys();
    const index = cleanIndex((await localArea.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX]);
    index[key] = { t: data.t, n: data.img.length, s: Date.now() }; // a tab with this URL is open right now
    const open = overLimit(index) ? (await getOpen()) || new Set([key]) : new Set([key]);
    const evict = overflow(index, open, key);
    evict.forEach((evictedKey) => delete index[evictedKey]);
    if (evict.length) await localArea.remove(evict.map(previewKey));
    const write = () => localArea.set({ [previewKey(key)]: { img: data.img, t: data.t }, [KEY.PREVIEW_INDEX]: index });
    try {
      await write();
    } catch {
      // Quota exceeded: drop the first half of the eviction order, then try once more.
      const order = evictionOrder(index, (await getOpen()) || new Set(), key);
      const old = order.slice(0, Math.ceil(order.length / 2));
      old.forEach((evictedKey) => delete index[evictedKey]);
      await localArea.remove(old.map(previewKey));
      await write();
      evict.push(...old);
    }
    noteSaved(key, data.t);
    await saveSharp(key, isImage(data.sharp) ? { img: data.sharp, t: data.t } : null, index, getOpen);
  });
  saved.then(maybeCleanup).catch(() => {});
  return saved;
}

// The sharp copy of a capture (shown in the big preview). It lives exactly as long as its small copy
// (`idx`, the small previews' index, after any eviction) and has caps of its own: over them, those of
// closed tabs go first, then the oldest. A capture without a sharp copy drops the older sharp one.
// `getOpen` is the caller's openKeys(), so one save asks Chrome for the open tabs once.
async function saveSharp(key, sharp, index, getOpen) {
  const sharpIndex = cleanIndex((await localArea.get(KEY.SHARP_INDEX))[KEY.SHARP_INDEX]);
  const drop = Object.keys(sharpIndex).filter((entryKey) => !index[entryKey] || (entryKey === key && !sharp));
  drop.forEach((entryKey) => delete sharpIndex[entryKey]);
  if (sharp) sharpIndex[key] = { t: sharp.t, n: sharp.img.length, s: Date.now() };
  const open = overLimit(sharpIndex, SHARP_LIMITS) ? (await getOpen()) || new Set([key]) : new Set([key]);
  const over = overflow(sharpIndex, open, key, SHARP_LIMITS);
  over.forEach((entryKey) => delete sharpIndex[entryKey]);
  drop.push(...over);
  if (drop.length) await localArea.remove(drop.map(sharpKey));
  try {
    await localArea.set({ [KEY.SHARP_INDEX]: sharpIndex, ...(sharp ? { [sharpKey(key)]: sharp } : {}) });
  } catch { // no room: the cards' copy is what matters, so give up the sharp one
    delete sharpIndex[key];
    await localArea.set({ [KEY.SHARP_INDEX]: sharpIndex }).catch(() => {});
  }
}
// The big preview: the sharp copy of a page's latest capture, or null (then the small one is shown).
export async function getSharpPreview(url) {
  const key = keyOf(url);
  if (!key) return null;
  const stored = (await localArea.get(sharpKey(key)))[sharpKey(key)];
  return isPreview(stored) ? stored : null;
}

// Delete previews that no open tab uses and that are older than 7 days (counted
// from the last capture or the last time an open tab had that URL), then trim
// to the count and size caps. Previews of open tabs are never expired.
export function cleanupPreviews() {
  return serial(async () => {
    const open = await openKeys();
    if (!open) return; // can't tell which previews are in use: don't delete anything
    const index = cleanIndex((await localArea.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX]);
    const now = Date.now();
    for (const key of open) if (index[key]) index[key].s = now;
    const drop = Object.keys(index).filter((key) => !open.has(key) && seen(index[key]) <= now - LIMITS.PREVIEW_TIME_TO_LIVE_MILLISECONDS);
    drop.forEach((key) => delete index[key]);
    const extra = overflow(index, open, '');
    extra.forEach((key) => delete index[key]);
    drop.push(...extra);
    if (drop.length) await localArea.remove(drop.map(previewKey));
    await localArea.set({ [KEY.PREVIEW_INDEX]: index, [KEY.PREVIEW_CLEANUP]: now });
    await saveSharp('', null, index, async () => open); // the sharp copies follow
  });
}

// Called after every saved preview (i.e. on tab switches): run the cleanup at
// most every 6 hours, and never in the first minute after the browser starts,
// when Chrome may still be restoring tabs (their URLs must count as "open").
let cleaning = false;
async function maybeCleanup() {
  if (cleaning) return;
  const [boot, last] = await Promise.all([sessionArea.get(KEY.BOOT_AT), localArea.get(KEY.PREVIEW_CLEANUP)]);
  const now = Date.now();
  if (now - (boot[KEY.BOOT_AT] || 0) < LIMITS.CLEANUP_BOOT_DELAY_MILLISECONDS) return;
  if (now - (last[KEY.PREVIEW_CLEANUP] || 0) < LIMITS.CLEANUP_EVERY_MILLISECONDS) return;
  cleaning = true;
  try { await cleanupPreviews(); } finally { cleaning = false; }
}
export const markBoot = () => sessionArea.set({ [KEY.BOOT_AT]: Date.now() });
// storage.session is empty at the start of every browser session (and after an extension
// update/reload), so the first worker start that finds no marker is the start of the session.
// This backs up runtime.onStartup, which doesn't fire for every way an extension gets loaded.
export async function ensureBoot() {
  if (!(await sessionArea.get(KEY.BOOT_AT))[KEY.BOOT_AT]) await markBoot();
}

// ---------- tabs Chrome has discarded (storage.session) ----------
// tab.discarded is also true for tabs Chrome restores lazily after a restart, which
// aren't "sleeping" in any useful sense. A tab is only shown as Sleeping if we saw
// Chrome discard it during this browser session; storage.session survives the
// service worker being suspended and is wiped on browser restart, like tab ids.
export async function getSlept() {
  const stored = (await sessionArea.get(KEY.SLEPT))[KEY.SLEPT];
  return Array.isArray(stored) ? stored.filter(isId) : [];
}
export function markDiscarded(tabId, discarded) {
  if (!isId(tabId)) return Promise.resolve();
  return serial(async () => {
    const sleptTabs = await getSlept();
    const wasSlept = sleptTabs.includes(tabId);
    if (discarded === wasSlept) return;
    await sessionArea.set({ [KEY.SLEPT]: discarded ? [...sleptTabs, tabId].slice(-LIMITS.MAX_SLEPT) : sleptTabs.filter((id) => id !== tabId) });
  });
}
export function moveDiscarded(oldId, newId) {
  if (!isId(oldId) || !isId(newId)) return Promise.resolve();
  return serial(async () => {
    const sleptTabs = await getSlept();
    if (!sleptTabs.includes(oldId)) return;
    await sessionArea.set({ [KEY.SLEPT]: [...sleptTabs.filter((id) => id !== oldId && id !== newId), newId] });
  });
}

// ---------- closed-tab log (storage.local) ----------
// chrome.sessions only remembers the last 25 closed items, so we keep our own
// 7-day log. tabs.onRemoved doesn't say what the tab was, so we remember each
// open tab's url/title/icon in storage.session (memory only) as it changes,
// and move it into the log when the tab closes.
const isLoggableUrl = (url) => typeof url === 'string' && url.length <= LIMITS.MAX_URL_KEY && /^(https?|file|ftp|chrome):/.test(url);
const isClosedEntry = (entry) => !!entry && typeof entry === 'object' && isLoggableUrl(entry.url) && typeof entry.title === 'string'
  && typeof entry.favIconUrl === 'string' && isTime(entry.closedAt);

function cleanLog(raw) {
  const cutoff = Date.now() - LIMITS.CLOSED_LOG_TIME_TO_LIVE_MILLISECONDS;
  return Array.isArray(raw) ? raw.filter((entry) => isClosedEntry(entry) && entry.closedAt > cutoff).slice(0, LIMITS.MAX_CLOSED_LOG) : [];
}

export async function getClosedLog() {
  return cleanLog((await localArea.get(KEY.CLOSED_LOG))[KEY.CLOSED_LOG]);
}

const lastMeta = new Map(); // tabId -> last JSON written, to skip repeat writes (lost on worker restart: harmless)
// `group`: the tab group it is in ({ id, title, color }, utils/groups.js), so a tab reopened from the log goes back in it.
const metaOf = (tab, group = null) => {
  const url = (tab && (tab.url || tab.pendingUrl)) || '';
  if (!tab || !isId(tab.id) || tab.incognito || !isLoggableUrl(url) || !isWorthReopening(url)) return null;
  const icon = typeof tab.favIconUrl === 'string' && /^https?:/.test(tab.favIconUrl) && tab.favIconUrl.length <= 512 ? tab.favIconUrl : '';
  const cleanedGroup = tab.groupId >= 0 ? cleanGroup(group) : null;
  return { u: url, ti: String(tab.title || '').slice(0, 300), f: icon, ...(cleanedGroup ? { g: cleanedGroup } : {}) };
};

// Call whenever a tab's url, title, icon or group may have changed. A tab now on a page that isn't logged
// (New Tab, about:blank, our own pages...) forgets the page it showed before: closing it now closes nothing worth logging.
export function rememberTab(tab, group = null) {
  const meta = metaOf(tab, group);
  if (!meta) {
    if (!tab || !isId(tab.id) || lastMeta.get(tab.id) === '') return Promise.resolve();
    lastMeta.set(tab.id, ''); // '': known to have nothing stored
    return serial(() => sessionArea.remove(tabMetaKey(tab.id)));
  }
  const json = JSON.stringify(meta);
  if (lastMeta.get(tab.id) === json) return Promise.resolve();
  lastMeta.set(tab.id, json);
  return serial(() => sessionArea.set({ [tabMetaKey(tab.id)]: meta }));
}

// `groups`: id -> group, for the tabs that are in one.
export function rememberTabs(tabs, groups = new Map()) {
  const writes = {};
  for (const tab of tabs) {
    const meta = metaOf(tab, groups.get(tab.groupId));
    if (meta) { writes[tabMetaKey(tab.id)] = meta; lastMeta.set(tab.id, JSON.stringify(meta)); }
  }
  return serial(() => sessionArea.set(writes));
}

export function forgetTabMeta(tabId) {
  lastMeta.delete(tabId);
  return serial(() => sessionArea.remove(tabMetaKey(tabId)));
}

// A tab was closed: add it to the log (newest first, one entry per page). Closing a window or "close
// others" closes dozens of tabs at once, so closes are gathered for CLOSE_BATCH_MILLISECONDS and written in one go
// (one read and one write of the log, each entry's URL normalized once). Resolves once written.
const CLOSE_BATCH_MILLISECONDS = 100;
let closing = []; // [{ tabId, at }] waiting to be logged
let closeBatch = null; // { timer, done } while some are
export function logClosedTab(tabId) {
  lastMeta.delete(tabId);
  closing.push({ tabId, at: Date.now() });
  if (!closeBatch) {
    let done;
    const written = new Promise((resolve) => { done = resolve; });
    closeBatch = { timer: setTimeout(flushClosedTabs, CLOSE_BATCH_MILLISECONDS), done, written };
  }
  return closeBatch.written;
}

// Write the waiting closes now (the batch timer, or the worker about to be suspended).
export function flushClosedTabs() {
  if (!closeBatch) return Promise.resolve();
  const { timer, done } = closeBatch;
  clearTimeout(timer);
  const batch = closing;
  closing = [];
  closeBatch = null;
  const run = serial(async () => {
    const keys = batch.map((close) => tabMetaKey(close.tabId));
    const metas = await sessionArea.get(keys);
    const known = keys.filter((key) => metas[key]); // the rest: never seen (opened and closed instantly), or a blank/own page
    if (!known.length) return;
    await sessionArea.remove(known);
    const add = batch.map((close) => ({ m: metas[tabMetaKey(close.tabId)], at: close.at })).filter(({ m: meta }) => meta && typeof meta === 'object' && isLoggableUrl(meta.u));
    if (!add.length) return;
    let log = cleanLog((await localArea.get(KEY.CLOSED_LOG))[KEY.CLOSED_LOG]).map((entry) => ({ e: entry, k: normalizeUrl(entry.url) }));
    for (const { m: meta, at } of add) { // in closing order, as if each were written on its own
      const key = normalizeUrl(meta.u);
      log = log.filter((x) => x.k !== key);
      const group = cleanGroup(meta.g);
      log.unshift({ e: { url: meta.u, title: typeof meta.ti === 'string' ? meta.ti : '', favIconUrl: typeof meta.f === 'string' ? meta.f : '', closedAt: at, ...(group ? { group } : {}) }, k: key });
      log = log.slice(0, LIMITS.MAX_CLOSED_LOG);
    }
    await localArea.set({ [KEY.CLOSED_LOG]: log.map((x) => x.e) });
  });
  done(run);
  return run;
}

// Run once at browser start and after install/update: drop entries older than 7 days, cap the size.
export function cleanupClosedLog() {
  return serial(async () => {
    const raw = (await localArea.get(KEY.CLOSED_LOG))[KEY.CLOSED_LOG];
    const log = cleanLog(raw);
    if (!Array.isArray(raw) || log.length !== raw.length) await localArea.set({ [KEY.CLOSED_LOG]: log });
  });
}

// ---------- review prompt counters (storage.local, this device only) ----------
const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
function cleanReview(raw) {
  const empty = emptyReview();
  if (!raw || typeof raw !== 'object') return empty;
  return {
    since: isTime(raw.since) ? raw.since : empty.since, opens: count(raw.opens), soft: count(raw.soft), lastSoft: count(raw.lastSoft),
    asks: count(raw.asks), lastAsk: count(raw.lastAsk), done: raw.done === true,
    day: typeof raw.day === 'string' && raw.day.length <= 12 ? raw.day : '',
  };
}
export async function getReview() {
  return cleanReview((await localArea.get(KEY.REVIEW))[KEY.REVIEW]);
}
// `change` gets the current counters and returns the new ones.
export function updateReview(change) {
  return withLock('review', async () => {
    const next = cleanReview(change(await getReview()));
    await localArea.set({ [KEY.REVIEW]: next });
    return next;
  });
}

// ---------- first-run flags (storage.local) ----------
export async function getOnboard() {
  const stored = (await localArea.get(KEY.ONBOARD))[KEY.ONBOARD];
  return { at: stored && isTime(stored.at) ? stored.at : 0, flyout: !!(stored && stored.flyout), tour: !!(stored && stored.tour) };
}
export function updateOnboard(patch) {
  return withLock('onboard', async () => {
    const next = { ...(await getOnboard()), ...patch };
    await localArea.set({ [KEY.ONBOARD]: next });
    return next;
  });
}

// ---------- snoozed tabs (storage.local) ----------
// Closed for now and reopened at `at` by the background (one chrome.alarms alarm, set to the soonest).
const isSnooze = (value) => !!value && typeof value === 'object' && typeof value.id === 'string' && typeof value.url === 'string' && value.url.length <= LIMITS.MAX_URL_KEY && isTime(value.at);
export async function getSnoozed() {
  const stored = (await localArea.get(KEY.SNOOZED))[KEY.SNOOZED];
  return Array.isArray(stored) ? stored.filter(isSnooze).map((x) => ({ id: x.id, url: x.url, title: String(x.title || '').slice(0, 300), at: x.at, windowId: isId(x.windowId) ? x.windowId : null, pinned: x.pinned === true, t: isTime(x.t) ? x.t : x.at, group: cleanGroup(x.group) })) : [];
}
async function scheduleSnoozeAlarm(list) {
  if (!chrome.alarms) return;
  if (!list.length) { await chrome.alarms.clear(SNOOZE_ALARM).catch(() => {}); return; }
  await chrome.alarms.create(SNOOZE_ALARM, { when: Math.max(Date.now() + 1000, Math.min(...list.map((x) => x.at))) }).catch(() => {});
}
// Each returns the list as it is afterwards.
export function addSnoozed(items) {
  return withLock('snoozed', async () => {
    const list = [...(await getSnoozed()), ...items.filter(isSnooze)].slice(-LIMITS.MAX_SNOOZED);
    await localArea.set({ [KEY.SNOOZED]: list });
    await scheduleSnoozeAlarm(list);
    return list;
  });
}
export function removeSnoozed(ids) {
  return withLock('snoozed', async () => {
    const list = (await getSnoozed()).filter((x) => !ids.includes(x.id));
    await localArea.set({ [KEY.SNOOZED]: list });
    await scheduleSnoozeAlarm(list);
    return list;
  });
}
// A restore (utils/backup.js): snoozed tabs added unless one of the same page is snoozed already; none that is there
// goes, so what doesn't fit under the cap is left out. Resolves to { added, updated, skipped }.
export function mergeSnoozed(items) {
  return withLock('snoozed', async () => {
    const list = await getSnoozed();
    const have = new Set(list.map((x) => keyOf(x.url) || x.url));
    const out = { added: 0, updated: 0, skipped: 0 };
    for (const x of items) {
      const key = keyOf(x.url) || x.url;
      if (!isSnooze(x) || have.has(key) || list.length >= LIMITS.MAX_SNOOZED) { out.skipped++; continue; }
      list.push(x);
      have.add(key);
      out.added++;
    }
    if (out.added) { await localArea.set({ [KEY.SNOOZED]: list }); await scheduleSnoozeAlarm(list); }
    return out;
  });
}
// The background, when the alarm goes off (or at start-up, for any that came due while Chrome was closed).
// `max`: take at most this many (the background takes one at a time, so a worker stopped halfway loses none
// it hadn't opened yet); `skip`: ids not to take (ones that already failed to open in this run).
export function takeDueSnoozed(now = Date.now(), { max: maximum = Infinity, skip = [] } = {}) {
  return withLock('snoozed', async () => {
    const list = await getSnoozed();
    const due = list.filter((x) => x.at <= now && !skip.includes(x.id)).slice(0, maximum);
    const rest = list.filter((x) => !due.includes(x));
    if (due.length) await localArea.set({ [KEY.SNOOZED]: rest });
    await scheduleSnoozeAlarm(rest);
    return due;
  });
}
// A due tab that could not be reopened goes back into the list, as it was (same id), for the next alarm to
// try again. One that is there already (put back twice, or snoozed again meanwhile) is not doubled.
export function putBackSnoozed(item) {
  return withLock('snoozed', async () => {
    const list = await getSnoozed();
    if (!isSnooze(item) || list.some((x) => x.id === item.id)) return list;
    list.push(item);
    await localArea.set({ [KEY.SNOOZED]: list });
    await scheduleSnoozeAlarm(list);
    return list;
  });
}

// ---------- woken snoozed tabs (storage.session) ----------
// Snoozed tabs reopen in the background, unannounced: the switcher tags them "Back from snooze" until
// they have been looked at (forgetWoken on activation) or for a day at most.
export async function getWoken(now = Date.now()) {
  const stored = (await sessionArea.get(KEY.WOKEN))[KEY.WOKEN];
  const out = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, at] of Object.entries(stored)) if (/^\d{1,10}$/.test(key) && isTime(at) && now - at < LIMITS.WOKEN_TIME_TO_LIVE_MILLISECONDS) out[key] = at;
  }
  return out;
}
export function markWoken(tabId, at = Date.now()) {
  if (!isId(tabId)) return Promise.resolve();
  return serial(async () => { await sessionArea.set({ [KEY.WOKEN]: { ...(await getWoken()), [tabId]: at } }); });
}
// Seen or closed. Writes only when the tab was there (this runs on every tab switch).
export function forgetWoken(tabId) {
  return serial(async () => {
    const all = await getWoken();
    if (!(tabId in all)) return;
    delete all[tabId];
    await sessionArea.set({ [KEY.WOKEN]: all });
  });
}

// ---------- notes on tabs (storage.local) ----------
// Keyed by normalized URL, like stars, so a note survives a restart (tab ids don't).
export async function getNotes() {
  const stored = (await localArea.get(KEY.NOTES))[KEY.NOTES];
  const out = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, entry] of Object.entries(stored)) {
      if (key && entry && typeof entry.n === 'string' && entry.n && isTime(entry.t)) out[key] = { u: String(entry.u || '').slice(0, LIMITS.MAX_URL_KEY), n: entry.n.slice(0, LIMITS.NOTE_MAX), t: entry.t };
    }
  }
  return out;
}
// Set the note on a page; empty text removes it. Returns every note.
export function setNote(url, text) {
  const key = keyOf(url);
  const note = String(text || '').trim().slice(0, LIMITS.NOTE_MAX);
  return withLock('notes', async () => {
    const notes = await getNotes();
    if (!key || (notes[key] ? notes[key].n === note : !note)) return notes; // nothing changed
    if (note) notes[key] = { u: url, n: note, t: Date.now() }; else delete notes[key];
    Object.keys(notes).sort((firstKey, secondKey) => notes[secondKey].t - notes[firstKey].t).slice(LIMITS.MAX_NOTES).forEach((x) => delete notes[x]);
    await localArea.set({ [KEY.NOTES]: notes });
    return notes;
  });
}

// A restore: these notes ([{ url, note, t }]) on their pages, over the ones there; a page without a note gets one while
// there is room (no note that is there goes). Empty ones are left out, and a second one for the same page (only the
// first counts). A note keeps its time `t` (when it was written), if it has one. Resolves to { added, updated, skipped }.
export function mergeNotes(items) {
  return withLock('notes', async () => {
    const notes = await getNotes();
    const out = { added: 0, updated: 0, skipped: 0 };
    const seen = new Set();
    let count = Object.keys(notes).length;
    for (const x of items) {
      const key = keyOf(x.url);
      const note = String(x.note || '').trim().slice(0, LIMITS.NOTE_MAX);
      if (!key || !note || seen.has(key)) { out.skipped++; continue; }
      seen.add(key);
      const time = isTime(x.t) && x.t <= Date.now() ? x.t : Date.now();
      if (notes[key]) { if (notes[key].n === note) out.skipped++; else { notes[key] = { u: x.url, n: note, t: time }; out.updated++; } continue; }
      if (count >= LIMITS.MAX_NOTES) { out.skipped++; continue; }
      notes[key] = { u: x.url, n: note, t: time };
      count++;
      out.added++;
    }
    if (out.added || out.updated) await localArea.set({ [KEY.NOTES]: notes });
    return out;
  });
}

// ---------- notes on bookmarks (storage.local) ----------
// Keyed by the bookmark's id, not by an address: a bookmark's note stays with that bookmark (when its address is
// edited too), and has nothing to do with the note on a tab, which is about the page the tab shows.
export async function getBookmarkNotes() {
  const stored = (await localArea.get(KEY.BOOKMARK_NOTES))[KEY.BOOKMARK_NOTES];
  const out = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [id, entry] of Object.entries(stored)) {
      if (/^\w{1,40}$/.test(id) && entry && typeof entry.n === 'string' && entry.n && isTime(entry.t)) out[id] = { u: String(entry.u || '').slice(0, LIMITS.MAX_URL_KEY), n: entry.n.slice(0, LIMITS.NOTE_MAX), t: entry.t };
    }
  }
  return out;
}
// Set several bookmarks' notes at once: { [id]: { n, u } } (an empty text, or null, removes that one). Returns every note.
// Kept on this computer only, as every other note.
export function putBookmarkNotes(changes) {
  return withLock('bmNotes', async () => {
    const notes = await getBookmarkNotes();
    for (const [id, change] of Object.entries(changes || {})) {
      const note = String((change && change.n) || '').trim().slice(0, LIMITS.NOTE_MAX);
      const url = String((change && change.u) || (notes[id] && notes[id].u) || '').slice(0, LIMITS.MAX_URL_KEY);
      if (note) notes[id] = { u: url, n: note, t: Date.now() }; else delete notes[id];
    }
    Object.keys(notes).sort((firstKey, secondKey) => notes[secondKey].t - notes[firstKey].t).slice(LIMITS.MAX_NOTES).forEach((x) => delete notes[x]);
    await localArea.set({ [KEY.BOOKMARK_NOTES]: notes });
    return notes;
  });
}
export const setBookmarkNote = (id, text, url = '') => putBookmarkNotes({ [id]: { n: text, u: url } });
// A restore: these notes ({ [id]: { n, u, t } }) on their bookmarks, over the ones there; none that is there goes (no
// trimming: what doesn't fit is left out). A note keeps its time `t`, if it has one. Resolves to { added, updated, skipped }.
export function mergeBookmarkNotes(changes) {
  return withLock('bmNotes', async () => {
    const notes = await getBookmarkNotes();
    const out = { added: 0, updated: 0, skipped: 0 };
    let count = Object.keys(notes).length;
    for (const [id, change] of Object.entries(changes || {})) {
      const note = String((change && change.n) || '').trim().slice(0, LIMITS.NOTE_MAX);
      if (!/^\w{1,40}$/.test(id) || !note) { out.skipped++; continue; }
      const url = String((change && change.u) || '').slice(0, LIMITS.MAX_URL_KEY);
      const time = change && isTime(change.t) && change.t <= Date.now() ? change.t : Date.now();
      if (notes[id]) { if (notes[id].n === note) out.skipped++; else { notes[id] = { u: url, n: note, t: time }; out.updated++; } continue; }
      if (count >= LIMITS.MAX_NOTES) { out.skipped++; continue; }
      notes[id] = { u: url, n: note, t: time };
      count++;
      out.added++;
    }
    if (out.added || out.updated) await localArea.set({ [KEY.BOOKMARK_NOTES]: notes });
    return out;
  });
}

// ---------- stars (storage.local) ----------
// Pages the user starred, keyed by normalized URL (tab ids don't survive a restart).
// Not bookmarks: they live only in Tabazing, on this computer.
const isStar = (value) => !!value && typeof value === 'object' && typeof value.u === 'string' && value.u.length <= LIMITS.MAX_URL_KEY && isTime(value.t);
export async function getStars() {
  const stored = (await localArea.get(KEY.STARS))[KEY.STARS];
  const out = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, entry] of Object.entries(stored)) if (key && isStar(entry)) out[key] = { u: entry.u, ti: String(entry.ti || '').slice(0, 300), t: entry.t };
  }
  return out;
}
// A restore: these pages ([{ url, title, t }]) starred unless they are already; no star that is there goes (what doesn't
// fit under the cap is left out). Resolves to { added, updated, skipped }.
export function mergeStars(items) {
  return withLock('stars', async () => {
    const stars = await getStars();
    const out = { added: 0, updated: 0, skipped: 0 };
    let count = Object.keys(stars).length;
    for (const x of items) {
      const key = keyOf(x.url);
      if (!key || stars[key] || count >= LIMITS.MAX_STARS || x.url.length > LIMITS.MAX_URL_KEY) { out.skipped++; continue; }
      stars[key] = { u: x.url, ti: String(x.title || '').slice(0, 300), t: isTime(x.t) ? x.t : Date.now() };
      count++;
      out.added++;
    }
    if (out.added) await localArea.set({ [KEY.STARS]: stars });
    return out;
  });
}
// Star or unstar a page. Returns the new state (true = starred).
export function toggleStar(url, title) {
  const key = keyOf(url);
  if (!key) return Promise.resolve(false);
  return withLock('stars', async () => {
    const stars = await getStars();
    let on;
    if (stars[key]) { delete stars[key]; on = false; } else {
      stars[key] = { u: url, ti: String(title || '').slice(0, 300), t: Date.now() };
      on = true;
      const keys = Object.keys(stars).sort((firstKey, secondKey) => stars[secondKey].t - stars[firstKey].t);
      keys.slice(LIMITS.MAX_STARS).forEach((x) => delete stars[x]); // over the cap: the oldest stars go
    }
    await localArea.set({ [KEY.STARS]: stars });
    return on;
  });
}

// ---------- switcher layout (storage.local) ----------
export const SORTS = Object.freeze(['recent', 'order', 'name']);
export const SETTINGS_TABS = Object.freeze(['look', 'cards', 'search', 'behave', 'keys']); // Settings' categories
// Names the view's fields had before 6.16.6; read once more so the history's look and range and the open folders
// survive the update (the next updateView() writes the new names only).
const OLD_VIEW_NAMES = { histLayout: 'historyLayout', histRange: 'historyRange', bmvOpen: 'bookmarksViewOpen', bmvSel: 'bookmarksViewSelected' };
export async function getView() {
  const saved = (await localArea.get(KEY.VIEW))[KEY.VIEW] || {};
  const stored = { ...saved };
  for (const [oldName, name] of Object.entries(OLD_VIEW_NAMES)) if (!(name in stored) && oldName in stored) stored[name] = stored[oldName];
  return {
    sort: SORTS.includes(stored.sort) ? stored.sort : 'recent',
    collapsed: Array.isArray(stored.collapsed) ? stored.collapsed.filter((x) => typeof x === 'string' && x.length <= 300).slice(0, LIMITS.MAX_COLLAPSED) : [],
    settingsTab: SETTINGS_TABS.includes(stored.settingsTab) ? stored.settingsTab : 'look', // the category Settings last showed
    markFolder: typeof stored.markFolder === 'string' && /^\w{1,40}$/.test(stored.markFolder) ? stored.markFolder : '', // the bookmarks folder "Bookmark…" last saved into
    // the History and Bookmarks views: the history's look and time range, the open folders, the selected row (their
    // search boxes start empty each time)
    historyLayout: stored.historyLayout === 'grid' ? 'grid' : 'list',
    historyRange: ['all', 'today', 'week', 'month'].includes(stored.historyRange) ? stored.historyRange : 'all',
    bookmarksViewOpen: Array.isArray(stored.bookmarksViewOpen) ? stored.bookmarksViewOpen.filter((x) => typeof x === 'string' && /^\w{1,40}$/.test(x)).slice(-500) : [],
    bookmarksViewSelected: typeof stored.bookmarksViewSelected === 'string' && /^\w{1,40}$/.test(stored.bookmarksViewSelected) ? stored.bookmarksViewSelected : '',
  };
}
export function updateView(patch) {
  return withLock('view', async () => {
    const next = { ...(await getView()), ...patch };
    next.collapsed = next.collapsed.slice(-LIMITS.MAX_COLLAPSED);
    await localArea.set({ [KEY.VIEW]: next });
    return next;
  });
}

// ---------- the tab group the switcher is inside of (storage.session) ----------
// Set when a group's tile is opened, cleared when the group is left: until then every open shows that group.
// Chrome's group ids last one browser session, so this does too.
export async function getGroup() {
  const stored = (await sessionArea.get(KEY.GROUP))[KEY.GROUP];
  return stored && isId(stored.id) ? stored.id : null;
}
export const setGroup = (id) => (isId(id) ? sessionArea.set({ [KEY.GROUP]: { id, t: Date.now() } }) : sessionArea.remove(KEY.GROUP));

// ---------- "Recently closed" entries removed from the list (storage.local) ----------
// Chrome's own list of closed tabs can't be edited, so an entry removed from it is remembered here instead:
// { [key]: t } hides what was closed at or before `t` under that key (closedKey). Kept a month at most.
export const closedKey = (item) => (item.kind === 'window' ? 'w:' : '') + (keyOf(item.url) || item.url);
export async function getClosedHidden(now = Date.now()) {
  const stored = (await localArea.get(KEY.CLOSED_HIDDEN))[KEY.CLOSED_HIDDEN];
  const out = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, time] of Object.entries(stored)) if (key && key.length <= LIMITS.MAX_URL_KEY + 2 && isTime(time) && now - time < LIMITS.CLOSED_HIDDEN_TIME_TO_LIVE_MILLISECONDS) out[key] = time;
  }
  return out;
}
// `keys`: { [key]: t }, hide what was closed under each key at or before its t; with `show`, show those keys again.
export function hideClosed(keys, show = false) {
  return withLock('closedHidden', async () => {
    const all = await getClosedHidden();
    for (const [key, time] of Object.entries(keys)) { if (show) delete all[key]; else all[key] = Math.max(all[key] || 0, time); }
    const kept = Object.entries(all).sort((firstEntry, secondEntry) => secondEntry[1] - firstEntry[1]).slice(0, LIMITS.MAX_CLOSED_HIDDEN);
    await localArea.set({ [KEY.CLOSED_HIDDEN]: Object.fromEntries(kept) });
    return Object.fromEntries(kept);
  });
}

// ---------- settings (storage.local) ----------
export async function getPreferences() {
  return cleanPreferences((await localArea.get(KEY.PREFERENCES))[KEY.PREFERENCES] || {});
}
// Of these settings (a backup's), the ones with a valid value, as they are kept: { theme: 'purple', accent: '#abcdef' }
// gives { accent: '#ABCDEF' }. Unknown names are left out.
export function validPreferences(raw) {
  const base = cleanPreferences({}), out = {};
  for (const [key, x] of Object.entries(raw || {})) {
    if (!(key in base)) continue;
    const kept = cleanPreferences({ [key]: x })[key];
    if (kept !== base[key] || x === base[key]) out[key] = kept; // (an invalid value gives the default)
  }
  return out;
}
function cleanPreferences(raw) {
  const on = (x) => x !== false; // switches that default to on: only an explicit `false` turns one off
  return {
    lang: raw.lang === 'auto' || LANGS.includes(raw.lang) ? raw.lang : 'auto', startup: raw.startup === true,
    cardSize: ['small', 'list'].includes(raw.cardSize) ? raw.cardSize : 'default', accent: isAccent(raw.accent) ? raw.accent.toUpperCase() : DEFAULT_ACCENT,
    allWindows: raw.allWindows === true, theme: ['dark', 'light'].includes(raw.theme) ? raw.theme : 'system',
    pinnedFirst: on(raw.pinnedFirst), showClosed: on(raw.showClosed), showSnoozed: on(raw.showSnoozed), showAge: on(raw.showAge), showGroups: on(raw.showGroups), groupWrap: raw.groupWrap === true,
    ownWindow: raw.ownWindow === true, titleLines: raw.titleLines === 1 ? 1 : 2,
    searchHistory: on(raw.searchHistory), searchBookmarks: on(raw.searchBookmarks),
    lite: raw.lite === true, // Lite mode: no screenshots, no animations
    iconTips: Number.isInteger(raw.iconTips) && raw.iconTips >= 0 ? raw.iconTips : 0, // times the toolbar-icon tip was shown
  };
}
export function updatePreferences(patch) {
  return withLock('prefs', async () => {
    const next = { ...(await getPreferences()), ...patch };
    await localArea.set({ [KEY.PREFERENCES]: next });
    return next;
  });
}

// ---------- the command palette's recently run actions (storage.local) ----------
const isActionId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(value);
export async function getPaletteRecent() {
  const stored = (await localArea.get(KEY.PALETTE_RECENT))[KEY.PALETTE_RECENT];
  return Array.isArray(stored) ? [...new Set(stored.filter(isActionId))].slice(0, LIMITS.PALETTE_RECENT) : [];
}
// `id` goes first; resolves to the new list.
export function notePaletteRecent(id) {
  if (!isActionId(id)) return getPaletteRecent();
  return withLock('paletteRecent', async () => {
    const next = [id, ...(await getPaletteRecent()).filter((x) => x !== id)].slice(0, LIMITS.PALETTE_RECENT);
    await localArea.set({ [KEY.PALETTE_RECENT]: next });
    return next;
  });
}

// ---------- the "use Alt+Q" nudge (storage.local, this device only) ----------
export async function getNudge() {
  const stored = (await localArea.get(KEY.NUDGE))[KEY.NUDGE] || {};
  return { day: typeof stored.day === 'string' ? stored.day : '', runs: count(stored.runs), shown: count(stored.shown), last: count(stored.last), never: stored.never === true };
}
export function updateNudge(change) {
  return withLock('nudge', async () => {
    const next = change(await getNudge());
    await localArea.set({ [KEY.NUDGE]: next });
    return next;
  });
}

// ---------- resume (storage.session) ----------
// Capturing one tab in the switcher's own window hides the page the switcher sits on, which closes
// it. The switcher leaves a note of what it was showing, and opens again where it was.
export const setResume = (resume) => sessionArea.set({ [KEY.RESUME]: { ...resume, t: Date.now() } });
export async function takeResume() {
  const stored = (await sessionArea.get(KEY.RESUME))[KEY.RESUME];
  await sessionArea.remove(KEY.RESUME);
  return stored && isTime(stored.t) && Date.now() - stored.t < LIMITS.RESUME_TIME_TO_LIVE_MILLISECONDS ? stored : null;
}

// ---------- capture diagnostics (storage.session) ----------
// The last thing that happened when Tabazing tried to take a preview, so the switcher can say
// why one is missing ("Chrome blocked the screenshot: ..."). Memory only; never contains page content.
export async function noteCapture(stage, message = '', url = '') {
  let host = '';
  try { host = new URL(url).host; } catch {}
  try { await sessionArea.set({ [KEY.CAPTURE_DIAGNOSIS]: { t: Date.now(), stage, message: String(message), host } }); } catch {}
  // Pages Chrome never lets extensions screenshot (the Web Store, some built-in pages): remember them,
  // so the switcher stops offering "Capture preview" there. A later success forgets the page again.
  const key = url && normalizeUrl(url);
  if (!key) return;
  const blocked = stage === 'error' && /cannot be scripted|cannot access|extensions gallery|chrome:\/\/|edge:\/\//i.test(message);
  if (!blocked && stage !== 'ok') return;
  try {
    await serial(async () => {
      const stored = (await sessionArea.get(KEY.NO_CAPTURE))[KEY.NO_CAPTURE];
      if (!blocked && !(Array.isArray(stored) && stored.includes(key))) return; // a success on a page that wasn't listed: nothing to forget
      const list = (Array.isArray(stored) ? stored : []).filter((x) => typeof x === 'string' && x !== key); // a bad stored value counts as empty
      if (blocked) list.unshift(key);
      await sessionArea.set({ [KEY.NO_CAPTURE]: list.slice(0, 300) });
    });
  } catch {}
}
export async function getNoCapture() {
  const stored = (await sessionArea.get(KEY.NO_CAPTURE))[KEY.NO_CAPTURE];
  return new Set(Array.isArray(stored) ? stored.filter((x) => typeof x === 'string') : []);
}
export async function getCaptureNote() {
  const stored = (await sessionArea.get(KEY.CAPTURE_DIAGNOSIS))[KEY.CAPTURE_DIAGNOSIS];
  return stored && typeof stored === 'object' && isTime(stored.t) ? { t: stored.t, stage: String(stored.stage), message: String(stored.message || ''), host: String(stored.host || '') } : null;
}
export function setMru(ids) {
  return serial(() => sessionArea.set({ [KEY.MRU]: ids.filter(isId).slice(0, LIMITS.MAX_MRU) }));
}

// ---------- what each tab plays (storage.session) ----------
// Reported by the pages themselves (media-hook.js -> media-relay.js -> background), so untrusted: the
// report is parsed and checked here, and checked again on every read. Per tab and frame (an embedded
// video plays in its own frame); a frame that stops having media is dropped, and a tab with none.
const isMediaKey = (key) => /^\d{1,10}$/.test(key);
const mediaText = (text) => text.trim().slice(0, LIMITS.MEDIA_TEXT_MAX);
function cleanMediaState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.media !== 'boolean') return null;
  if (!raw.media) return { media: false };
  const flags = ['playing', 'canPrevious', 'canNext', 'muted'];
  if (flags.some((flag) => typeof raw[flag] !== 'boolean') || !['video', 'audio'].includes(raw.kind) || typeof raw.title !== 'string' || typeof raw.artist !== 'string') return null;
  return { media: true, playing: raw.playing, kind: raw.kind, title: mediaText(raw.title), artist: mediaText(raw.artist), canPrevious: raw.canPrevious, canNext: raw.canNext, muted: raw.muted };
}
// A page's report (JSON text, at most LIMITS.MEDIA_STATE_MAX characters) -> a clean state, or null.
export function parseMedia(json) {
  if (typeof json !== 'string' || json.length > LIMITS.MEDIA_STATE_MAX) return null;
  try { return cleanMediaState(JSON.parse(json)); } catch { return null; }
}
// { [tabId]: { [frameId]: { media: true, playing, kind, title, artist, canPrevious, canNext, muted, t } } }
export async function getMedia() {
  const stored = (await sessionArea.get(KEY.MEDIA))[KEY.MEDIA];
  const out = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [tab, frames] of Object.entries(stored)) {
    if (!isMediaKey(tab) || !frames || typeof frames !== 'object' || Array.isArray(frames)) continue;
    const ok = {};
    for (const [frame, entry] of Object.entries(frames)) {
      const state = isMediaKey(frame) && entry && isTime(entry.t) ? cleanMediaState(entry) : null;
      if (state && state.media) ok[frame] = { ...state, t: entry.t };
    }
    if (Object.keys(ok).length) out[tab] = ok;
  }
  return out;
}
export function setMedia(tabId, frameId, state) {
  if (!isId(tabId) || !isId(frameId) || !state) return Promise.resolve();
  return serial(async () => {
    const all = await getMedia();
    const frames = all[tabId] || {};
    if (!state.media && !frames[frameId]) return; // nothing was playing there, nothing is: no write
    if (state.media) frames[frameId] = { ...state, t: Date.now() }; else delete frames[frameId];
    // A page with many frames keeps only the latest few reports.
    Object.keys(frames).sort((firstKey, secondKey) => frames[secondKey].t - frames[firstKey].t).slice(LIMITS.MEDIA_FRAMES_MAX).forEach((key) => delete frames[key]);
    if (Object.keys(frames).length) all[tabId] = frames; else delete all[tabId];
    await sessionArea.set({ [KEY.MEDIA]: all });
  });
}
// What a tab's frames play, as the background just asked them (frameId -> clean state): replaces what was
// known for the tab. A frame still in the same state keeps its time (paused media ages out after an hour).
export function replaceMedia(tabId, states) {
  if (!isId(tabId)) return Promise.resolve();
  return serial(async () => {
    const all = await getMedia();
    const before = all[tabId] || {};
    const frames = {};
    for (const [frame, state] of Object.entries(states || {})) {
      if (!isMediaKey(frame) || !state || !state.media) continue;
      const old = before[frame];
      frames[frame] = { ...state, t: old && old.playing === state.playing ? old.t : Date.now() };
    }
    if (JSON.stringify(frames) === JSON.stringify(before)) return;
    if (Object.keys(frames).length) all[tabId] = frames; else delete all[tabId];
    await sessionArea.set({ [KEY.MEDIA]: all });
  });
}
// The tab closed, or loaded a new page (whose scripts report afresh). Resolves to whether it had any.
export function forgetMedia(tabId) {
  return serial(async () => {
    const all = await getMedia();
    if (!all[tabId]) return false;
    delete all[tabId];
    await sessionArea.set({ [KEY.MEDIA]: all });
    return true;
  });
}

// ---------- overlay bookkeeping ----------
// Stored (not kept in memory) so a restarted service worker still knows
// not to screenshot a tab that currently has the overlay on top of it.
export const setOverlayTab = (tabId) => sessionArea.set({ [KEY.OVERLAY]: { tabId, t: Date.now() } });
export const clearOverlayTab = () => sessionArea.remove(KEY.OVERLAY);
export async function isOverlayTab(tabId) {
  const overlay = (await sessionArea.get(KEY.OVERLAY))[KEY.OVERLAY];
  return !!overlay && overlay.tabId === tabId && isTime(overlay.t) && Date.now() - overlay.t < 10 * 60 * 1000;
}

// ---------- launch ----------
// The switcher page has to be web-accessible (it lives in an iframe on the
// page), so any site could try to load it. It only renders when it presents
// the one-time token the background created for this launch. All launch
// details are kept here, so the URL (which the page can see) holds nothing
// but that random token.
export async function createLaunch(launchContext) {
  const token = crypto.randomUUID();
  await sessionArea.set({ [KEY.LAUNCH]: { token, t: Date.now(), context: launchContext } });
  return token;
}

// Returns the launch context if `token` is the current, unexpired token, and
// invalidates it; otherwise null. A wrong token does not invalidate the real one.
export function consumeLaunch(token) {
  return serial(async () => {
    const launch = (await sessionArea.get(KEY.LAUNCH))[KEY.LAUNCH];
    if (!launch || typeof token !== 'string' || typeof launch.token !== 'string' || launch.token !== token) return null;
    await sessionArea.remove(KEY.LAUNCH);
    if (!isTime(launch.t) || Date.now() - launch.t > LIMITS.LAUNCH_TIME_TO_LIVE_MILLISECONDS || !launch.context) return null;
    const launchContext = launch.context;
    if (!isId(launchContext.sourceTab) || !isId(launchContext.window)) return null;
    return Object.freeze({
      sourceTab: launchContext.sourceTab,
      sourceWindow: launchContext.window,
      sourceState: WINDOW_STATES.includes(launchContext.state) ? launchContext.state : 'normal',
      direction: launchContext.direction === -1 ? -1 : launchContext.direction === 0 ? 0 : 1, // 0: Alt+E (open on the current tab and stay)
      hold: launchContext.hold === true, // opened by Alt+Q / Alt+W: letting go of Alt switches to the selected tab
      mode: MODES.includes(launchContext.mode) ? launchContext.mode : 'window',
      via: ['key', 'icon', 'startup'].includes(launchContext.via) ? launchContext.via : 'key', // how it was opened
      palette: launchContext.palette === true, // Alt+R: open straight into the command palette
    });
  });
}
