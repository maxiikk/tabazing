// What keeps opening and redrawing the switcher quick: the first draw reads only the previews it shows,
// icons are parsed once, screenshots and untouched cards are kept between redraws, resizes are coalesced.
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor } from '../helpers/switcher.js';
import { boot, ABC, openCards, titleOf, tid, tids, selectedCard } from './_ui.js';

const IMG = 'data:image/jpeg;base64,AAAA';
const many = (n) => Array.from({ length: n }, (_, i) => ({ title: 'Tab ' + (i + 1), url: `https://t${i + 1}.example/` }));
const card = (title) => openCards().find((c) => titleOf(c) === title);
const entry = (sw, title) => sw.state.entries.find((e) => e.kind === 'tab' && e.tab.title === title);
// The preview keys each storage read asked for (one array per read that asked for any).
const pvReads = () => chrome.storage.local.get.mock.calls.map(([k]) => [].concat(k || []).filter((x) => typeof x === 'string' && x.startsWith('pv:'))).filter((x) => x.length);

describe('the first draw', () => {
  it('reads the previews of the first cards only, then the rest in one read, and shows them all', async () => {
    const tabs = many(50);
    const sw = await boot({
      tabs,
      beforeImport: () => chrome.storage.local.set(Object.fromEntries(tabs.map((x, i) => ['pv:' + x.url, { img: IMG, t: 1000 + i }]))),
    });
    await waitFor(() => tids('card-preview').length === 50);
    const reads = pvReads();
    expect(reads.length).toBe(2);
    expect(reads[0].length).toBeLessThanOrEqual(sw.previewBatch() + 2); // the cards that fit, the selected one, the current tab
    expect(reads[0].length).toBeLessThan(32); // fewer than the old fixed batch: a 1024 x 768 window shows about a dozen
    expect(reads[0]).toContain('pv:https://t1.example/'); // the current tab
    expect(reads[0]).toContain('pv:' + entry(sw, 'Tab 2').tab.url); // the selected card (the tab used before)
    expect(new Set([...reads[0], ...reads[1]]).size).toBe(50);
    expect(reads[0].filter((k) => reads[1].includes(k))).toEqual([]); // none read twice
    expect(sw.state.pvPending.size).toBe(0);
    expect(openCards().every((c) => tid('card-preview', c))).toBe(true);
  });

  it('previewBatch: as many cards as fit on the screen at the card size, one row more', async () => {
    const sw = await boot({ tabs: ABC() });
    expect(sw.previewBatch(1024, 768)).toBe(12); // 3 across, 3 rows down, and one more
    expect(sw.previewBatch(1920, 1080)).toBeGreaterThan(sw.previewBatch(1024, 768));
    sw.state.cardSize = 'small';
    expect(sw.previewBatch(1024, 768)).toBeGreaterThan(12);
    sw.state.cardSize = 'list';
    expect(sw.previewBatch(1024, 768)).toBeGreaterThan(30);
    expect(sw.previewBatch(0, 0)).toBe(sw.FIRST_PREVIEWS); // size unknown
  });

  it('a card whose preview is still being read shows a plain placeholder: its favicon, no "No preview yet", no Capture', async () => {
    const sw = await boot({ tabs: ABC() });
    const b = entry(sw, 'Bravo');
    sw.state.pvPending.add(b.tab.id);
    sw.refresh();
    expect(tid('card-loading', card('Bravo'))).not.toBe(null);
    expect(tid('card-tile-favicon', card('Bravo'))).not.toBe(null);
    expect(tid('card-no-preview-label', card('Bravo'))).toBe(null);
    expect(tid('card-capture', card('Bravo'))).toBe(null);
    expect(sw.missingPreviews().map((x) => x.title)).not.toContain('Bravo');
    sw.state.pvPending.delete(b.tab.id);
    sw.refresh();
    expect(tid('card-loading', card('Bravo'))).toBe(null);
    expect(tid('card-capture', card('Bravo'))).not.toBe(null);
  });

  it('reads the settings once', async () => {
    await boot({ tabs: ABC(), prefs: { lang: 'es', cardSize: 'small' } });
    const prefReads = chrome.storage.local.get.mock.calls.filter(([k]) => [].concat(k).includes('prefs'));
    expect(prefReads.length).toBe(1);
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('icons', () => {
  it('svgOf gives the same markup as parsing the icon, as a fresh copy each time', async () => {
    const sw = await boot({ tabs: ABC() });
    for (const markup of Object.values(sw.ICON)) {
      const parsed = document.createElement('span');
      parsed.innerHTML = markup;
      const cloned = document.createElement('span');
      cloned.append(sw.svgOf(markup));
      expect(cloned.innerHTML).toBe(parsed.innerHTML);
      expect(cloned.firstChild.namespaceURI).toBe('http://www.w3.org/2000/svg');
    }
    const a = sw.svgOf(sw.ICON.star), b = sw.svgOf(sw.ICON.star);
    expect(a.firstChild).not.toBe(b.firstChild);
  });
});

describe('redraws', () => {
  it('keep a card\'s screenshot element between redraws, and make a new one for a new capture', async () => {
    const sw = await boot({ tabs: ABC(), beforeImport: () => chrome.storage.local.set({ 'pv:https://bravo.example/': { img: IMG, t: 1 } }) });
    const before = card('Bravo');
    const img = tid('card-preview', before);
    expect(img).not.toBe(null);
    sw.refresh();
    expect(card('Bravo')).not.toBe(before); // a new card...
    expect(tid('card-preview', card('Bravo'))).toBe(img); // ...with the same picture
    await chrome.storage.local.set({ 'pv:https://bravo.example/': { img: IMG + 'B', t: 2 } });
    const now = tid('card-preview', card('Bravo'));
    expect(now).not.toBe(img);
    expect(now.getAttribute('src')).toBe(IMG + 'B');
  });

  it('a tick, a star or mute builds again only the cards it changes', async () => {
    const sw = await boot({ tabs: ABC() });
    const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map(card);
    sw.pick(entry(sw, 'Bravo'));
    expect(card('Alpha')).toBe(a);
    expect(card('Charlie')).toBe(c);
    expect(card('Bravo')).not.toBe(b);
    expect(card('Bravo').getAttribute('aria-checked')).toBe('true');
    expect(tid('card-pick', card('Bravo')).getAttribute('aria-checked')).toBe('true');
    expect(selectedCard()).toBe(card('Bravo')); // the selection follows the tick, as before
    expect(tids('card-tab').filter((x) => x.getAttribute('aria-selected') === 'true').length).toBe(1);
    expect(tid('acts').hidden).toBe(false);

    await sw.star(entry(sw, 'Alpha'));
    expect(card('Alpha')).not.toBe(a);
    expect(tid('card-star-button', card('Alpha')).getAttribute('aria-pressed')).toBe('true');
    expect(card('Charlie')).toBe(c);
    expect(tid('star-n').textContent).toBe('1');

    const c2 = card('Charlie');
    await sw.toggleMute(entry(sw, 'Bravo').tab);
    expect(card('Charlie')).toBe(c2);
    expect(tid('card-audio', card('Bravo'))).not.toBe(null);
  });

  it('a search keystroke dims cards without building them again, and the card buttons keep their mouse-only marks', async () => {
    const sw = await boot({ tabs: ABC() });
    const before = openCards();
    sw.pick(entry(sw, 'Alpha'));
    sw.pick(entry(sw, 'Bravo'));
    const now = openCards();
    sw.state.query = 'charl';
    sw.flushSearch();
    expect(openCards()).toEqual(now);
    expect(card('Alpha').classList.contains('nomatch')).toBe(true);
    expect(now[2]).toBe(before[2]);
    for (const b of now[0].querySelectorAll('button')) {
      expect(b.tabIndex).toBe(-1);
      expect(b.getAttribute('aria-hidden')).toBe('true');
    }
    expect(now[0].getAttribute('aria-describedby')).toBe('desc-' + now[0].id);
  });

  it('a preview saved while open draws just its cards', async () => {
    const sw = await boot({ tabs: ABC() });
    const [a, b] = ['Alpha', 'Bravo'].map(card);
    expect(tid('card-preview', b)).toBe(null);
    await chrome.storage.local.set({ 'pv:https://bravo.example/#x': { img: IMG, t: 5 } }); // (stored by normalized URL)
    await chrome.storage.local.set({ 'pv:https://bravo.example/': { img: IMG, t: 5 } });
    expect(tid('card-preview', card('Bravo'))).not.toBe(null);
    expect(card('Alpha')).toBe(a);
    expect(entry(sw, 'Bravo').preview.t).toBe(5);
  });

  it('resizing redraws once per frame, and builds the cards again only when their width changes', async () => {
    const sw = await boot({ tabs: ABC() });
    const grid = tid('open-grid');
    let builds = 0;
    const mo = new MutationObserver((recs) => { builds += recs.filter((r) => r.target === grid && r.addedNodes.length).length; });
    mo.observe(grid, { childList: true });
    grid.style.width = '1000px';
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('resize'));
    await tick(30);
    expect(builds).toBe(1);
    const a = card('Alpha');
    window.dispatchEvent(new Event('resize')); // same width: the cards stay
    await tick(30);
    expect(builds).toBe(1);
    expect(card('Alpha')).toBe(a);
    mo.disconnect();
    expect(sw.state.cardW).toBe(Math.floor(sw.cardWidth(sw.state.matchCount)));
  });

  it('the mouse selects the card under it by its place, touching only the old and the new card', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.mouseReady = true;
    card('Charlie').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(selectedCard()).toBe(card('Charlie'));
    expect(tids('card-tab').filter((x) => x.getAttribute('aria-selected') === 'true').length).toBe(1);
    expect(card('Charlie').closest('[role=listbox]').getAttribute('aria-activedescendant')).toBe(card('Charlie').id);
    expect(tid('search').getAttribute('aria-activedescendant')).toBe(card('Charlie').id);
  });
});

describe('duplicates', () => {
  it('are worked out once per derive', async () => {
    const sw = await boot({ tabs: [{ title: 'A1', url: 'https://a.com/' }, { title: 'A2', url: 'https://a.com/#x' }, { title: 'B', url: 'https://b.com/' }] });
    const d = sw.duplicates();
    expect(sw.duplicates()).toBe(d);
    expect(d.map((x) => x.title)).toEqual(['A2']);
    sw.derive();
    expect(sw.duplicates()).not.toBe(d);
    expect(sw.dupeIds().has(d[0].id)).toBe(true);
    sw.dupesView(true);
    expect(tids('card-dupe-closes').length).toBe(1);
    expect(tids('card-dupe-stays').length).toBe(1);
  });
});

describe('reading', () => {
  it('loadMarks reads the bookmark tree once and leaves the archive folder out', async () => {
    const sw = await boot({ tabs: ABC() });
    const arch = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: arch.id, title: 'Archived', url: 'https://arch.com/' });
    chrome._addBookmark({ parentId: '2', title: 'Kept', url: 'https://kept.com/' });
    chrome.bookmarks.getTree.mockClear();
    chrome.bookmarks.getChildren.mockClear();
    await sw.loadMarks();
    expect(chrome.bookmarks.getTree).toHaveBeenCalledTimes(1);
    expect(chrome.bookmarks.getChildren).not.toHaveBeenCalled();
    expect(sw.state.marks.map((m) => m.url)).toEqual(['https://kept.com/']);
  });

  it('loadClosed asks Chrome and reads its own log at the same time', async () => {
    const sw = await boot({ tabs: ABC() });
    let release;
    chrome.sessions.getRecentlyClosed.mockImplementationOnce(() => new Promise((r) => { release = () => r([]); }));
    chrome.storage.local.get.mockClear();
    const done = sw.loadClosed();
    await tick(0);
    expect(chrome.storage.local.get.mock.calls.length).toBeGreaterThan(0); // the log, while Chrome's list is pending
    release();
    await done;
    expect(sw.state.closed).toEqual([]);
  });
});
