// What keeps opening and redrawing the switcher quick: the first draw reads only the previews it shows,
// icons are parsed once, screenshots and untouched cards are kept between redraws, resizes are coalesced.
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor } from '../helpers/switcher.js';
import { boot, ABC, openCards, titleOf, byTestId, allByTestId, selectedCard } from '../helpers/switcher-ui.js';

const IMAGE = 'data:image/jpeg;base64,AAAA';
const many = (count) => Array.from({ length: count }, (unused, i) => ({ title: 'Tab ' + (i + 1), url: `https://t${i + 1}.example/` }));
const card = (title) => openCards().find((tabCard) => titleOf(tabCard) === title);
const entry = (switcher, title) => switcher.state.entries.find((item) => item.kind === 'tab' && item.tab.title === title);
// The preview keys each storage read asked for (one array per read that asked for any).
const previewReads = () => chrome.storage.local.get.mock.calls.map(([keys]) => [].concat(keys || []).filter((x) => typeof x === 'string' && x.startsWith('pv:'))).filter((x) => x.length);

describe('the first draw', () => {
  it('reads the previews of the first cards only, then the rest in one read, and shows them all', async () => {
    const tabs = many(50);
    const switcher = await boot({
      tabs,
      beforeImport: () => chrome.storage.local.set(Object.fromEntries(tabs.map((x, i) => ['pv:' + x.url, { img: IMAGE, t: 1000 + i }]))),
    });
    await waitFor(() => allByTestId('card-preview').length === 50);
    const reads = previewReads();
    expect(reads.length).toBe(2);
    expect(reads[0].length).toBeLessThanOrEqual(switcher.previewBatch() + 2); // the cards that fit, the selected one, the current tab
    expect(reads[0].length).toBeLessThan(32); // fewer than the old fixed batch: a 1024 x 768 window shows about a dozen
    expect(reads[0]).toContain('pv:https://t1.example/'); // the current tab
    expect(reads[0]).toContain('pv:' + entry(switcher, 'Tab 2').tab.url); // the selected card (the tab used before)
    expect(new Set([...reads[0], ...reads[1]]).size).toBe(50);
    expect(reads[0].filter((previewKey) => reads[1].includes(previewKey))).toEqual([]); // none read twice
    expect(switcher.state.previewPending.size).toBe(0);
    expect(openCards().every((card) => byTestId('card-preview', card))).toBe(true);
  });

  it('previewBatch: as many cards as fit on the screen at the card size, one row more', async () => {
    const switcher = await boot({ tabs: ABC() });
    expect(switcher.previewBatch(1024, 768)).toBe(12); // 3 across, 3 rows down, and one more
    expect(switcher.previewBatch(1920, 1080)).toBeGreaterThan(switcher.previewBatch(1024, 768));
    switcher.state.cardSize = 'small';
    expect(switcher.previewBatch(1024, 768)).toBeGreaterThan(12);
    switcher.state.cardSize = 'list';
    expect(switcher.previewBatch(1024, 768)).toBeGreaterThan(30);
    expect(switcher.previewBatch(0, 0)).toBe(switcher.FIRST_PREVIEWS); // size unknown
  });

  it('a card whose preview is still being read shows a plain placeholder: its favicon, no "No preview yet", no Capture', async () => {
    const switcher = await boot({ tabs: ABC() });
    const bravo = entry(switcher, 'Bravo');
    switcher.state.previewPending.add(bravo.tab.id);
    switcher.refresh();
    expect(byTestId('card-loading', card('Bravo'))).not.toBe(null);
    expect(byTestId('card-tile-favicon', card('Bravo'))).not.toBe(null);
    expect(byTestId('card-no-preview-label', card('Bravo'))).toBe(null);
    expect(byTestId('card-capture', card('Bravo'))).toBe(null);
    expect(switcher.missingPreviews().map((x) => x.title)).not.toContain('Bravo');
    switcher.state.previewPending.delete(bravo.tab.id);
    switcher.refresh();
    expect(byTestId('card-loading', card('Bravo'))).toBe(null);
    expect(byTestId('card-capture', card('Bravo'))).not.toBe(null);
  });

  it('reads the settings once', async () => {
    await boot({ tabs: ABC(), preferences: { lang: 'es', cardSize: 'small' } });
    const preferenceReads = chrome.storage.local.get.mock.calls.filter(([keys]) => [].concat(keys).includes('prefs'));
    expect(preferenceReads.length).toBe(1);
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('icons', () => {
  it('svgOf gives the same markup as parsing the icon, as a fresh copy each time', async () => {
    const switcher = await boot({ tabs: ABC() });
    for (const markup of Object.values(switcher.ICON)) {
      const parsed = document.createElement('span');
      parsed.innerHTML = markup;
      const cloned = document.createElement('span');
      cloned.append(switcher.svgOf(markup));
      expect(cloned.innerHTML).toBe(parsed.innerHTML);
      expect(cloned.firstChild.namespaceURI).toBe('http://www.w3.org/2000/svg');
    }
    const firstIcon = switcher.svgOf(switcher.ICON.star), secondIcon = switcher.svgOf(switcher.ICON.star);
    expect(firstIcon.firstChild).not.toBe(secondIcon.firstChild);
  });
});

describe('redraws', () => {
  it('keep a card\'s screenshot element between redraws, and make a new one for a new capture', async () => {
    const switcher = await boot({ tabs: ABC(), beforeImport: () => chrome.storage.local.set({ 'pv:https://bravo.example/': { img: IMAGE, t: 1 } }) });
    const before = card('Bravo');
    const image = byTestId('card-preview', before);
    expect(image).not.toBe(null);
    switcher.refresh();
    expect(card('Bravo')).not.toBe(before); // a new card...
    expect(byTestId('card-preview', card('Bravo'))).toBe(image); // ...with the same picture
    await chrome.storage.local.set({ 'pv:https://bravo.example/': { img: IMAGE + 'B', t: 2 } });
    const now = byTestId('card-preview', card('Bravo'));
    expect(now).not.toBe(image);
    expect(now.getAttribute('src')).toBe(IMAGE + 'B');
  });

  it('a tick, a star or mute builds again only the cards it changes', async () => {
    const switcher = await boot({ tabs: ABC() });
    const [alpha, bravo, charlie] = ['Alpha', 'Bravo', 'Charlie'].map(card);
    switcher.pick(entry(switcher, 'Bravo'));
    expect(card('Alpha')).toBe(alpha);
    expect(card('Charlie')).toBe(charlie);
    expect(card('Bravo')).not.toBe(bravo);
    expect(card('Bravo').getAttribute('aria-checked')).toBe('true');
    expect(byTestId('card-pick', card('Bravo')).getAttribute('aria-checked')).toBe('true');
    expect(selectedCard()).toBe(card('Bravo')); // the selection follows the tick, as before
    expect(allByTestId('card-tab').filter((x) => x.getAttribute('aria-selected') === 'true').length).toBe(1);
    expect(byTestId('actions').hidden).toBe(false);

    await switcher.star(entry(switcher, 'Alpha'));
    expect(card('Alpha')).not.toBe(alpha);
    expect(byTestId('card-star-button', card('Alpha')).getAttribute('aria-pressed')).toBe('true');
    expect(card('Charlie')).toBe(charlie);
    expect(byTestId('star-count').textContent).toBe('1');

    const charlieAgain = card('Charlie');
    await switcher.toggleMute(entry(switcher, 'Bravo').tab);
    expect(card('Charlie')).toBe(charlieAgain);
    expect(byTestId('card-audio', card('Bravo'))).not.toBe(null);
  });

  it('a search keystroke dims cards without building them again, and the card buttons keep their mouse-only marks', async () => {
    const switcher = await boot({ tabs: ABC() });
    const before = openCards();
    switcher.pick(entry(switcher, 'Alpha'));
    switcher.pick(entry(switcher, 'Bravo'));
    const now = openCards();
    switcher.state.query = 'charl';
    switcher.flushSearch();
    expect(openCards()).toEqual(now);
    expect(card('Alpha').classList.contains('no-match')).toBe(true);
    expect(now[2]).toBe(before[2]);
    for (const button of now[0].querySelectorAll('button')) {
      expect(button.tabIndex).toBe(-1);
      expect(button.getAttribute('aria-hidden')).toBe('true');
    }
    expect(now[0].getAttribute('aria-describedby')).toBe('description-' + now[0].id);
  });

  it('a preview saved while open draws just its cards', async () => {
    const switcher = await boot({ tabs: ABC() });
    const [alpha, bravo] = ['Alpha', 'Bravo'].map(card);
    expect(byTestId('card-preview', bravo)).toBe(null);
    await chrome.storage.local.set({ 'pv:https://bravo.example/#x': { img: IMAGE, t: 5 } }); // (stored by normalized URL)
    await chrome.storage.local.set({ 'pv:https://bravo.example/': { img: IMAGE, t: 5 } });
    expect(byTestId('card-preview', card('Bravo'))).not.toBe(null);
    expect(card('Alpha')).toBe(alpha);
    expect(entry(switcher, 'Bravo').preview.t).toBe(5);
  });

  it('resizing redraws once per frame, and builds the cards again only when their width changes', async () => {
    const switcher = await boot({ tabs: ABC() });
    const grid = byTestId('open-grid');
    let builds = 0;
    const observer = new MutationObserver((records) => { builds += records.filter((record) => record.target === grid && record.addedNodes.length).length; });
    observer.observe(grid, { childList: true });
    grid.style.width = '1000px';
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('resize'));
    await tick(30);
    expect(builds).toBe(1);
    const alpha = card('Alpha');
    window.dispatchEvent(new Event('resize')); // same width: the cards stay
    await tick(30);
    expect(builds).toBe(1);
    expect(card('Alpha')).toBe(alpha);
    observer.disconnect();
    expect(switcher.state.cardWidth).toBe(Math.floor(switcher.cardWidth(switcher.state.matchCount)));
  });

  it('selecting a card by its place touches only the old and the new card', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.select(switcher.state.entries.findIndex((entry) => entry.tab.title === 'Charlie'), { scroll: false });
    expect(selectedCard()).toBe(card('Charlie'));
    expect(allByTestId('card-tab').filter((x) => x.getAttribute('aria-selected') === 'true').length).toBe(1);
    expect(card('Charlie').closest('[role=listbox]').getAttribute('aria-activedescendant')).toBe(card('Charlie').id);
    expect(byTestId('search').getAttribute('aria-activedescendant')).toBe(card('Charlie').id);
  });
});

describe('duplicates', () => {
  it('are worked out once per derive', async () => {
    const switcher = await boot({ tabs: [{ title: 'A1', url: 'https://a.com/' }, { title: 'A2', url: 'https://a.com/#x' }, { title: 'B', url: 'https://b.com/' }] });
    const duplicateTabs = switcher.duplicates();
    expect(switcher.duplicates()).toBe(duplicateTabs);
    expect(duplicateTabs.map((x) => x.title)).toEqual(['A2']);
    switcher.derive();
    expect(switcher.duplicates()).not.toBe(duplicateTabs);
    expect(switcher.duplicateIds().has(duplicateTabs[0].id)).toBe(true);
    switcher.duplicatesView(true);
    expect(allByTestId('card-duplicate-closes').length).toBe(1);
    expect(allByTestId('card-duplicate-stays').length).toBe(1);
  });
});

describe('reading', () => {
  it('loadMarks reads the bookmark tree once and leaves the archive folder out', async () => {
    const switcher = await boot({ tabs: ABC() });
    const archiveFolder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: archiveFolder.id, title: 'Archived', url: 'https://arch.com/' });
    chrome._addBookmark({ parentId: '2', title: 'Kept', url: 'https://kept.com/' });
    chrome.bookmarks.getTree.mockClear();
    chrome.bookmarks.getChildren.mockClear();
    await switcher.loadMarks();
    expect(chrome.bookmarks.getTree).toHaveBeenCalledTimes(1);
    expect(chrome.bookmarks.getChildren).not.toHaveBeenCalled();
    expect(switcher.state.marks.map((mark) => mark.url)).toEqual(['https://kept.com/']);
  });

  it('loadClosed asks Chrome and reads its own log at the same time', async () => {
    const switcher = await boot({ tabs: ABC() });
    let release;
    chrome.sessions.getRecentlyClosed.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    chrome.storage.local.get.mockClear();
    const done = switcher.loadClosed();
    await tick(0);
    expect(chrome.storage.local.get.mock.calls.length).toBeGreaterThan(0); // the log, while Chrome's list is pending
    release();
    await done;
    expect(switcher.state.closed).toEqual([]);
  });
});

describe('Lite mode (Settings)', () => {
  it('reads no previews and shows each page\'s icon; no animations (html.lite), no "Capture all" button', async () => {
    const tabs = many(5);
    await boot({
      tabs, preferences: { lite: true },
      beforeImport: () => chrome.storage.local.set(Object.fromEntries(tabs.map((x, i) => ['pv:' + x.url, { img: IMAGE, t: 1000 + i }]))),
    });
    await tick(50);
    expect(previewReads()).toEqual([]);
    expect(allByTestId('card-preview')).toHaveLength(0);
    expect(allByTestId('card-icon-only')).toHaveLength(5);
    expect(document.documentElement.classList.contains('lite')).toBe(true);
    expect(byTestId('sweep-button').hidden).toBe(true);
  });
});

describe('many cards', () => {
  it('past MANY_CARDS cards, the default size prefers narrower cards (more fit, each costs less to draw)', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.cardSize = 'default';
    switcher.state.cardCount = 10;
    const few = switcher.gridColumns(1280);
    switcher.state.cardCount = switcher.MANY_CARDS + 1;
    const lots = switcher.gridColumns(1280);
    expect(lots.columns).toBeGreaterThan(few.columns);
    expect(Math.round((1280 + 18) / (switcher.MANY_CARDS_WIDTH + 18))).toBe(lots.columns);
    switcher.state.cardSize = 'small'; // the other sizes are as chosen
    const small = switcher.gridColumns(1280);
    switcher.state.cardCount = 10;
    expect(switcher.gridColumns(1280)).toEqual(small);
  });
});

