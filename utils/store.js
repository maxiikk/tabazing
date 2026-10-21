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
import { normalizeUrl, isWorthReopening } from './ext.js';
import { emptyReview } from './review.js';
import { isAccent, DEFAULT_ACCENT } from './accent.js';
import { getArchived } from './archive.js';
import { cleanGroup } from './groups.js';

const S = chrome.storage.session;
const L = chrome.storage.local;

// Every read-modify-write goes through one queue so concurrent events
// (e.g. onActivated + onRemoved firing together) can't lose updates.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// Same, but across contexts: the worker and the switcher page both write some
// keys, and Web Locks are shared by every page of the extension.
export function withLock(name, fn) {
  return navigator.locks ? navigator.locks.request('tabazing:' + name, fn) : serial(fn);
}

// ---------- validation ----------
const isId = (v) => Number.isInteger(v) && v >= 0;
const isTime = (v) => Number.isFinite(v) && v > 0;
const isImage = (v) => typeof v === 'string' && v.startsWith(PREVIEW_PREFIX) && v.length < 4 * 1024 * 1024; // a sharp copy is ~0.2-0.6 MB
const isPreview = (p) => !!p && typeof p === 'object' && isImage(p.img) && isTime(p.t);

// The preview index: { [normalizedUrl]: { t: capturedAt, n: imageLength, s: last time an open tab had this URL } }.
// `s` is optional on read (older entries): it then counts as `t`.
function cleanIndex(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, e] of Object.entries(v)) {
      if (k && k.length <= LIMITS.MAX_URL_KEY && e && isTime(e.t) && Number.isFinite(e.n) && e.n >= 0) out[k] = { t: e.t, n: e.n, s: isTime(e.s) ? e.s : e.t };
    }
  }
  return out;
}

// ---------- MRU ----------
export async function getMru() {
  const v = (await S.get(KEY.MRU))[KEY.MRU];
  return Array.isArray(v) ? v.filter(isId).slice(0, LIMITS.MAX_MRU) : [];
}
export function touchMru(tabId) {
  return serial(async () => {
    const mru = (await getMru()).filter((id) => id !== tabId);
    mru.unshift(tabId);
    await S.set({ [KEY.MRU]: mru.slice(0, LIMITS.MAX_MRU) });
  });
}
export function removeFromMru(tabId) {
  return serial(async () => {
    await S.set({ [KEY.MRU]: (await getMru()).filter((id) => id !== tabId) });
  });
}
export function replaceInMru(oldId, newId) {
  return serial(async () => {
    const mru = (await getMru()).filter((id) => id !== newId).map((id) => (id === oldId ? newId : id));
    await S.set({ [KEY.MRU]: mru });
  });
}
export function seedMru(tabIds) {
  return serial(async () => {
    if (!(await getMru()).length) await S.set({ [KEY.MRU]: tabIds.filter(isId) });
  });
}

// ---------- previews (storage.local, keyed by normalized URL) ----------
const keyOf = (url) => {
  const k = normalizeUrl(url);
  return k && k.length <= LIMITS.MAX_URL_KEY ? k : '';
};

// Previews have no expiry on read: cleanupPreviews() is the only thing that
// deletes them, and it never touches a URL an open tab still has.
export async function getPreview(url) {
  const k = keyOf(url);
  if (!k) return null;
  const p = (await L.get(previewKey(k)))[previewKey(k)];
  return isPreview(p) ? p : null;
}

// When each page's preview was taken: url -> time (0: none). One read of the index, not of the images.
export async function previewTimes() {
  const idx = cleanIndex((await L.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX]);
  return (url) => { const e = idx[keyOf(url)]; return e ? e.t : 0; };
}

// Is the page's preview at most `ms` old? Asked on every Alt+Q, so it is answered from the saves this
// context made itself (only the worker saves previews) rather than by reading a ~40 KB image. Only a
// context younger than `ms` can have missed a save that recent: that one reads storage.
const loadedAt = Date.now();
const savedAt = new Map(); // normalized url -> capture time, latest saves only
export async function previewFresh(url, ms) {
  const k = keyOf(url);
  if (!k) return false;
  const now = Date.now();
  if (savedAt.has(k)) return now - savedAt.get(k) <= ms;
  if (now - loadedAt > ms) return false;
  const p = await getPreview(url);
  return !!p && now - p.t <= ms;
}
function noteSaved(k, t) {
  savedAt.delete(k);
  savedAt.set(k, t);
  if (savedAt.size > 50) savedAt.delete(savedAt.keys().next().value); // a few seconds' worth at most
}

// Returns { [normalizedUrl]: { img, t } } for the URLs that have a preview.
// Look entries up with normalizeUrl(url).
export async function getPreviews(urls) {
  const keys = [...new Set(urls.map(keyOf).filter(Boolean))];
  if (!keys.length) return {};
  const got = await L.get(keys.map(previewKey));
  const out = {};
  for (const k of keys) {
    const p = got[previewKey(k)];
    if (isPreview(p)) out[k] = p;
  }
  return out;
}

// URLs that open tabs have right now (null if Chrome can't tell us). A preview
// for one of these is kept as long as the tab is open, however old it is.
// Starred and archived pages count as open: their previews are kept even while no tab shows them.
async function openKeys() {
  try {
    const [tabs, stars, archived] = await Promise.all([chrome.tabs.query({ windowType: 'normal' }), getStars(), getArchived()]);
    return new Set([...tabs.map((t) => keyOf(t.url || t.pendingUrl)).filter(Boolean), ...Object.keys(stars), ...archived.map((a) => keyOf(a.url)).filter(Boolean)]);
  } catch {
    return null;
  }
}

// openKeys() at most once, and only if asked: a save may need it for both its caps and its sharp copy.
function lazyOpenKeys() {
  let p = null;
  return () => (p = p || openKeys());
}

const seen = (e) => Math.max(e.t, e.s);

// Who goes first when over a cap: previews no open tab uses (oldest first),
// then previews open tabs use (oldest capture first). `keep` is never listed.
function evictionOrder(idx, open, keep) {
  const used = (k) => open.has(k);
  return Object.keys(idx)
    .filter((k) => k !== keep)
    .sort((a, b) => (used(a) - used(b)) || (used(a) ? idx[a].t - idx[b].t : seen(idx[a]) - seen(idx[b])));
}

const SMALL_CAPS = { count: LIMITS.MAX_PREVIEWS, bytes: LIMITS.MAX_PREVIEW_BYTES };
const SHARP_CAPS = { count: LIMITS.MAX_SHARP, bytes: LIMITS.MAX_SHARP_BYTES };
const overCap = (idx, caps = SMALL_CAPS) => {
  const keys = Object.keys(idx);
  return keys.length > caps.count || keys.reduce((sum, k) => sum + idx[k].n, 0) > caps.bytes;
};

// Keys to delete so the cache fits both caps.
function overflow(idx, open, keep, caps = SMALL_CAPS) {
  let count = Object.keys(idx).length;
  let bytes = Object.keys(idx).reduce((sum, k) => sum + idx[k].n, 0);
  const out = [];
  for (const k of evictionOrder(idx, open, keep)) {
    if (count <= caps.count && bytes <= caps.bytes) break;
    out.push(k);
    count--;
    bytes -= idx[k].n;
  }
  return out;
}

export function savePreview(url, data) {
  const k = keyOf(url);
  if (!k || !isPreview(data)) return Promise.resolve();
  const saved = serial(async () => {
    const getOpen = lazyOpenKeys();
    const idx = cleanIndex((await L.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX]);
    idx[k] = { t: data.t, n: data.img.length, s: Date.now() }; // a tab with this URL is open right now
    const open = overCap(idx) ? (await getOpen()) || new Set([k]) : new Set([k]);
    const evict = overflow(idx, open, k);
    evict.forEach((u) => delete idx[u]);
    if (evict.length) await L.remove(evict.map(previewKey));
    const write = () => L.set({ [previewKey(k)]: { img: data.img, t: data.t }, [KEY.PREVIEW_INDEX]: idx });
    try {
      await write();
    } catch {
      // Quota exceeded: drop the first half of the eviction order, then try once more.
      const order = evictionOrder(idx, (await getOpen()) || new Set(), k);
      const old = order.slice(0, Math.ceil(order.length / 2));
      old.forEach((u) => delete idx[u]);
      await L.remove(old.map(previewKey));
      await write();
      evict.push(...old);
    }
    noteSaved(k, data.t);
    await saveSharp(k, isImage(data.sharp) ? { img: data.sharp, t: data.t } : null, idx, getOpen);
  });
  saved.then(maybeCleanup).catch(() => {});
  return saved;
}

// The sharp copy of a capture (shown in the big preview). It lives exactly as long as its small copy
// (`idx`, the small previews' index, after any eviction) and has caps of its own: over them, those of
// closed tabs go first, then the oldest. A capture without a sharp copy drops the older sharp one.
// `getOpen` is the caller's openKeys(), so one save asks Chrome for the open tabs once.
async function saveSharp(k, sharp, idx, getOpen) {
  const sidx = cleanIndex((await L.get(KEY.SHARP_INDEX))[KEY.SHARP_INDEX]);
  const drop = Object.keys(sidx).filter((u) => !idx[u] || (u === k && !sharp));
  drop.forEach((u) => delete sidx[u]);
  if (sharp) sidx[k] = { t: sharp.t, n: sharp.img.length, s: Date.now() };
  const open = overCap(sidx, SHARP_CAPS) ? (await getOpen()) || new Set([k]) : new Set([k]);
  const over = overflow(sidx, open, k, SHARP_CAPS);
  over.forEach((u) => delete sidx[u]);
  drop.push(...over);
  if (drop.length) await L.remove(drop.map(sharpKey));
  try {
    await L.set({ [KEY.SHARP_INDEX]: sidx, ...(sharp ? { [sharpKey(k)]: sharp } : {}) });
  } catch { // no room: the cards' copy is what matters, so give up the sharp one
    delete sidx[k];
    await L.set({ [KEY.SHARP_INDEX]: sidx }).catch(() => {});
  }
}
// The big preview: the sharp copy of a page's latest capture, or null (then the small one is shown).
export async function getSharpPreview(url) {
  const k = keyOf(url);
  if (!k) return null;
  const p = (await L.get(sharpKey(k)))[sharpKey(k)];
  return isPreview(p) ? p : null;
}

// Delete previews that no open tab uses and that are older than 7 days (counted
// from the last capture or the last time an open tab had that URL), then trim
// to the count and size caps. Previews of open tabs are never expired.
export function cleanupPreviews() {
  return serial(async () => {
    const open = await openKeys();
    if (!open) return; // can't tell which previews are in use: don't delete anything
    const idx = cleanIndex((await L.get(KEY.PREVIEW_INDEX))[KEY.PREVIEW_INDEX]);
    const now = Date.now();
    for (const k of open) if (idx[k]) idx[k].s = now;
    const drop = Object.keys(idx).filter((k) => !open.has(k) && seen(idx[k]) <= now - LIMITS.PREVIEW_TTL_MS);
    drop.forEach((k) => delete idx[k]);
    const extra = overflow(idx, open, '');
    extra.forEach((k) => delete idx[k]);
    drop.push(...extra);
    if (drop.length) await L.remove(drop.map(previewKey));
    await L.set({ [KEY.PREVIEW_INDEX]: idx, [KEY.PREVIEW_CLEAN]: now });
    await saveSharp('', null, idx, async () => open); // the sharp copies follow
  });
}

// Called after every saved preview (i.e. on tab switches): run the cleanup at
// most every 6 hours, and never in the first minute after the browser starts,
// when Chrome may still be restoring tabs (their URLs must count as "open").
let cleaning = false;
async function maybeCleanup() {
  if (cleaning) return;
  const [boot, last] = await Promise.all([S.get(KEY.BOOT_AT), L.get(KEY.PREVIEW_CLEAN)]);
  const now = Date.now();
  if (now - (boot[KEY.BOOT_AT] || 0) < LIMITS.CLEANUP_BOOT_DELAY_MS) return;
  if (now - (last[KEY.PREVIEW_CLEAN] || 0) < LIMITS.CLEANUP_EVERY_MS) return;
  cleaning = true;
  try { await cleanupPreviews(); } finally { cleaning = false; }
}
export const markBoot = () => S.set({ [KEY.BOOT_AT]: Date.now() });
// storage.session is empty at the start of every browser session (and after an extension
// update/reload), so the first worker start that finds no marker is the start of the session.
// This backs up runtime.onStartup, which doesn't fire for every way an extension gets loaded.
export async function ensureBoot() {
  if (!(await S.get(KEY.BOOT_AT))[KEY.BOOT_AT]) await markBoot();
}

// ---------- tabs Chrome has discarded (storage.session) ----------
// tab.discarded is also true for tabs Chrome restores lazily after a restart, which
// aren't "sleeping" in any useful sense. A tab is only shown as Sleeping if we saw
// Chrome discard it during this browser session; storage.session survives the
// service worker being suspended and is wiped on browser restart, like tab ids.
export async function getSlept() {
  const v = (await S.get(KEY.SLEPT))[KEY.SLEPT];
  return Array.isArray(v) ? v.filter(isId) : [];
}
export function markDiscarded(tabId, discarded) {
  if (!isId(tabId)) return Promise.resolve();
  return serial(async () => {
    const cur = await getSlept();
    const has = cur.includes(tabId);
    if (discarded === has) return;
    await S.set({ [KEY.SLEPT]: discarded ? [...cur, tabId].slice(-LIMITS.MAX_SLEPT) : cur.filter((id) => id !== tabId) });
  });
}
export function moveDiscarded(oldId, newId) {
  if (!isId(oldId) || !isId(newId)) return Promise.resolve();
  return serial(async () => {
    const cur = await getSlept();
    if (!cur.includes(oldId)) return;
    await S.set({ [KEY.SLEPT]: [...cur.filter((id) => id !== oldId && id !== newId), newId] });
  });
}

// ---------- closed-tab log (storage.local) ----------
// chrome.sessions only remembers the last 25 closed items, so we keep our own
// 7-day log. tabs.onRemoved doesn't say what the tab was, so we remember each
// open tab's url/title/icon in storage.session (memory only) as it changes,
// and move it into the log when the tab closes.
const isLoggableUrl = (u) => typeof u === 'string' && u.length <= LIMITS.MAX_URL_KEY && /^(https?|file|ftp|chrome):/.test(u);
const isClosedEntry = (e) => !!e && typeof e === 'object' && isLoggableUrl(e.url) && typeof e.title === 'string'
  && typeof e.favIconUrl === 'string' && isTime(e.closedAt);

function cleanLog(v) {
  const cutoff = Date.now() - LIMITS.CLOSED_LOG_TTL_MS;
  return Array.isArray(v) ? v.filter((e) => isClosedEntry(e) && e.closedAt > cutoff).slice(0, LIMITS.MAX_CLOSED_LOG) : [];
}

export async function getClosedLog() {
  return cleanLog((await L.get(KEY.CLOSED_LOG))[KEY.CLOSED_LOG]);
}

const lastMeta = new Map(); // tabId -> last JSON written, to skip repeat writes (lost on worker restart: harmless)
// `group`: the tab group it is in ({ id, title, color }, utils/groups.js), so a tab reopened from the log goes back in it.
const metaOf = (tab, group = null) => {
  const url = (tab && (tab.url || tab.pendingUrl)) || '';
  if (!tab || !isId(tab.id) || tab.incognito || !isLoggableUrl(url) || !isWorthReopening(url)) return null;
  const icon = typeof tab.favIconUrl === 'string' && /^https?:/.test(tab.favIconUrl) && tab.favIconUrl.length <= 512 ? tab.favIconUrl : '';
  const g = tab.groupId >= 0 ? cleanGroup(group) : null;
  return { u: url, ti: String(tab.title || '').slice(0, 300), f: icon, ...(g ? { g } : {}) };
};

// Call whenever a tab's url, title, icon or group may have changed.
export function rememberTab(tab, group = null) {
  const m = metaOf(tab, group);
  if (!m) return Promise.resolve();
  const json = JSON.stringify(m);
  if (lastMeta.get(tab.id) === json) return Promise.resolve();
  lastMeta.set(tab.id, json);
  return serial(() => S.set({ [tabMetaKey(tab.id)]: m }));
}

// `groups`: id -> group, for the tabs that are in one.
export function rememberTabs(tabs, groups = new Map()) {
  const writes = {};
  for (const tab of tabs) {
    const m = metaOf(tab, groups.get(tab.groupId));
    if (m) { writes[tabMetaKey(tab.id)] = m; lastMeta.set(tab.id, JSON.stringify(m)); }
  }
  return serial(() => S.set(writes));
}

export function forgetTabMeta(tabId) {
  lastMeta.delete(tabId);
  return serial(() => S.remove(tabMetaKey(tabId)));
}

// A tab was closed: add it to the log (newest first, one entry per page). Closing a window or "close
// others" closes dozens of tabs at once, so closes are gathered for CLOSE_BATCH_MS and written in one go
// (one read and one write of the log, each entry's URL normalized once). Resolves once written.
const CLOSE_BATCH_MS = 100;
let closing = []; // [{ tabId, at }] waiting to be logged
let closeBatch = null; // { timer, done } while some are
export function logClosedTab(tabId) {
  lastMeta.delete(tabId);
  closing.push({ tabId, at: Date.now() });
  if (!closeBatch) {
    let done;
    const written = new Promise((r) => { done = r; });
    closeBatch = { timer: setTimeout(flushClosedTabs, CLOSE_BATCH_MS), done, written };
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
    const keys = batch.map((c) => tabMetaKey(c.tabId));
    const metas = await S.get(keys);
    const known = keys.filter((k) => metas[k]); // the rest: never seen (opened and closed instantly), or a blank/own page
    if (!known.length) return;
    await S.remove(known);
    const add = batch.map((c) => ({ m: metas[tabMetaKey(c.tabId)], at: c.at })).filter(({ m }) => m && typeof m === 'object' && isLoggableUrl(m.u));
    if (!add.length) return;
    let log = cleanLog((await L.get(KEY.CLOSED_LOG))[KEY.CLOSED_LOG]).map((e) => ({ e, k: normalizeUrl(e.url) }));
    for (const { m, at } of add) { // in closing order, as if each were written on its own
      const k = normalizeUrl(m.u);
      log = log.filter((x) => x.k !== k);
      const group = cleanGroup(m.g);
      log.unshift({ e: { url: m.u, title: typeof m.ti === 'string' ? m.ti : '', favIconUrl: typeof m.f === 'string' ? m.f : '', closedAt: at, ...(group ? { group } : {}) }, k });
      log = log.slice(0, LIMITS.MAX_CLOSED_LOG);
    }
    await L.set({ [KEY.CLOSED_LOG]: log.map((x) => x.e) });
  });
  done(run);
  return run;
}

// Run once at browser start and after install/update: drop entries older than 7 days, cap the size.
export function cleanupClosedLog() {
  return serial(async () => {
    const raw = (await L.get(KEY.CLOSED_LOG))[KEY.CLOSED_LOG];
    const log = cleanLog(raw);
    if (!Array.isArray(raw) || log.length !== raw.length) await L.set({ [KEY.CLOSED_LOG]: log });
  });
}

// ---------- review prompt counters (storage.local, this device only) ----------
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
function cleanReview(v) {
  const e = emptyReview();
  if (!v || typeof v !== 'object') return e;
  return {
    since: isTime(v.since) ? v.since : e.since, opens: count(v.opens), soft: count(v.soft), lastSoft: count(v.lastSoft),
    asks: count(v.asks), lastAsk: count(v.lastAsk), done: v.done === true,
    day: typeof v.day === 'string' && v.day.length <= 12 ? v.day : '',
  };
}
export async function getReview() {
  return cleanReview((await L.get(KEY.REVIEW))[KEY.REVIEW]);
}
// `change` gets the current counters and returns the new ones.
export function updateReview(change) {
  return withLock('review', async () => {
    const next = cleanReview(change(await getReview()));
    await L.set({ [KEY.REVIEW]: next });
    return next;
  });
}

// ---------- first-run flags (storage.local) ----------
export async function getOnboard() {
  const v = (await L.get(KEY.ONBOARD))[KEY.ONBOARD];
  return { at: v && isTime(v.at) ? v.at : 0, flyout: !!(v && v.flyout), tour: !!(v && v.tour) };
}
export function updateOnboard(patch) {
  return withLock('onboard', async () => {
    const next = { ...(await getOnboard()), ...patch };
    await L.set({ [KEY.ONBOARD]: next });
    return next;
  });
}

// ---------- snoozed tabs (storage.local) ----------
// Closed for now and reopened at `at` by the background (one chrome.alarms alarm, set to the soonest).
const isSnooze = (v) => !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.url === 'string' && v.url.length <= LIMITS.MAX_URL_KEY && isTime(v.at);
export async function getSnoozed() {
  const v = (await L.get(KEY.SNOOZED))[KEY.SNOOZED];
  return Array.isArray(v) ? v.filter(isSnooze).map((x) => ({ id: x.id, url: x.url, title: String(x.title || '').slice(0, 300), at: x.at, windowId: isId(x.windowId) ? x.windowId : null, pinned: x.pinned === true, t: isTime(x.t) ? x.t : x.at, group: cleanGroup(x.group) })) : [];
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
    await L.set({ [KEY.SNOOZED]: list });
    await scheduleSnoozeAlarm(list);
    return list;
  });
}
export function removeSnoozed(ids) {
  return withLock('snoozed', async () => {
    const list = (await getSnoozed()).filter((x) => !ids.includes(x.id));
    await L.set({ [KEY.SNOOZED]: list });
    await scheduleSnoozeAlarm(list);
    return list;
  });
}
// The background, when the alarm goes off (or at start-up, for any that came due while Chrome was closed).
export function takeDueSnoozed(now = Date.now()) {
  return withLock('snoozed', async () => {
    const list = await getSnoozed();
    const due = list.filter((x) => x.at <= now);
    const rest = list.filter((x) => x.at > now);
    if (due.length) await L.set({ [KEY.SNOOZED]: rest });
    await scheduleSnoozeAlarm(rest);
    return due;
  });
}

// ---------- woken snoozed tabs (storage.session) ----------
// Snoozed tabs reopen in the background, unannounced: the switcher tags them "Back from snooze" until
// they have been looked at (forgetWoken on activation) or for a day at most.
export async function getWoken(now = Date.now()) {
  const v = (await S.get(KEY.WOKEN))[KEY.WOKEN];
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, at] of Object.entries(v)) if (/^\d{1,10}$/.test(k) && isTime(at) && now - at < LIMITS.WOKEN_TTL_MS) out[k] = at;
  }
  return out;
}
export function markWoken(tabId, at = Date.now()) {
  if (!isId(tabId)) return Promise.resolve();
  return serial(async () => { await S.set({ [KEY.WOKEN]: { ...(await getWoken()), [tabId]: at } }); });
}
// Seen or closed. Writes only when the tab was there (this runs on every tab switch).
export function forgetWoken(tabId) {
  return serial(async () => {
    const all = await getWoken();
    if (!(tabId in all)) return;
    delete all[tabId];
    await S.set({ [KEY.WOKEN]: all });
  });
}

// ---------- notes on tabs (storage.local) ----------
// Keyed by normalized URL, like stars, so a note survives a restart (tab ids don't).
export async function getNotes() {
  const v = (await L.get(KEY.NOTES))[KEY.NOTES];
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, e] of Object.entries(v)) {
      if (k && e && typeof e.n === 'string' && e.n && isTime(e.t)) out[k] = { u: String(e.u || '').slice(0, LIMITS.MAX_URL_KEY), n: e.n.slice(0, LIMITS.NOTE_MAX), t: e.t };
    }
  }
  return out;
}
// Set the note on a page; empty text removes it. Returns every note.
export function setNote(url, text) {
  const k = keyOf(url);
  const n = String(text || '').trim().slice(0, LIMITS.NOTE_MAX);
  return withLock('notes', async () => {
    const notes = await getNotes();
    if (!k || (notes[k] ? notes[k].n === n : !n)) return notes; // nothing changed
    if (n) notes[k] = { u: url, n, t: Date.now() }; else delete notes[k];
    Object.keys(notes).sort((a, b) => notes[b].t - notes[a].t).slice(LIMITS.MAX_NOTES).forEach((x) => delete notes[x]);
    await L.set({ [KEY.NOTES]: notes });
    return notes;
  });
}

// ---------- notes on bookmarks (storage.local) ----------
// Keyed by the bookmark's id, not by an address: a bookmark's note stays with that bookmark (when its address is
// edited too), and has nothing to do with the note on a tab, which is about the page the tab shows.
export async function getBmNotes() {
  const v = (await L.get(KEY.BM_NOTES))[KEY.BM_NOTES];
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [id, e] of Object.entries(v)) {
      if (/^\w{1,40}$/.test(id) && e && typeof e.n === 'string' && e.n && isTime(e.t)) out[id] = { u: String(e.u || '').slice(0, LIMITS.MAX_URL_KEY), n: e.n.slice(0, LIMITS.NOTE_MAX), t: e.t };
    }
  }
  return out;
}
// Set several bookmarks' notes at once: { [id]: { n, u } } (an empty text, or null, removes that one). Returns every note.
// Kept on this computer only, as every other note.
export function putBmNotes(changes) {
  return withLock('bmNotes', async () => {
    const notes = await getBmNotes();
    for (const [id, c] of Object.entries(changes || {})) {
      const n = String((c && c.n) || '').trim().slice(0, LIMITS.NOTE_MAX);
      const u = String((c && c.u) || (notes[id] && notes[id].u) || '').slice(0, LIMITS.MAX_URL_KEY);
      if (n) notes[id] = { u, n, t: Date.now() }; else delete notes[id];
    }
    Object.keys(notes).sort((a, b) => notes[b].t - notes[a].t).slice(LIMITS.MAX_NOTES).forEach((x) => delete notes[x]);
    await L.set({ [KEY.BM_NOTES]: notes });
    return notes;
  });
}
export const setBmNote = (id, text, url = '') => putBmNotes({ [id]: { n: text, u: url } });

// ---------- stars (storage.local) ----------
// Pages the user starred, keyed by normalized URL (tab ids don't survive a restart).
// Not bookmarks: they live only in Tabazing, on this computer.
const isStar = (v) => !!v && typeof v === 'object' && typeof v.u === 'string' && v.u.length <= LIMITS.MAX_URL_KEY && isTime(v.t);
export async function getStars() {
  const v = (await L.get(KEY.STARS))[KEY.STARS];
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, e] of Object.entries(v)) if (k && isStar(e)) out[k] = { u: e.u, ti: String(e.ti || '').slice(0, 300), t: e.t };
  }
  return out;
}
// Star or unstar a page. Returns the new state (true = starred).
export function toggleStar(url, title) {
  const k = keyOf(url);
  if (!k) return Promise.resolve(false);
  return withLock('stars', async () => {
    const stars = await getStars();
    let on;
    if (stars[k]) { delete stars[k]; on = false; } else {
      stars[k] = { u: url, ti: String(title || '').slice(0, 300), t: Date.now() };
      on = true;
      const keys = Object.keys(stars).sort((a, b) => stars[b].t - stars[a].t);
      keys.slice(LIMITS.MAX_STARS).forEach((x) => delete stars[x]); // over the cap: the oldest stars go
    }
    await L.set({ [KEY.STARS]: stars });
    return on;
  });
}

// ---------- switcher layout (storage.local) ----------
export const SORTS = Object.freeze(['recent', 'order', 'name']);
export const SETTINGS_TABS = Object.freeze(['look', 'cards', 'search', 'behave', 'keys']); // Settings' categories
export async function getView() {
  const v = (await L.get(KEY.VIEW))[KEY.VIEW] || {};
  return {
    sort: SORTS.includes(v.sort) ? v.sort : 'recent',
    collapsed: Array.isArray(v.collapsed) ? v.collapsed.filter((x) => typeof x === 'string' && x.length <= 300).slice(0, LIMITS.MAX_COLLAPSED) : [],
    settingsTab: SETTINGS_TABS.includes(v.settingsTab) ? v.settingsTab : 'look', // the category Settings last showed
    markFolder: typeof v.markFolder === 'string' && /^\w{1,40}$/.test(v.markFolder) ? v.markFolder : '', // the bookmarks folder "Bookmark…" last saved into
    // the History and Bookmarks views: their last search, the history's look and time range, the open folders, the selected row
    histQ: typeof v.histQ === 'string' ? v.histQ.slice(0, 200) : '',
    histLayout: v.histLayout === 'grid' ? 'grid' : 'list',
    histRange: ['all', 'today', 'week', 'month'].includes(v.histRange) ? v.histRange : 'all',
    bmvQ: typeof v.bmvQ === 'string' ? v.bmvQ.slice(0, 200) : '',
    bmvOpen: Array.isArray(v.bmvOpen) ? v.bmvOpen.filter((x) => typeof x === 'string' && /^\w{1,40}$/.test(x)).slice(-500) : [],
    bmvSel: typeof v.bmvSel === 'string' && /^\w{1,40}$/.test(v.bmvSel) ? v.bmvSel : '',
  };
}
export function updateView(patch) {
  return withLock('view', async () => {
    const next = { ...(await getView()), ...patch };
    next.collapsed = next.collapsed.slice(-LIMITS.MAX_COLLAPSED);
    await L.set({ [KEY.VIEW]: next });
    return next;
  });
}

// ---------- the tab group the switcher is inside of (storage.session) ----------
// Set when a group's tile is opened, cleared when the group is left: until then every open shows that group.
// Chrome's group ids last one browser session, so this does too.
export async function getGroup() {
  const v = (await S.get(KEY.GROUP))[KEY.GROUP];
  return v && isId(v.id) ? v.id : null;
}
export const setGroup = (id) => (isId(id) ? S.set({ [KEY.GROUP]: { id, t: Date.now() } }) : S.remove(KEY.GROUP));

// ---------- "Recently closed" entries removed from the list (storage.local) ----------
// Chrome's own list of closed tabs can't be edited, so an entry removed from it is remembered here instead:
// { [key]: t } hides what was closed at or before `t` under that key (closedKey). Kept a month at most.
export const closedKey = (item) => (item.kind === 'window' ? 'w:' : '') + (keyOf(item.url) || item.url);
export async function getClosedHidden(now = Date.now()) {
  const v = (await L.get(KEY.CLOSED_HIDDEN))[KEY.CLOSED_HIDDEN];
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, t] of Object.entries(v)) if (k && k.length <= LIMITS.MAX_URL_KEY + 2 && isTime(t) && now - t < LIMITS.CLOSED_HIDDEN_TTL_MS) out[k] = t;
  }
  return out;
}
// `keys`: { [key]: t }, hide what was closed under each key at or before its t; with `show`, show those keys again.
export function hideClosed(keys, show = false) {
  return withLock('closedHidden', async () => {
    const all = await getClosedHidden();
    for (const [k, t] of Object.entries(keys)) { if (show) delete all[k]; else all[k] = Math.max(all[k] || 0, t); }
    const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.MAX_CLOSED_HIDDEN);
    await L.set({ [KEY.CLOSED_HIDDEN]: Object.fromEntries(kept) });
    return Object.fromEntries(kept);
  });
}

// ---------- settings (storage.local) ----------
export async function getPrefs() {
  const v = (await L.get(KEY.PREFS))[KEY.PREFS] || {};
  const on = (x) => x !== false; // switches that default to on: only an explicit `false` turns one off
  return {
    lang: ['auto', 'en', 'ru', 'es'].includes(v.lang) ? v.lang : 'auto', startup: v.startup === true,
    cardSize: ['small', 'list'].includes(v.cardSize) ? v.cardSize : 'default', accent: isAccent(v.accent) ? v.accent.toUpperCase() : DEFAULT_ACCENT,
    allWindows: v.allWindows === true, theme: ['dark', 'light'].includes(v.theme) ? v.theme : 'system',
    pinnedFirst: on(v.pinnedFirst), showClosed: on(v.showClosed), showSnoozed: on(v.showSnoozed), showAge: on(v.showAge), showGroups: on(v.showGroups), groupWrap: v.groupWrap === true,
    ownWindow: v.ownWindow === true, titleLines: v.titleLines === 1 ? 1 : 2,
    searchHistory: on(v.searchHistory), searchBookmarks: on(v.searchBookmarks),
    iconTips: Number.isInteger(v.iconTips) && v.iconTips >= 0 ? v.iconTips : 0, // times the toolbar-icon tip was shown
  };
}
export function updatePrefs(patch) {
  return withLock('prefs', async () => {
    const next = { ...(await getPrefs()), ...patch };
    await L.set({ [KEY.PREFS]: next });
    return next;
  });
}

// ---------- the command palette's recently run actions (storage.local) ----------
const isActionId = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(v);
export async function getPaletteRecent() {
  const v = (await L.get(KEY.PALETTE_RECENT))[KEY.PALETTE_RECENT];
  return Array.isArray(v) ? [...new Set(v.filter(isActionId))].slice(0, LIMITS.PALETTE_RECENT) : [];
}
// `id` goes first; resolves to the new list.
export function notePaletteRecent(id) {
  if (!isActionId(id)) return getPaletteRecent();
  return withLock('palRecent', async () => {
    const next = [id, ...(await getPaletteRecent()).filter((x) => x !== id)].slice(0, LIMITS.PALETTE_RECENT);
    await L.set({ [KEY.PALETTE_RECENT]: next });
    return next;
  });
}

// ---------- the "use Alt+Q" nudge (storage.local, this device only) ----------
export async function getNudge() {
  const v = (await L.get(KEY.NUDGE))[KEY.NUDGE] || {};
  return { day: typeof v.day === 'string' ? v.day : '', runs: count(v.runs), shown: count(v.shown), last: count(v.last), never: v.never === true };
}
export function updateNudge(change) {
  return withLock('nudge', async () => {
    const next = change(await getNudge());
    await L.set({ [KEY.NUDGE]: next });
    return next;
  });
}

// ---------- resume (storage.session) ----------
// Capturing one tab in the switcher's own window hides the page the switcher sits on, which closes
// it. The switcher leaves a note of what it was showing, and opens again where it was.
export const setResume = (r) => S.set({ [KEY.RESUME]: { ...r, t: Date.now() } });
export async function takeResume() {
  const r = (await S.get(KEY.RESUME))[KEY.RESUME];
  await S.remove(KEY.RESUME);
  return r && isTime(r.t) && Date.now() - r.t < LIMITS.RESUME_TTL_MS ? r : null;
}

// ---------- capture diagnostics (storage.session) ----------
// The last thing that happened when Tabazing tried to take a preview, so the switcher can say
// why one is missing ("Chrome blocked the screenshot: ..."). Memory only; never contains page content.
export async function noteCapture(stage, msg = '', url = '') {
  let host = '';
  try { host = new URL(url).host; } catch {}
  try { await S.set({ [KEY.CAPDIAG]: { t: Date.now(), stage, msg: String(msg), host } }); } catch {}
  // Pages Chrome never lets extensions screenshot (the Web Store, some built-in pages): remember them,
  // so the switcher stops offering "Capture preview" there. A later success forgets the page again.
  const k = url && normalizeUrl(url);
  if (!k) return;
  const blocked = stage === 'error' && /cannot be scripted|cannot access|extensions gallery|chrome:\/\/|edge:\/\//i.test(msg);
  if (!blocked && stage !== 'ok') return;
  try {
    await serial(async () => {
      const v = (await S.get(KEY.NOCAP))[KEY.NOCAP];
      if (!blocked && !(Array.isArray(v) && v.includes(k))) return; // a success on a page that wasn't listed: nothing to forget
      const list = (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x !== k); // a bad stored value counts as empty
      if (blocked) list.unshift(k);
      await S.set({ [KEY.NOCAP]: list.slice(0, 300) });
    });
  } catch {}
}
export async function getNoCapture() {
  const v = (await S.get(KEY.NOCAP))[KEY.NOCAP];
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
}
export async function getCaptureNote() {
  const v = (await S.get(KEY.CAPDIAG))[KEY.CAPDIAG];
  return v && typeof v === 'object' && isTime(v.t) ? { t: v.t, stage: String(v.stage), msg: String(v.msg || ''), host: String(v.host || '') } : null;
}
export function setMru(ids) {
  return serial(() => S.set({ [KEY.MRU]: ids.filter(isId).slice(0, LIMITS.MAX_MRU) }));
}

// ---------- what each tab plays (storage.session) ----------
// Reported by the pages themselves (media-hook.js -> media-relay.js -> background), so untrusted: the
// report is parsed and checked here, and checked again on every read. Per tab and frame (an embedded
// video plays in its own frame); a frame that stops having media is dropped, and a tab with none.
const isMediaKey = (k) => /^\d{1,10}$/.test(k);
const mediaText = (v) => v.trim().slice(0, LIMITS.MEDIA_TEXT_MAX);
function cleanMediaState(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.media !== 'boolean') return null;
  if (!v.media) return { media: false };
  const flags = ['playing', 'canPrev', 'canNext', 'muted'];
  if (flags.some((k) => typeof v[k] !== 'boolean') || !['video', 'audio'].includes(v.kind) || typeof v.title !== 'string' || typeof v.artist !== 'string') return null;
  return { media: true, playing: v.playing, kind: v.kind, title: mediaText(v.title), artist: mediaText(v.artist), canPrev: v.canPrev, canNext: v.canNext, muted: v.muted };
}
// A page's report (JSON text, at most LIMITS.MEDIA_STATE_MAX characters) -> a clean state, or null.
export function parseMedia(json) {
  if (typeof json !== 'string' || json.length > LIMITS.MEDIA_STATE_MAX) return null;
  try { return cleanMediaState(JSON.parse(json)); } catch { return null; }
}
// { [tabId]: { [frameId]: { media: true, playing, kind, title, artist, canPrev, canNext, muted, t } } }
export async function getMedia() {
  const v = (await S.get(KEY.MEDIA))[KEY.MEDIA];
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [tab, frames] of Object.entries(v)) {
    if (!isMediaKey(tab) || !frames || typeof frames !== 'object' || Array.isArray(frames)) continue;
    const ok = {};
    for (const [frame, e] of Object.entries(frames)) {
      const s = isMediaKey(frame) && e && isTime(e.t) ? cleanMediaState(e) : null;
      if (s && s.media) ok[frame] = { ...s, t: e.t };
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
    Object.keys(frames).sort((a, b) => frames[b].t - frames[a].t).slice(LIMITS.MEDIA_FRAMES_MAX).forEach((k) => delete frames[k]);
    if (Object.keys(frames).length) all[tabId] = frames; else delete all[tabId];
    await S.set({ [KEY.MEDIA]: all });
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
    for (const [frame, s] of Object.entries(states || {})) {
      if (!isMediaKey(frame) || !s || !s.media) continue;
      const old = before[frame];
      frames[frame] = { ...s, t: old && old.playing === s.playing ? old.t : Date.now() };
    }
    if (JSON.stringify(frames) === JSON.stringify(before)) return;
    if (Object.keys(frames).length) all[tabId] = frames; else delete all[tabId];
    await S.set({ [KEY.MEDIA]: all });
  });
}
// The tab closed, or loaded a new page (whose scripts report afresh). Resolves to whether it had any.
export function forgetMedia(tabId) {
  return serial(async () => {
    const all = await getMedia();
    if (!all[tabId]) return false;
    delete all[tabId];
    await S.set({ [KEY.MEDIA]: all });
    return true;
  });
}

// ---------- overlay bookkeeping ----------
// Stored (not kept in memory) so a restarted service worker still knows
// not to screenshot a tab that currently has the overlay on top of it.
export const setOverlayTab = (tabId) => S.set({ [KEY.OVERLAY]: { tabId, t: Date.now() } });
export const clearOverlayTab = () => S.remove(KEY.OVERLAY);
export async function isOverlayTab(tabId) {
  const o = (await S.get(KEY.OVERLAY))[KEY.OVERLAY];
  return !!o && o.tabId === tabId && isTime(o.t) && Date.now() - o.t < 10 * 60 * 1000;
}

// ---------- launch ----------
// The switcher page has to be web-accessible (it lives in an iframe on the
// page), so any site could try to load it. It only renders when it presents
// the one-time token the background created for this launch. All launch
// details are kept here, so the URL (which the page can see) holds nothing
// but that random token.
export async function createLaunch(ctx) {
  const token = crypto.randomUUID();
  await S.set({ [KEY.LAUNCH]: { token, t: Date.now(), ctx } });
  return token;
}

// Returns the launch context if `token` is the current, unexpired token, and
// invalidates it; otherwise null. A wrong token does not invalidate the real one.
export function consumeLaunch(token) {
  return serial(async () => {
    const l = (await S.get(KEY.LAUNCH))[KEY.LAUNCH];
    if (!l || typeof token !== 'string' || typeof l.token !== 'string' || l.token !== token) return null;
    await S.remove(KEY.LAUNCH);
    if (!isTime(l.t) || Date.now() - l.t > LIMITS.LAUNCH_TTL_MS || !l.ctx) return null;
    const c = l.ctx;
    if (!isId(c.src) || !isId(c.win)) return null;
    return Object.freeze({
      srcTab: c.src,
      srcWin: c.win,
      srcState: WINDOW_STATES.includes(c.state) ? c.state : 'normal',
      dir: c.dir === -1 ? -1 : c.dir === 0 ? 0 : 1, // 0: Alt+E (open on the current tab and stay)
      hold: c.hold === true, // opened by Alt+Q / Alt+W: letting go of Alt switches to the selected tab
      mode: MODES.includes(c.mode) ? c.mode : 'window',
      via: ['key', 'icon', 'startup'].includes(c.via) ? c.via : 'key', // how it was opened
      palette: c.palette === true, // Alt+R: open straight into the command palette
    });
  });
}
