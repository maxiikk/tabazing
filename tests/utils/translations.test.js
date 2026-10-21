// utils/translations.js: the ICU MessageFormat subset (formatMessage) and t over the dictionaries.
import { describe, it, expect, afterEach } from 'vitest';
import { formatMessage, t, setLocale, getLocale, LANGUAGES } from '../../utils/translations.js';

afterEach(() => setLocale('en'));
const f = (pattern, data, lang = 'en') => formatMessage(pattern, data, lang);

describe('formatMessage: placeholders', () => {
  it('fills named placeholders, any number of times', () => {
    expect(f('{amount} items', { amount: 2 })).toBe('2 items');
    expect(f('{a} and {b}, then {a}', { a: 'x', b: 'y' })).toBe('x and y, then x');
    expect(f('  { spaced }  ', { spaced: 1 })).toBe('  1  ');
  });
  it('leaves a placeholder with no value as it is', () => {
    expect(f('Hello {name}', {})).toBe('Hello {name}');
    expect(f('Hello {name}')).toBe('Hello {name}');
  });
  it('turns values into text (0, false and empty strings too)', () => {
    expect(f('{n}|{b}|{s}|{x}', { n: 0, b: false, s: '', x: null })).toBe('0|false||null');
  });
  it('formats {n, number} for the language', () => {
    expect(f('{n, number}', { n: 1234.5 })).toBe('1,234.5');
    expect(f('{n, number}', { n: 1234.5 }, 'es')).toBe(new Intl.NumberFormat('es').format(1234.5));
  });
  it('a plain text message comes back unchanged, apostrophes and # included', () => {
    expect(f("Don't group this window's tabs (ignoring the #part)")).toBe("Don't group this window's tabs (ignoring the #part)");
  });
});

describe('formatMessage: plural', () => {
  const tabs = '{count, plural, one {# tab} other {# tabs}}';
  it('picks the form for the count, # is the count', () => {
    expect(f(tabs, { count: 1 })).toBe('1 tab');
    expect(f(tabs, { count: 0 })).toBe('0 tabs');
    expect(f(tabs, { count: 2 })).toBe('2 tabs');
    expect(f(tabs, { count: 1500 })).toBe('1,500 tabs'); // # is formatted like a number
  });
  it('=N options win over categories', () => {
    const m = '{count, plural, =0 {no tabs} =1 {one tab} other {# tabs}}';
    expect(f(m, { count: 0 })).toBe('no tabs');
    expect(f(m, { count: 1 })).toBe('one tab');
    expect(f(m, { count: 7 })).toBe('7 tabs');
  });
  it('uses the language’s own categories: Russian one / few / many', () => {
    const m = '{count, plural, one {# вкладка} few {# вкладки} many {# вкладок} other {# вкладки}}';
    expect([1, 2, 5, 11, 21, 22, 25, 1.5].map((count) => f(m, { count }, 'ru'))).toEqual([
      '1 вкладка', '2 вкладки', '5 вкладок', '11 вкладок', '21 вкладка', '22 вкладки', '25 вкладок', '1,5 вкладки',
    ]);
  });
  it('falls back to other when the category has no option', () => {
    expect(f('{n, plural, other {# things}}', { n: 1 })).toBe('1 things');
  });
  it('mixes other placeholders into the forms', () => {
    const m = '{count, plural, one {Snoozed # tab until {time}} other {Snoozed # tabs until {time}}}';
    expect(f(m, { count: 3, time: '18:00' })).toBe('Snoozed 3 tabs until 18:00');
  });
  it('offset: counts from that much less', () => {
    const m = '{n, plural, offset:1 =0 {nobody} =1 {you} one {you and # other} other {you and # others}}';
    expect([0, 1, 2, 5].map((n) => f(m, { n }))).toEqual(['nobody', 'you', 'you and 1 other', 'you and 4 others']);
  });
  it('nests: a plural inside a select', () => {
    const m = '{who, select, me {{n, plural, one {I have # tab} other {I have # tabs}}} other {{who} has {n, plural, one {# tab} other {# tabs}}}}';
    expect(f(m, { who: 'me', n: 1 })).toBe('I have 1 tab');
    expect(f(m, { who: 'Ana', n: 3 })).toBe('Ana has 3 tabs');
  });
  it('a missing count leaves the placeholder', () => {
    expect(f(tabs, {})).toBe('{count}');
  });
});

describe('formatMessage: selectordinal and select', () => {
  it('selectordinal picks the ordinal form', () => {
    const m = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect([1, 2, 3, 4, 11, 21, 22].map((n) => f(m, { n }))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '21st', '22nd']);
  });
  it('select picks by value, else other', () => {
    const m = '{kind, select, tab {an open tab} mark {a bookmark} other {something}}';
    expect(f(m, { kind: 'mark' })).toBe('a bookmark');
    expect(f(m, { kind: 'x' })).toBe('something');
  });
});

describe('formatMessage: quoting and errors', () => {
  it("'' is one apostrophe; '{…}' and '#' (in a plural) are literal", () => {
    expect(f("it''s {x}", { x: 1 })).toBe("it's 1");
    expect(f("'{x}' is {x}", { x: 1 })).toBe('{x} is 1');
    expect(f("{n, plural, other {'#' # items}}", { n: 2 })).toBe('# 2 items');
  });
  it('rejects broken messages with a clear error', () => {
    expect(() => f('{x')).toThrow(SyntaxError);
    expect(() => f('a } b')).toThrow(SyntaxError);
    expect(() => f('{n, plural, one {x}}', { n: 1 })).toThrow(/other/);
    expect(() => f('{n, plural, one x}')).toThrow(SyntaxError);
  });
});

describe('t', () => {
  it('knows its languages and switches between them', () => {
    expect([...LANGUAGES].sort()).toEqual(['ar', 'de', 'el', 'en', 'es', 'fr', 'he', 'it', 'ro', 'ru']);
    expect(setLocale('ru')).toBe('ru');
    expect(getLocale()).toBe('ru');
    expect(setLocale('xx')).toBe('en');
  });
  it('a key no dictionary has comes back as the key', () => {
    expect(t('noSuchKey_abc')).toBe('noSuchKey_abc');
  });
  it('reads the current language', () => {
    setLocale('es');
    expect(t('newTab')).toBe('Nueva pestaña');
    setLocale('en');
    expect(t('newTab')).toBe('New tab');
  });
});
