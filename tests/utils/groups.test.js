// utils/groups.js: a tab group as kept for a tab that comes back, and putting tabs back into "their" group.
import { describe, it, expect } from 'vitest';
import { GROUP_COLORS, cleanGroup, groupOf, putInGroup } from '../../utils/groups.js';

describe('cleanGroup / groupOf', () => {
  it('keeps the id, name and colour; anything else is dropped, a colour Chrome lacks is grey', () => {
    expect(cleanGroup({ id: 3, title: 'Work', color: 'blue', junk: 1 })).toEqual({ id: 3, title: 'Work', color: 'blue' });
    expect(cleanGroup({ id: -1, title: 'x'.repeat(300), color: 'mauve' })).toEqual({ id: null, title: 'x'.repeat(200), color: 'grey' });
    for (const bad of [null, 'Work', { title: 5 }, {}]) expect(cleanGroup(bad)).toBe(null);
    expect(groupOf({ id: 4, title: '', color: 'red', collapsed: true, windowId: 1 })).toEqual({ id: 4, title: '', color: 'red' });
    expect(groupOf(null)).toBe(null);
    expect(GROUP_COLORS).toEqual(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  });
});

describe('putInGroup', () => {
  const tabs = (n, windowId = 1) => Array.from({ length: n }, (_, i) => chrome._addTab({ windowId, url: `https://t${i}.example/` }));

  it('the same group while it is still there, in that window', async () => {
    chrome._addWindow({ id: 1 });
    const [a, b] = tabs(2);
    chrome._addGroup({ id: 5, title: 'Work', color: 'blue', windowId: 1 });
    a.groupId = 5;
    expect(await putInGroup([b.id], { id: 5, title: 'Work', color: 'blue' }, 1)).toBe(5);
    expect(b.groupId).toBe(5);
  });

  it('gone (or in another window): one there with the same name and colour', async () => {
    chrome._addWindow({ id: 1 });
    chrome._addWindow({ id: 2 });
    const [a] = tabs(1, 1);
    const [b] = tabs(1, 2);
    chrome._addGroup({ id: 5, title: 'Work', color: 'blue', windowId: 1 });
    chrome._addGroup({ id: 6, title: 'Work', color: 'blue', windowId: 2 });
    a.groupId = 5;
    expect(await putInGroup([b.id], { id: 5, title: 'Work', color: 'blue' }, 2)).toBe(6); // not 5: that one is in window 1
  });

  it('else a new one with its name and colour; an unnamed group is never matched by colour alone', async () => {
    chrome._addWindow({ id: 1 });
    const [a, b] = tabs(2);
    chrome._addGroup({ id: 8, title: '', color: 'red', windowId: 1 });
    a.groupId = 8;
    const id = await putInGroup([b.id], { id: 99, title: '', color: 'red' }, 1);
    expect(id).not.toBe(8);
    expect(chrome._data.groups.find((g) => g.id === id)).toMatchObject({ title: '', color: 'red', windowId: 1 });
  });

  it('nothing to do: null', async () => {
    expect(await putInGroup([], { title: 'x', color: 'red' }, 1)).toBe(null);
    expect(await putInGroup([1], null, 1)).toBe(null);
  });
});
