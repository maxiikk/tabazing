// Chrome's tab groups, as Tabazing keeps them for a tab that closes and comes back (Undo, a snooze, a reopened
// recently closed tab): { id, title, color }. Group ids last one browser session; the name and colour stay.

export const GROUP_COLORS = Object.freeze(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']); // chrome.tabGroups.Color

/** A stored group, checked: { id (or null), title, color }, or null. */
export function cleanGroup(v) {
  if (!v || typeof v !== 'object' || typeof v.title !== 'string') return null;
  return { id: Number.isInteger(v.id) && v.id >= 0 ? v.id : null, title: v.title.slice(0, 200), color: GROUP_COLORS.includes(v.color) ? v.color : 'grey' };
}
/** A live chrome.tabGroups group as stored. */
export const groupOf = (g) => (g ? { id: g.id, title: g.title || '', color: GROUP_COLORS.includes(g.color) ? g.color : 'grey' } : null);

/**
 * Put tabs (all in `windowId`) into the group `g` stood for: the same group if it is still there in that window,
 * else one there with the same name and colour, else a new one with them. Resolves to the group's id (or null when
 * Chrome has no tab groups). A named group is found by its name; an unnamed one only by its id.
 */
export async function putInGroup(tabIds, g, windowId) {
  if (!g || !tabIds.length || !chrome.tabs.group || !chrome.tabGroups) return null;
  let id = null;
  if (Number.isInteger(g.id)) {
    const alive = await chrome.tabGroups.get(g.id).catch(() => null);
    if (alive && alive.windowId === windowId) id = alive.id;
  }
  if (id === null && g.title) {
    const same = (await chrome.tabGroups.query({ windowId }).catch(() => [])).find((x) => x.title === g.title && x.color === g.color);
    if (same) id = same.id;
  }
  if (id !== null) { await chrome.tabs.group({ tabIds, groupId: id }); return id; }
  id = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(id, { title: g.title || '', color: GROUP_COLORS.includes(g.color) ? g.color : 'grey' });
  return id;
}
