// scripts/firefox.js: the Firefox copy's manifest (`npm run firefox`): the background as a script, Firefox's own
// settings, nothing only Chrome knows; and what goes into the copy is what Chrome loads.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { firefoxManifest, PARTS, ROOT, GECKO_ID, FIREFOX_MIN } from '../../scripts/firefox.js';

const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

describe('the Firefox manifest', () => {
  const firefox = firefoxManifest(MANIFEST);

  it('runs the background as a module script (Firefox has no extension service workers)', () => {
    expect(firefox.background).toEqual({ scripts: ['background.js'], type: 'module' });
  });

  it('has Firefox’s own settings: the add-on’s id, the oldest Firefox, that it collects nothing', () => {
    expect(firefox.browser_specific_settings).toEqual({ gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN, data_collection_permissions: { required: ['none'] } } });
  });

  it('leaves out what only Chrome knows', () => {
    expect(firefox.minimum_chrome_version).toBe(undefined);
    expect(firefox.permissions).not.toContain('favicon');
    expect(firefox.content_scripts.every((script) => !('match_origin_as_fallback' in script))).toBe(true);
    expect(firefox.web_accessible_resources.every((resource) => !('use_dynamic_url' in resource))).toBe(true);
  });

  it('keeps the rest as Chrome has it: version, shortcuts, permissions, pages, policy', () => {
    for (const key of ['version', 'name', 'commands', 'host_permissions', 'content_security_policy', 'action', 'icons', 'default_locale', 'incognito']) expect(firefox[key], key).toEqual(MANIFEST[key]);
    expect(firefox.permissions).toEqual(MANIFEST.permissions.filter((permission) => permission !== 'favicon'));
    expect(MANIFEST.background).toEqual({ service_worker: 'background.js', type: 'module' }); // (Chrome's is left as it was)
  });
});

describe('the Firefox copy', () => {
  it('holds what Chrome loads: every page script, content script, page and folder the manifest names', () => {
    for (const part of PARTS) expect(existsSync(join(ROOT, part)), part).toBe(true);
    const named = [MANIFEST.background.service_worker, ...MANIFEST.content_scripts.flatMap((script) => script.js), ...MANIFEST.web_accessible_resources.flatMap((resource) => resource.resources)];
    for (const file of named) expect(PARTS.some((part) => file === part || file.startsWith(part + '/')), file).toBe(true);
  });
});
