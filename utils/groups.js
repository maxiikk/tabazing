// Chrome's tab groups, as Tabazing keeps them for a tab that closes and comes back (Undo, a snooze, a reopened
// recently closed tab): { id, title, color }. Group ids last one browser session; the name and colour stay.

export const GROUP_COLORS = Object.freeze(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']); // chrome.tabGroups.Color

/** A stored group, checked: { id (or null), title, color }, or null. */
export function cleanGroup(value) {
  if (!value || typeof value !== 'object' || typeof value.title !== 'string') return null;
  return { id: Number.isInteger(value.id) && value.id >= 0 ? value.id : null, title: value.title.slice(0, 200), color: GROUP_COLORS.includes(value.color) ? value.color : 'grey' };
}
/** A live chrome.tabGroups group as stored. */
export const groupOf = (group) => (group ? { id: group.id, title: group.title || '', color: GROUP_COLORS.includes(group.color) ? group.color : 'grey' } : null);

/**
 * Put tabs (all in `windowId`) into the group `g` stood for: the same group if it is still there in that window,
 * else one there with the same name and colour, else a new one with them. Resolves to the group's id (or null when
 * Chrome has no tab groups). A named group is found by its name; an unnamed one only by its id.
 */
export async function putInGroup(tabIds, group, windowId) {
  if (!group || !tabIds.length || !chrome.tabs.group || !chrome.tabGroups) return null;
  let id = null;
  if (Number.isInteger(group.id)) {
    const alive = await chrome.tabGroups.get(group.id).catch(() => null);
    if (alive && alive.windowId === windowId) id = alive.id;
  }
  if (id === null && group.title) {
    const same = (await chrome.tabGroups.query({ windowId }).catch(() => [])).find((x) => x.title === group.title && x.color === group.color);
    if (same) id = same.id;
  }
  if (id !== null) { await chrome.tabs.group({ tabIds, groupId: id }); return id; }
  id = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(id, { title: group.title || '', color: GROUP_COLORS.includes(group.color) ? group.color : 'grey' });
  return id;
}
