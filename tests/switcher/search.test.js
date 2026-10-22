// The switcher's search: word scoring (typos and all), highlighting, and the dropdown's merged result list.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootSwitcher, tick } from '../helpers/switcher.js';

const byTestId = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
const allByTestId = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];

let switcher;
const tab = (title, url, more = {}) => ({ title, url, ...more });
const visit = (title, url, timestamp = 1000) => ({ title, url, t: timestamp, n: 1 });

describe('search scoring', () => {
  beforeEach(async () => { switcher = await bootSwitcher(); });

  it('fieldOf splits into lowercase words and initials, and remembers the result', () => {
    const field = switcher.fieldOf('Pull Request #12 - GitHub');
    expect(field.text).toBe('pull request #12 - github');
    expect(field.words).toEqual(['pull', 'request', '12', 'github']);
    expect(field.initials).toBe('pr1g');
    expect(switcher.fieldOf('Pull Request #12 - GitHub')).toBe(field);
  });

  it('fieldOf keeps non-Latin letters as words, without their accents', () => {
    expect(switcher.fieldOf('Привет, мир — café').words).toEqual(['привет', 'мир', 'cafe']);
    expect(switcher.fieldOf('Église Übersicht Καρτέλα Română ș').words).toEqual(['eglise', 'ubersicht', 'καρτελα', 'romana', 's']);
    expect(switcher.fieldOf('עברית العربية').words).toEqual(['עברית', 'العربية']);
  });

  it('a word typed with or without its accents finds it, from its start', () => {
    expect(switcher.searchScore('ιστορικο', 'Ιστορικό του Chrome')).toBe(5);
    expect(switcher.searchScore('ιστορικό', 'Ιστορικο')).toBe(5);
    expect(switcher.searchScore('eglise', 'Église Saint-Paul')).toBe(5);
    expect(switcher.searchScore('übers', 'Ubersicht')).toBe(5);
    expect(switcher.searchScore('επισκεψ', 'Ιστορικό επισκέψεων')).toBe(5);
    expect(switcher.matches('zzz', 'Église')).toBe(false);
  });

  it('typoDistance counts edits and swaps, giving up past max', () => {
    expect(switcher.typoDistance('abc', 'abc', 1)).toBe(0);
    expect(switcher.typoDistance('abc', 'acb', 1)).toBe(1); // one swap
    expect(switcher.typoDistance('abc', 'abxc', 1)).toBe(1);
    expect(switcher.typoDistance('kitten', 'sitting', 5)).toBe(3);
    expect(switcher.typoDistance('a', 'abcd', 1)).toBe(2); // length gap alone is over max
    expect(switcher.typoDistance('abcdef', 'uvwxyz', 1)).toBe(2);
  });

  it('typoNear matches whole words and word starts, and remembers each pair', () => {
    expect(switcher.typoNear('gihtu', 'github')).toBe(true);   // start of a word, letters swapped
    expect(switcher.typoNear('reqeust', 'request')).toBe(true);
    expect(switcher.typoNear('rekwest', 'request')).toBe(false); // two typos in a 7-letter word
    expect(switcher.typoNear('reqeustt', 'request')).toBe(true); // two typos allowed at 8+ letters
    expect(switcher.typoMemo.get('gihtu').get('github')).toBe(true);
  });

  it('inOrder finds letters in order within a word', () => {
    expect(switcher.inOrder('gh', 'github')).toBe(true);
    expect(switcher.inOrder('hg', 'github')).toBe(false);
    expect(switcher.inOrder('gtb', 'github')).toBe(true);
  });

  it('scoreWord: start 5, initials 4, anywhere 3, in order 2, typo 1, else 0', () => {
    const field = switcher.fieldOf('Pull Request #12 - GitHub');
    expect(switcher.scoreWord('pul', field)).toBe(5);
    expect(switcher.scoreWord('12', field)).toBe(5);
    expect(switcher.scoreWord('pr', field)).toBe(4);
    expect(switcher.scoreWord('ques', field)).toBe(3);
    expect(switcher.scoreWord('gh', field)).toBe(2);
    expect(switcher.scoreWord('reqeust', field)).toBe(1);
    expect(switcher.scoreWord('pyll', field)).toBe(1); // 4 letters: one typo
    expect(switcher.scoreWord('pyl', field)).toBe(0);  // under 4 letters: no typos
    expect(switcher.scoreWord('pul1', field)).toBe(0); // digits: as typed only
    expect(switcher.scoreWord('rekwest', field)).toBe(0);
    expect(switcher.scoreWord('zzz', field)).toBe(0);
  });

  it('scoreWord: one letter never counts as initials or letters-in-order', () => {
    expect(switcher.scoreWord('x', switcher.fieldOf('Box'))).toBe(3);
    expect(switcher.scoreWord('q', switcher.fieldOf('Box'))).toBe(0);
  });

  it('wordScore remembers scores on the field', () => {
    const field = switcher.fieldOf('Some Title');
    expect(switcher.wordScore('tit', field)).toBe(5);
    expect(field.scores.get('tit')).toBe(5);
  });

  it('searchScore adds up the best score of each word over all fields; any missing word is 0', () => {
    expect(switcher.searchScore('pul req', 'Pull Request')).toBe(10);
    expect(switcher.searchScore('pul exam', 'Pull', 'https://example.com/')).toBe(10);
    expect(switcher.searchScore('pul ques', 'Pull Request')).toBe(8);
    expect(switcher.searchScore('pul xyz', 'Pull Request')).toBe(0);
    expect(switcher.searchScore('', 'Pull Request')).toBe(0);
    expect(switcher.searchScore('pul', undefined, '', 'Pull')).toBe(5); // missing fields are skipped
    expect(switcher.matches('reqeust', 'Pull Request')).toBe(true);
    expect(switcher.matches('zz', 'Pull Request')).toBe(false);
  });

  it('queryWords and fieldHit', () => {
    expect(switcher.queryWords('  a  bb c ')).toEqual(['a', 'bb', 'c']);
    expect(switcher.fieldHit('zz pull', 'Pull')).toBe(true); // any one word is enough
    expect(switcher.fieldHit('zz', 'Pull')).toBe(false);
    expect(switcher.fieldHit('pull', '')).toBe(false);
  });

  it('matchTier: note 4, title starting with the text 3, title hit 2, address only 1', () => {
    switcher.state.notes = { [new URL('https://n.com/').href]: { u: 'https://n.com/', n: 'deploy steps', t: 1 } };
    expect(switcher.matchTier('deploy', { title: 'Other', url: 'https://n.com/' })).toBe(4);
    expect(switcher.matchTier('git hub', { title: 'Git stuff', url: 'https://x.com/' })).toBe(3); // first word
    expect(switcher.matchTier('hub', { title: 'GitHub hub', url: 'https://x.com/' })).toBe(2);
    expect(switcher.matchTier('hub', { title: 'Repo', url: 'https://hub.com/' })).toBe(1);
  });
});

describe('highlight', () => {
  beforeEach(async () => { switcher = await bootSwitcher(); });
  const html = (text, query) => { const container = document.createElement('div'); container.append(switcher.highlight(text, query)); return container; };
  // The output as text pieces and [marked] pieces
  const parts = (text, query) => [...html(text, query).childNodes].map((node) => (node.nodeType === 3 ? node.data : [node.dataset.testid, node.textContent]));

  it('marks a word typed without its accents, as the text writes it', () => {
    expect(parts('Το Ιστορικό σας', 'ιστορικο')).toEqual(['Το ', ['search-highlight', 'Ιστορικό'], ' σας']);
    expect(parts('Café Église', 'eglise')).toEqual(['Café ', ['search-highlight', 'Église']]);
    expect(parts('😀 Café', 'cafe')).toEqual(['😀 ', ['search-highlight', 'Café']]); // what comes before keeps its length
  });

  it('marks every place a word appears, keeping the original case', () => {
    expect(parts('GitHub Pull pull', 'pull')).toEqual(['GitHub ', ['search-highlight', 'Pull'], ' ', ['search-highlight', 'pull']]);
  });

  it('marks the whole word a typo matched', () => {
    expect(parts('The Reqeust docs', 'request')).toEqual(['The ', ['search-highlight', 'Reqeust'], ' docs']);
  });

  it('does not mark typos of short words or words with digits', () => {
    expect(byTestId('search-highlight', html('Pyll', 'pul'))).toBeNull();
    expect(byTestId('search-highlight', html('Page v3', 'v2'))).toBeNull();
  });

  it('overlapping matches never repeat text', () => {
    const container = html('github', 'git github');
    expect(container.textContent).toBe('github');
    expect(allByTestId('search-highlight', container).map((mark) => mark.textContent).join('')).toBe('github');
  });

  it('page text is never HTML', () => {
    const container = html('<script>alert(1)</script><img src=x onerror=alert(1)> news', 'news');
    expect([...container.children].map((child) => child.dataset.testid)).toEqual(['search-highlight']); // the only element: our mark
    expect(container.textContent).toBe('<script>alert(1)</script><img src=x onerror=alert(1)> news');
    expect(byTestId('search-highlight', container).textContent).toBe('news');
  });

  it('empty text gives an empty fragment; hlSpan wraps it in a span', () => {
    expect(switcher.highlight('', 'x').childNodes.length).toBe(0);
    const span = switcher.highlightSpan('dropdown-title', '<b>Bold</b>', 'bold');
    expect(span.dataset.testid).toBe('dropdown-title');
    expect([...span.children].map((child) => [child.dataset.testid, child.textContent])).toEqual([['search-highlight', 'Bold']]);
    expect(span.textContent).toBe('<b>Bold</b>');
  });
});

describe('deriveSearch', () => {
  it('lists matching open tabs: tier, then score, then recent use', async () => {
    switcher = await bootSwitcher({
      tabs: [
        tab('Start', 'https://start.com/'),
        tab('Docs', 'https://alpha.com/'),        // address only: tier 1
        tab('My alpha page', 'https://a.com/'),   // title: tier 2
        tab('Alpha home', 'https://b.com/'),      // title starts: tier 3
        tab('Xalpha', 'https://c.com/'),          // title, anywhere (3): tier 2, lower score
      ],
    });
    switcher.state.query = '  Alpha ';
    switcher.deriveSearch();
    expect(switcher.state.found.map((entry) => entry.tab.title)).toEqual(['Alpha home', 'My alpha page', 'Xalpha', 'Docs']);
    expect(switcher.state.found[0]).toMatchObject({ kind: 'tab', key: 't' + switcher.state.found[0].tab.id });
  });

  it('nothing typed, nothing found', async () => {
    switcher = await bootSwitcher();
    switcher.state.query = '   ';
    switcher.deriveSearch();
    expect(switcher.state.found).toEqual([]);
    expect(switcher.state.foundClosed).toEqual([]);
  });

  it('finds recently closed pages too', async () => {
    switcher = await bootSwitcher();
    switcher.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://zeta.com/', title: 'Zeta', timestamp: Date.now() - 864e5, count: 1, fields: [['Zeta', 'https://zeta.com/']] }];
    switcher.state.query = 'zet';
    switcher.deriveSearch();
    expect(switcher.state.foundClosed.map((item) => item.id)).toEqual(['l1']); // a day old: older than the 4 h shown without a search
  });
});

describe('the dropdown rows', () => {
  const rows = () => switcher.dropdownRows().filter((row) => row.kind);
  const go = (query) => { switcher.state.query = query; switcher.deriveSearch(); return rows(); };
  const closedItem = (id, title, url) => ({ id, kind: 'tab', url, title, timestamp: Date.now(), count: 1, fields: [[title, url]] });

  beforeEach(async () => {
    switcher = await bootSwitcher({ tabs: [tab('Start', 'https://start.com/'), tab('Alpha tab', 'https://t.com/')] });
    switcher.state.marks = [];
    switcher.state.history = [];
  });

  it('ties go open tab, recently closed, archived, bookmark, history', () => {
    switcher.state.history = [visit('Alpha visit', 'https://v.com/')];
    switcher.state.marks = [{ title: 'Alpha mark', url: 'https://m.com/', path: '' }];
    switcher.state.archived = [{ id: '9', title: 'Alpha archived', url: 'https://ar.com/', t: 1 }];
    switcher.state.closed = [closedItem('l1', 'Alpha closed', 'https://cl.com/')];
    expect(go('alpha').map((row) => row.kind)).toEqual(['tab', 'closed', 'archived', 'mark', 'visit']);
  });

  it('a better match comes first, whatever its source', () => {
    switcher.state.history = [visit('Beta', 'https://v.com/')];
    switcher.state.marks = [{ title: 'Xbeta', url: 'https://m.com/', path: '' }];
    const rows = go('beta');
    expect(rows.map((x) => [x.kind, x.score])).toEqual([['visit', 5], ['mark', 3]]);
  });

  it('within a source, ties keep that source’s order', () => {
    switcher.state.history = [visit('Gamma one', 'https://1.com/', 3), visit('Gamma two', 'https://2.com/', 2), visit('Gamma three', 'https://3.com/', 1)];
    expect(go('gamma').map((row) => row.visit.title)).toEqual(['Gamma one', 'Gamma two', 'Gamma three']);
  });

  it('a page found in several places is one row, as the most useful source with the best score', () => {
    switcher.state.marks = [{ title: 'Lphabet', url: 'https://t.com/#top', path: '' }];
    switcher.state.history = [visit('Alpha', 'https://t.com/')];
    expect(go('alpha').map((x) => [x.kind, x.score])).toEqual([['tab', 5]]);
    // "lpha" is only inside the tab's title (3) but starts the bookmark's (5): the tab row gets the 5.
    expect(go('lpha').map((x) => [x.kind, x.score])).toEqual([['tab', 5]]);
  });

  it('a closed window is its own row, even when one of its pages is open', () => {
    switcher.state.closed = [{ id: 'w1', kind: 'window', url: 'https://t.com/', title: 'Window', timestamp: Date.now(), count: 2, fields: [['Alpha tab', 'https://t.com/'], ['Other', 'https://o.com/']] }];
    expect(go('alpha').map((row) => row.kind)).toEqual(['tab', 'closed']);
  });

  it('shows at most DD_MAX rows', () => {
    switcher.state.history = Array.from({ length: 30 }, (unused, i) => visit('Delta ' + i, `https://d${i}.com/`, 100 - i));
    expect(go('delta')).toHaveLength(switcher.DROPDOWN_MAX);
  });

  it('nothing found: open the address (when it is one), and a Google search', () => {
    expect(go('example.org')).toEqual([{ kind: 'url', url: 'https://example.org', key: 'url:https://example.org' }, { kind: 'google', key: 'google' }]);
    expect(go('qqq zzz')).toEqual([{ kind: 'google', key: 'google' }]);
    expect(go('')).toEqual([]);
  });

  it('says so when bookmarks or history can’t be read', () => {
    const { bookmarks, history } = chrome;
    delete chrome.bookmarks; delete chrome.history;
    try {
      switcher.state.query = 'alpha';
      switcher.deriveSearch();
      const notes = switcher.dropdownRows().filter((row) => row.note).map((row) => row.note);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatch(/Bookmarks/);
      expect(notes[1]).toMatch(/History/);
    } finally { Object.assign(chrome, { bookmarks, history }); }
  });
});

describe('history and bookmarks', () => {
  beforeEach(async () => { switcher = await bootSwitcher(); });

  it('history maps a history item with defaults', () => {
    expect(switcher.historyEntryOf({ url: 'https://a.com/' })).toEqual({ url: 'https://a.com/', title: '', t: 0, n: 0 });
    expect(switcher.historyEntryOf({ url: 'u', title: 'T', lastVisitTime: 5, visitCount: 2 })).toEqual({ url: 'u', title: 'T', t: 5, n: 2 });
  });

  it('urlKey normalizes and remembers; unusable addresses stay as they are', () => {
    expect(switcher.urlKey('https://a.com/x/#h')).toBe('https://a.com/x');
    expect(switcher.urlKeys.get('https://a.com/x/#h')).toBe('https://a.com/x');
    expect(switcher.urlKey('not a url')).toBe('not a url');
  });

  it('historyItems merges both lists once per page, newest first, and is memoized', () => {
    switcher.state.query = 'a';
    switcher.state.history = [visit('Old', 'https://a.com/', 1), visit('New', 'https://b.com/', 9)];
    switcher.state.historyQuery = { query: 'a', items: [visit('Again', 'https://a.com/#x', 5), visit('Far', 'https://c.com/', 3)] };
    const items = switcher.historyItems();
    expect(items.map((x) => x.title)).toEqual(['New', 'Far', 'Old']);
    expect(switcher.historyItems()).toBe(items);
    switcher.state.query = 'ab'; // Chrome's search was for other text: left out
    expect(switcher.historyItems().map((x) => x.title)).toEqual(['New', 'Old']);
  });

  it('loadMarks reads web bookmarks with their folder path, leaving out the Tabs Archive', async () => {
    const devFolder = chrome._addBookmark({ parentId: '1', title: 'Dev' });
    const repo = chrome._addBookmark({ parentId: devFolder.id, title: 'Repo', url: 'https://repo.com/' });
    const plain = chrome._addBookmark({ parentId: '2', title: 'Plain', url: 'file:///c/x.txt' });
    chrome._addBookmark({ parentId: '2', title: 'Script', url: 'javascript:alert(1)' });
    const archiveFolder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: archiveFolder.id, title: 'Archived', url: 'https://arch.com/' });
    await switcher.loadMarks();
    expect(switcher.state.marks).toEqual([
      { id: repo.id, title: 'Repo', url: 'https://repo.com/', path: 'Bookmarks bar › Dev' },
      { id: plain.id, title: 'Plain', url: 'file:///c/x.txt', path: 'Other bookmarks' },
    ]);
  });

  it('a bookmark is found by its own note (the bookmark’s, not the page’s), which shows in its result', async () => {
    const bookmark = chrome._addBookmark({ parentId: '1', title: 'Roadmap', url: 'https://road.example/' });
    await chrome.storage.local.set({ bmNotes: { [bookmark.id]: { u: 'https://road.example/', n: 'quarterly planning doc', t: Date.now() } } });
    await switcher.loadMarks();
    switcher.state.query = 'quarterly';
    switcher.deriveSearch();
    const rows = switcher.dropdownRows();
    const markRow = rows.find((x) => x.kind === 'mark');
    expect(markRow && markRow.bookmark.url).toBe('https://road.example/');
    const node = switcher.dropdownRowElement(markRow, 'quarterly', false, 'dropdown-0');
    expect(byTestId('dropdown-note', node).textContent).toBe('quarterly planning doc');
  });

  it('loadMarks: no bookmarks access or a failing read gives an empty list', async () => {
    chrome.bookmarks.getTree.mockRejectedValue(new Error('nope'));
    await switcher.loadMarks();
    expect(switcher.state.marks).toEqual([]);
    const { bookmarks } = chrome;
    delete chrome.bookmarks;
    try { await switcher.loadMarks(); expect(switcher.state.marks).toEqual([]); } finally { chrome.bookmarks = bookmarks; }
  });

  it('loadHistory reads 90 days of web pages', async () => {
    chrome._data.history = [
      { url: 'https://a.com/', title: 'A', lastVisitTime: Date.now() - 864e5, visitCount: 3 },
      { url: 'chrome://settings/', title: 'Settings', lastVisitTime: Date.now() },
      { url: 'https://old.com/', title: 'Old', lastVisitTime: Date.now() - 100 * 864e5 },
    ];
    await switcher.loadHistory();
    expect(switcher.state.history).toEqual([{ url: 'https://a.com/', title: 'A', t: chrome._data.history[0].lastVisitTime, n: 3 }]);
    const query = chrome.history.search.mock.calls.at(-1)[0];
    expect(query).toMatchObject({ text: '', maxResults: 5000 });
    expect(Date.now() - query.startTime).toBeGreaterThanOrEqual(90 * 864e5);
  });

  it('searchHistory asks Chrome after a pause, and keeps the answer only for the current text', async () => {
    chrome._data.history = [{ url: 'https://far.com/', title: 'Far back', lastVisitTime: 1 }, { url: 'about:blank', title: 'far' }];
    switcher.state.query = 'far';
    switcher.searchHistory('far');
    expect(chrome.history.search).not.toHaveBeenCalled();
    await tick(150);
    expect(chrome.history.search).toHaveBeenLastCalledWith({ text: 'far', startTime: 0, maxResults: 60 });
    expect(switcher.state.historyQuery).toEqual({ query: 'far', items: [{ url: 'https://far.com/', title: 'Far back', t: 1, n: 0 }] });

    switcher.searchHistory('fa'); // typed on meanwhile: the answer is dropped
    switcher.state.query = 'f';
    await tick(150);
    expect(switcher.state.historyQuery.query).toBe('far');

    switcher.searchHistory('');
    expect(switcher.state.historyQuery).toEqual({ query: '', items: [] });
  });

  it('scoreBig narrows to earlier hits while the text grows, then rescores everything after a pause', async () => {
    const items = [{ t: 'abcd' }, { t: 'xbcd' }, { t: 'zzzz' }];
    const run = (query) => { const spy = vi.fn((item) => switcher.searchScore(query, item.t)); return { hits: switcher.scoreBig('t', items, query, spy).map((x) => x.item.t), calls: spy.mock.calls.length }; };
    expect(run('abc')).toEqual({ hits: ['abcd'], calls: 3 });
    expect(run('abc')).toEqual({ hits: ['abcd'], calls: 0 }); // same text: remembered
    expect(run('abcd')).toEqual({ hits: ['abcd'], calls: 1 }); // only the earlier hit is scored
    await tick(200);
    expect(switcher.bigHits.t.query).toBe('');
    expect(run('abcd')).toEqual({ hits: ['abcd', 'xbcd'], calls: 3 }); // the typo match shows up now
    expect(run('ab')).toMatchObject({ calls: 3 }); // text got shorter: everything again
  });

  it('scoreBig starts over for a new list', () => {
    const items = [{ t: 'abcd' }];
    switcher.scoreBig('n', items, 'ab', (item) => switcher.searchScore('ab', item.t));
    const moreItems = [{ t: 'abcd' }, { t: 'abce' }];
    expect(switcher.scoreBig('n', moreItems, 'abc', (item) => switcher.searchScore('abc', item.t)).map((x) => x.score)).toEqual([5, 5]);
  });
});

describe('opening from the box', () => {
  beforeEach(async () => { switcher = await bootSwitcher(); });

  it('asUrl recognises addresses', () => {
    expect(switcher.asUrl('https://x.com/a b')).toBeNull();
    expect(switcher.asUrl('https://x.com/a')).toBe('https://x.com/a');
    expect(switcher.asUrl('chrome-extension://abc/page.html')).toBe('chrome-extension://abc/page.html');
    expect(switcher.asUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(switcher.asUrl('192.168.0.1')).toBe('http://192.168.0.1');
    expect(switcher.asUrl('docs.example.co.uk/path?q=1')).toBe('https://docs.example.co.uk/path?q=1');
    expect(switcher.asUrl('example.com:8080')).toBe('https://example.com:8080');
    expect(switcher.asUrl('hello')).toBeNull();
    expect(switcher.asUrl('file.x')).toBeNull(); // one-letter "TLD"
    expect(switcher.asUrl('')).toBeNull();
  });

  it('googleUrl encodes the text', () => {
    expect(switcher.googleUrl('a&b c/?')).toBe('https://www.google.com/search?q=a%26b%20c%2F%3F');
  });
});

describe('searching by what a page is', () => {
  it('open tabs by their state: pinned, asleep, playing, muted, starred, with a note, in a group; with other words too', async () => {
    const switcher = await bootSwitcher({ tabs: [
      tab('Plain', 'https://plain.example/'), { ...tab('Docs', 'https://docs.example/'), pinned: true }, { ...tab('Radio', 'https://radio.example/'), audible: true },
      { ...tab('Old', 'https://old.example/'), discarded: true }, { ...tab('Quiet', 'https://quiet.example/'), mutedInfo: { muted: true } },
      { ...tab('Youtube pinned', 'https://youtube.example/'), pinned: true },
    ] });
    const titles = (query) => { switcher.state.query = query; switcher.deriveSearch(); return switcher.state.found.map((entry) => entry.tab.title).sort(); };
    expect(titles('pinned')).toEqual(['Docs', 'Youtube pinned']);
    expect(titles('pinned docs')).toEqual(['Docs']);
    expect(titles('asleep')).toEqual(['Old']);
    expect(titles('playing')).toEqual(['Radio']);
    expect(titles('muted')).toEqual(['Quiet']);
    expect(titles('plain')).toEqual(['Plain']); // and the rest as before: a state's words aren't typos ("playing")
    expect(titles('pinn')).toEqual(['Docs', 'Youtube pinned']); // from their start
    expect(titles('pi')).not.toContain('Docs'); // (three letters at least for a state: Docs is found only by it)
  });

  it('pages by where they are: recently closed, archived, bookmarked, in the history (the dropdown)', async () => {
    switcher = await bootSwitcher({ tabs: [tab('Start', 'https://start.com/')] });
    switcher.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://gone.example/', title: 'Gone page', timestamp: Date.now(), count: 1, fields: [['Gone page', 'https://gone.example/']] }];
    switcher.state.archived = [{ id: '9', title: 'Kept page', url: 'https://kept.example/', t: 1 }];
    switcher.state.marks = [{ id: '5', title: 'Marked page', url: 'https://marked.example/', path: '' }];
    switcher.state.history = [visit('Seen page', 'https://seen.example/')];
    const kinds = (query) => { switcher.state.query = query; switcher.deriveSearch(); return switcher.dropdownRows().filter((row) => row.kind).map((row) => row.kind); };
    expect(kinds('closed')).toEqual(['closed']);
    expect(kinds('archived')).toEqual(['archived']);
    expect(kinds('bookmarked')).toEqual(['mark']);
    expect(kinds('history')).toEqual(['visit']);
  });

  it('in Spanish, by the Spanish words and the English ones', async () => {
    switcher = await bootSwitcher({ tabs: [tab('Plain', 'https://plain.example/'), { ...tab('Docs', 'https://docs.example/'), pinned: true }], preferences: { lang: 'es' } });
    const titles = (query) => { switcher.state.query = query; switcher.deriveSearch(); return switcher.state.found.map((entry) => entry.tab.title); };
    expect(titles('fijada')).toEqual(['Docs']);
    expect(titles('pinned')).toEqual(['Docs']);
  });
});
