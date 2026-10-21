// The switcher's search: word scoring (typos and all), highlighting, and the dropdown's merged result list.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootSwitcher, tick } from '../helpers/switcher.js';

const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
const tids = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];

let sw;
const tab = (title, url, more = {}) => ({ title, url, ...more });
const visit = (title, url, t = 1000) => ({ title, url, t, n: 1 });

describe('search scoring', () => {
  beforeEach(async () => { sw = await bootSwitcher(); });

  it('fieldOf splits into lowercase words and initials, and remembers the result', () => {
    const f = sw.fieldOf('Pull Request #12 - GitHub');
    expect(f.text).toBe('pull request #12 - github');
    expect(f.words).toEqual(['pull', 'request', '12', 'github']);
    expect(f.initials).toBe('pr1g');
    expect(sw.fieldOf('Pull Request #12 - GitHub')).toBe(f);
  });

  it('fieldOf keeps non-Latin letters as words', () => {
    expect(sw.fieldOf('Привет, мир — café').words).toEqual(['привет', 'мир', 'café']);
  });

  it('typoDistance counts edits and swaps, giving up past max', () => {
    expect(sw.typoDistance('abc', 'abc', 1)).toBe(0);
    expect(sw.typoDistance('abc', 'acb', 1)).toBe(1); // one swap
    expect(sw.typoDistance('abc', 'abxc', 1)).toBe(1);
    expect(sw.typoDistance('kitten', 'sitting', 5)).toBe(3);
    expect(sw.typoDistance('a', 'abcd', 1)).toBe(2); // length gap alone is over max
    expect(sw.typoDistance('abcdef', 'uvwxyz', 1)).toBe(2);
  });

  it('typoNear matches whole words and word starts, and remembers each pair', () => {
    expect(sw.typoNear('gihtu', 'github')).toBe(true);   // start of a word, letters swapped
    expect(sw.typoNear('reqeust', 'request')).toBe(true);
    expect(sw.typoNear('rekwest', 'request')).toBe(false); // two typos in a 7-letter word
    expect(sw.typoNear('reqeustt', 'request')).toBe(true); // two typos allowed at 8+ letters
    expect(sw.typoMemo.get('gihtu').get('github')).toBe(true);
  });

  it('inOrder finds letters in order within a word', () => {
    expect(sw.inOrder('gh', 'github')).toBe(true);
    expect(sw.inOrder('hg', 'github')).toBe(false);
    expect(sw.inOrder('gtb', 'github')).toBe(true);
  });

  it('scoreWord: start 5, initials 4, anywhere 3, in order 2, typo 1, else 0', () => {
    const f = sw.fieldOf('Pull Request #12 - GitHub');
    expect(sw.scoreWord('pul', f)).toBe(5);
    expect(sw.scoreWord('12', f)).toBe(5);
    expect(sw.scoreWord('pr', f)).toBe(4);
    expect(sw.scoreWord('ques', f)).toBe(3);
    expect(sw.scoreWord('gh', f)).toBe(2);
    expect(sw.scoreWord('reqeust', f)).toBe(1);
    expect(sw.scoreWord('pyll', f)).toBe(1); // 4 letters: one typo
    expect(sw.scoreWord('pyl', f)).toBe(0);  // under 4 letters: no typos
    expect(sw.scoreWord('pul1', f)).toBe(0); // digits: as typed only
    expect(sw.scoreWord('rekwest', f)).toBe(0);
    expect(sw.scoreWord('zzz', f)).toBe(0);
  });

  it('scoreWord: one letter never counts as initials or letters-in-order', () => {
    expect(sw.scoreWord('x', sw.fieldOf('Box'))).toBe(3);
    expect(sw.scoreWord('q', sw.fieldOf('Box'))).toBe(0);
  });

  it('wordScore remembers scores on the field', () => {
    const f = sw.fieldOf('Some Title');
    expect(sw.wordScore('tit', f)).toBe(5);
    expect(f.scores.get('tit')).toBe(5);
  });

  it('searchScore adds up the best score of each word over all fields; any missing word is 0', () => {
    expect(sw.searchScore('pul req', 'Pull Request')).toBe(10);
    expect(sw.searchScore('pul exam', 'Pull', 'https://example.com/')).toBe(10);
    expect(sw.searchScore('pul ques', 'Pull Request')).toBe(8);
    expect(sw.searchScore('pul xyz', 'Pull Request')).toBe(0);
    expect(sw.searchScore('', 'Pull Request')).toBe(0);
    expect(sw.searchScore('pul', undefined, '', 'Pull')).toBe(5); // missing fields are skipped
    expect(sw.matches('reqeust', 'Pull Request')).toBe(true);
    expect(sw.matches('zz', 'Pull Request')).toBe(false);
  });

  it('queryWords and fieldHit', () => {
    expect(sw.queryWords('  a  bb c ')).toEqual(['a', 'bb', 'c']);
    expect(sw.fieldHit('zz pull', 'Pull')).toBe(true); // any one word is enough
    expect(sw.fieldHit('zz', 'Pull')).toBe(false);
    expect(sw.fieldHit('pull', '')).toBe(false);
  });

  it('matchTier: note 4, title starting with the text 3, title hit 2, address only 1', () => {
    sw.state.notes = { [new URL('https://n.com/').href]: { u: 'https://n.com/', n: 'deploy steps', t: 1 } };
    expect(sw.matchTier('deploy', { title: 'Other', url: 'https://n.com/' })).toBe(4);
    expect(sw.matchTier('git hub', { title: 'Git stuff', url: 'https://x.com/' })).toBe(3); // first word
    expect(sw.matchTier('hub', { title: 'GitHub hub', url: 'https://x.com/' })).toBe(2);
    expect(sw.matchTier('hub', { title: 'Repo', url: 'https://hub.com/' })).toBe(1);
  });
});

describe('highlight', () => {
  beforeEach(async () => { sw = await bootSwitcher(); });
  const html = (text, q) => { const d = document.createElement('div'); d.append(sw.highlight(text, q)); return d; };
  // The output as text pieces and [marked] pieces
  const parts = (text, q) => [...html(text, q).childNodes].map((n) => (n.nodeType === 3 ? n.data : [n.dataset.testid, n.textContent]));

  it('marks every place a word appears, keeping the original case', () => {
    expect(parts('GitHub Pull pull', 'pull')).toEqual(['GitHub ', ['search-highlight', 'Pull'], ' ', ['search-highlight', 'pull']]);
  });

  it('marks the whole word a typo matched', () => {
    expect(parts('The Reqeust docs', 'request')).toEqual(['The ', ['search-highlight', 'Reqeust'], ' docs']);
  });

  it('does not mark typos of short words or words with digits', () => {
    expect(tid('search-highlight', html('Pyll', 'pul'))).toBeNull();
    expect(tid('search-highlight', html('Page v3', 'v2'))).toBeNull();
  });

  it('overlapping matches never repeat text', () => {
    const d = html('github', 'git github');
    expect(d.textContent).toBe('github');
    expect(tids('search-highlight', d).map((m) => m.textContent).join('')).toBe('github');
  });

  it('page text is never HTML', () => {
    const d = html('<script>alert(1)</script><img src=x onerror=alert(1)> news', 'news');
    expect([...d.children].map((n) => n.dataset.testid)).toEqual(['search-highlight']); // the only element: our mark
    expect(d.textContent).toBe('<script>alert(1)</script><img src=x onerror=alert(1)> news');
    expect(tid('search-highlight', d).textContent).toBe('news');
  });

  it('empty text gives an empty fragment; hlSpan wraps it in a span', () => {
    expect(sw.highlight('', 'x').childNodes.length).toBe(0);
    const s = sw.hlSpan('ddtitle', '<b>Bold</b>', 'bold');
    expect(s.dataset.testid).toBe('dd-title');
    expect([...s.children].map((n) => [n.dataset.testid, n.textContent])).toEqual([['search-highlight', 'Bold']]);
    expect(s.textContent).toBe('<b>Bold</b>');
  });
});

describe('deriveSearch', () => {
  it('lists matching open tabs: tier, then score, then recent use', async () => {
    sw = await bootSwitcher({
      tabs: [
        tab('Start', 'https://start.com/'),
        tab('Docs', 'https://alpha.com/'),        // address only: tier 1
        tab('My alpha page', 'https://a.com/'),   // title: tier 2
        tab('Alpha home', 'https://b.com/'),      // title starts: tier 3
        tab('Xalpha', 'https://c.com/'),          // title, anywhere (3): tier 2, lower score
      ],
    });
    sw.state.query = '  Alpha ';
    sw.deriveSearch();
    expect(sw.state.found.map((e) => e.tab.title)).toEqual(['Alpha home', 'My alpha page', 'Xalpha', 'Docs']);
    expect(sw.state.found[0]).toMatchObject({ kind: 'tab', key: 't' + sw.state.found[0].tab.id });
  });

  it('nothing typed, nothing found', async () => {
    sw = await bootSwitcher();
    sw.state.query = '   ';
    sw.deriveSearch();
    expect(sw.state.found).toEqual([]);
    expect(sw.state.foundClosed).toEqual([]);
  });

  it('finds recently closed pages too', async () => {
    sw = await bootSwitcher();
    sw.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://zeta.com/', title: 'Zeta', ts: Date.now() - 864e5, count: 1, fields: [['Zeta', 'https://zeta.com/']] }];
    sw.state.query = 'zet';
    sw.deriveSearch();
    expect(sw.state.foundClosed.map((c) => c.id)).toEqual(['l1']); // a day old: older than the 4 h shown without a search
  });
});

describe('the dropdown rows', () => {
  const rows = () => sw.ddRows().filter((r) => r.kind);
  const go = (q) => { sw.state.query = q; sw.deriveSearch(); return rows(); };
  const closedItem = (id, title, url) => ({ id, kind: 'tab', url, title, ts: Date.now(), count: 1, fields: [[title, url]] });

  beforeEach(async () => {
    sw = await bootSwitcher({ tabs: [tab('Start', 'https://start.com/'), tab('Alpha tab', 'https://t.com/')] });
    sw.state.marks = [];
    sw.state.history = [];
  });

  it('ties go open tab, recently closed, archived, bookmark, history', () => {
    sw.state.history = [visit('Alpha visit', 'https://v.com/')];
    sw.state.marks = [{ title: 'Alpha mark', url: 'https://m.com/', path: '' }];
    sw.state.archived = [{ id: '9', title: 'Alpha archived', url: 'https://ar.com/', t: 1 }];
    sw.state.closed = [closedItem('l1', 'Alpha closed', 'https://cl.com/')];
    expect(go('alpha').map((r) => r.kind)).toEqual(['tab', 'closed', 'archived', 'mark', 'visit']);
  });

  it('a better match comes first, whatever its source', () => {
    sw.state.history = [visit('Beta', 'https://v.com/')];
    sw.state.marks = [{ title: 'Xbeta', url: 'https://m.com/', path: '' }];
    const r = go('beta');
    expect(r.map((x) => [x.kind, x.s])).toEqual([['visit', 5], ['mark', 3]]);
  });

  it('within a source, ties keep that source’s order', () => {
    sw.state.history = [visit('Gamma one', 'https://1.com/', 3), visit('Gamma two', 'https://2.com/', 2), visit('Gamma three', 'https://3.com/', 1)];
    expect(go('gamma').map((r) => r.x.title)).toEqual(['Gamma one', 'Gamma two', 'Gamma three']);
  });

  it('a page found in several places is one row, as the most useful source with the best score', () => {
    sw.state.marks = [{ title: 'Lphabet', url: 'https://t.com/#top', path: '' }];
    sw.state.history = [visit('Alpha', 'https://t.com/')];
    expect(go('alpha').map((x) => [x.kind, x.s])).toEqual([['tab', 5]]);
    // "lpha" is only inside the tab's title (3) but starts the bookmark's (5): the tab row gets the 5.
    expect(go('lpha').map((x) => [x.kind, x.s])).toEqual([['tab', 5]]);
  });

  it('a closed window is its own row, even when one of its pages is open', () => {
    sw.state.closed = [{ id: 'w1', kind: 'window', url: 'https://t.com/', title: 'Window', ts: Date.now(), count: 2, fields: [['Alpha tab', 'https://t.com/'], ['Other', 'https://o.com/']] }];
    expect(go('alpha').map((r) => r.kind)).toEqual(['tab', 'closed']);
  });

  it('shows at most DD_MAX rows', () => {
    sw.state.history = Array.from({ length: 30 }, (_, i) => visit('Delta ' + i, `https://d${i}.com/`, 100 - i));
    expect(go('delta')).toHaveLength(sw.DD_MAX);
  });

  it('nothing found: open the address (when it is one), and a Google search', () => {
    expect(go('example.org')).toEqual([{ kind: 'url', url: 'https://example.org' }, { kind: 'google' }]);
    expect(go('qqq zzz')).toEqual([{ kind: 'google' }]);
    expect(go('')).toEqual([]);
  });

  it('says so when bookmarks or history can’t be read', () => {
    const { bookmarks, history } = chrome;
    delete chrome.bookmarks; delete chrome.history;
    try {
      sw.state.query = 'alpha';
      sw.deriveSearch();
      const notes = sw.ddRows().filter((r) => r.note).map((r) => r.note);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatch(/Bookmarks/);
      expect(notes[1]).toMatch(/History/);
    } finally { Object.assign(chrome, { bookmarks, history }); }
  });
});

describe('history and bookmarks', () => {
  beforeEach(async () => { sw = await bootSwitcher(); });

  it('hist maps a history item with defaults', () => {
    expect(sw.hist({ url: 'https://a.com/' })).toEqual({ url: 'https://a.com/', title: '', t: 0, n: 0 });
    expect(sw.hist({ url: 'u', title: 'T', lastVisitTime: 5, visitCount: 2 })).toEqual({ url: 'u', title: 'T', t: 5, n: 2 });
  });

  it('urlKey normalizes and remembers; unusable addresses stay as they are', () => {
    expect(sw.urlKey('https://a.com/x/#h')).toBe('https://a.com/x');
    expect(sw.urlKeys.get('https://a.com/x/#h')).toBe('https://a.com/x');
    expect(sw.urlKey('not a url')).toBe('not a url');
  });

  it('historyItems merges both lists once per page, newest first, and is memoized', () => {
    sw.state.query = 'a';
    sw.state.history = [visit('Old', 'https://a.com/', 1), visit('New', 'https://b.com/', 9)];
    sw.state.histQ = { q: 'a', items: [visit('Again', 'https://a.com/#x', 5), visit('Far', 'https://c.com/', 3)] };
    const items = sw.historyItems();
    expect(items.map((x) => x.title)).toEqual(['New', 'Far', 'Old']);
    expect(sw.historyItems()).toBe(items);
    sw.state.query = 'ab'; // Chrome's search was for other text: left out
    expect(sw.historyItems().map((x) => x.title)).toEqual(['New', 'Old']);
  });

  it('loadMarks reads web bookmarks with their folder path, leaving out the Tabs Archive', async () => {
    const dev = chrome._addBookmark({ parentId: '1', title: 'Dev' });
    const repo = chrome._addBookmark({ parentId: dev.id, title: 'Repo', url: 'https://repo.com/' });
    const plain = chrome._addBookmark({ parentId: '2', title: 'Plain', url: 'file:///c/x.txt' });
    chrome._addBookmark({ parentId: '2', title: 'Script', url: 'javascript:alert(1)' });
    const arch = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: arch.id, title: 'Archived', url: 'https://arch.com/' });
    await sw.loadMarks();
    expect(sw.state.marks).toEqual([
      { id: repo.id, title: 'Repo', url: 'https://repo.com/', path: 'Bookmarks bar › Dev' },
      { id: plain.id, title: 'Plain', url: 'file:///c/x.txt', path: 'Other bookmarks' },
    ]);
  });

  it('a bookmark is found by its own note (the bookmark’s, not the page’s), which shows in its result', async () => {
    const b = chrome._addBookmark({ parentId: '1', title: 'Roadmap', url: 'https://road.example/' });
    await chrome.storage.local.set({ bmNotes: { [b.id]: { u: 'https://road.example/', n: 'quarterly planning doc', t: Date.now() } } });
    await sw.loadMarks();
    sw.state.query = 'quarterly';
    sw.deriveSearch();
    const rows = sw.ddRows();
    const r = rows.find((x) => x.kind === 'mark');
    expect(r && r.b.url).toBe('https://road.example/');
    const node = sw.ddRowEl(r, 'quarterly', false, 'dd-0');
    expect(tid('dd-note', node).textContent).toBe('quarterly planning doc');
  });

  it('loadMarks: no bookmarks access or a failing read gives an empty list', async () => {
    chrome.bookmarks.getTree.mockRejectedValue(new Error('nope'));
    await sw.loadMarks();
    expect(sw.state.marks).toEqual([]);
    const { bookmarks } = chrome;
    delete chrome.bookmarks;
    try { await sw.loadMarks(); expect(sw.state.marks).toEqual([]); } finally { chrome.bookmarks = bookmarks; }
  });

  it('loadHistory reads 90 days of web pages', async () => {
    chrome._data.history = [
      { url: 'https://a.com/', title: 'A', lastVisitTime: Date.now() - 864e5, visitCount: 3 },
      { url: 'chrome://settings/', title: 'Settings', lastVisitTime: Date.now() },
      { url: 'https://old.com/', title: 'Old', lastVisitTime: Date.now() - 100 * 864e5 },
    ];
    await sw.loadHistory();
    expect(sw.state.history).toEqual([{ url: 'https://a.com/', title: 'A', t: chrome._data.history[0].lastVisitTime, n: 3 }]);
    const q = chrome.history.search.mock.calls.at(-1)[0];
    expect(q).toMatchObject({ text: '', maxResults: 5000 });
    expect(Date.now() - q.startTime).toBeGreaterThanOrEqual(90 * 864e5);
  });

  it('searchHistory asks Chrome after a pause, and keeps the answer only for the current text', async () => {
    chrome._data.history = [{ url: 'https://far.com/', title: 'Far back', lastVisitTime: 1 }, { url: 'about:blank', title: 'far' }];
    sw.state.query = 'far';
    sw.searchHistory('far');
    expect(chrome.history.search).not.toHaveBeenCalled();
    await tick(150);
    expect(chrome.history.search).toHaveBeenLastCalledWith({ text: 'far', startTime: 0, maxResults: 60 });
    expect(sw.state.histQ).toEqual({ q: 'far', items: [{ url: 'https://far.com/', title: 'Far back', t: 1, n: 0 }] });

    sw.searchHistory('fa'); // typed on meanwhile: the answer is dropped
    sw.state.query = 'f';
    await tick(150);
    expect(sw.state.histQ.q).toBe('far');

    sw.searchHistory('');
    expect(sw.state.histQ).toEqual({ q: '', items: [] });
  });

  it('scoreBig narrows to earlier hits while the text grows, then rescores everything after a pause', async () => {
    const items = [{ t: 'abcd' }, { t: 'xbcd' }, { t: 'zzzz' }];
    const run = (q) => { const spy = vi.fn((it) => sw.searchScore(q, it.t)); return { hits: sw.scoreBig('t', items, q, spy).map((x) => x.it.t), calls: spy.mock.calls.length }; };
    expect(run('abc')).toEqual({ hits: ['abcd'], calls: 3 });
    expect(run('abc')).toEqual({ hits: ['abcd'], calls: 0 }); // same text: remembered
    expect(run('abcd')).toEqual({ hits: ['abcd'], calls: 1 }); // only the earlier hit is scored
    await tick(200);
    expect(sw.bigHits.t.q).toBe('');
    expect(run('abcd')).toEqual({ hits: ['abcd', 'xbcd'], calls: 3 }); // the typo match shows up now
    expect(run('ab')).toMatchObject({ calls: 3 }); // text got shorter: everything again
  });

  it('scoreBig starts over for a new list', () => {
    const a = [{ t: 'abcd' }];
    sw.scoreBig('n', a, 'ab', (it) => sw.searchScore('ab', it.t));
    const b = [{ t: 'abcd' }, { t: 'abce' }];
    expect(sw.scoreBig('n', b, 'abc', (it) => sw.searchScore('abc', it.t)).map((x) => x.s)).toEqual([5, 5]);
  });
});

describe('opening from the box', () => {
  beforeEach(async () => { sw = await bootSwitcher(); });

  it('asUrl recognises addresses', () => {
    expect(sw.asUrl('https://x.com/a b')).toBeNull();
    expect(sw.asUrl('https://x.com/a')).toBe('https://x.com/a');
    expect(sw.asUrl('chrome-extension://abc/page.html')).toBe('chrome-extension://abc/page.html');
    expect(sw.asUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(sw.asUrl('192.168.0.1')).toBe('http://192.168.0.1');
    expect(sw.asUrl('docs.example.co.uk/path?q=1')).toBe('https://docs.example.co.uk/path?q=1');
    expect(sw.asUrl('example.com:8080')).toBe('https://example.com:8080');
    expect(sw.asUrl('hello')).toBeNull();
    expect(sw.asUrl('file.x')).toBeNull(); // one-letter "TLD"
    expect(sw.asUrl('')).toBeNull();
  });

  it('googleUrl encodes the text', () => {
    expect(sw.googleUrl('a&b c/?')).toBe('https://www.google.com/search?q=a%26b%20c%2F%3F');
  });
});
