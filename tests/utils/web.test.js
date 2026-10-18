import { describe, it, expect } from 'vitest';
import { asUrl, googleUrl } from '../../utils/web.js';

describe('asUrl', () => {
  it('keeps text that already has a scheme', () => {
    expect(asUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(asUrl('chrome://settings')).toBe('chrome://settings');
    expect(asUrl('file:///C:/x.txt')).toBe('file:///C:/x.txt');
  });
  it('localhost and IP addresses open over http', () => {
    expect(asUrl('localhost')).toBe('http://localhost');
    expect(asUrl('localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(asUrl('192.168.0.1')).toBe('http://192.168.0.1');
    expect(asUrl('10.0.0.2:8080/x')).toBe('http://10.0.0.2:8080/x');
  });
  it('a domain name opens over https, with its port, path, query or fragment', () => {
    expect(asUrl('example.com')).toBe('https://example.com');
    expect(asUrl('sub.example.co.uk/path')).toBe('https://sub.example.co.uk/path');
    expect(asUrl('example.com:8443?q=1')).toBe('https://example.com:8443?q=1');
    expect(asUrl('my-site.dev#top')).toBe('https://my-site.dev#top');
  });
  it('anything else is not an address', () => {
    for (const s of ['', null, undefined, 'hello', 'how to cook rice', 'example .com', 'node.js tutorial', 'v1.2', 'a.b1']) {
      expect(asUrl(s), String(s)).toBeNull();
    }
  });
});

describe('googleUrl', () => {
  it('searches Google for the text, encoded', () => {
    expect(googleUrl('cats & dogs')).toBe('https://www.google.com/search?q=cats%20%26%20dogs');
    expect(googleUrl('пример')).toBe('https://www.google.com/search?q=%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80');
  });
});
