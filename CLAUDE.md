# Tabazing

Chrome extension (Manifest V3) tab switcher. The canonical version lives in `manifest.json` (`"version"`).

## Layout

Keep the root tidy: HTML goes in `markup/`, CSS in `styles/`, shared modules in `utils/` (tests for them in `tests/utils/`). Only `manifest.json`, the service worker, the content scripts and the page scripts stay in the root. Pages in `markup/` reference their files with `../` (`../styles/x.css`, `../x.js`); code that names a page uses `SWITCHER_PAGE` / `SWEEP_PAGE` from `utils/constants.js`.

## Release workflow

After every requested feature or change is complete, commit and push it. Do not leave finished work uncommitted.

Each commit bumps the extension version in `manifest.json` according to the severity of the change:

- **Major** (`X.0.0`) — breaking changes: removed or renamed commands/hotkeys, changed storage schema without migration, dropped permissions, or any change that forces users to reconfigure.
- **Minor** (`x.Y.0`) — new features: a new command, setting, UI surface, or capability. Backwards compatible.
- **Patch** (`x.y.Z`) — bug fixes, performance work, styling tweaks, copy/translation updates, refactors with no user-visible behavior change.

When a change set spans several levels, use the highest one that applies.

### Steps

1. Make the change.
2. Add or update unit tests for it in `tests/` (see Tests below), then run the tests of the affected functionality, e.g. `npx vitest run tests/switcher/archive`. Fix failures before going on; never commit with failing tests.
3. Edit `"version"` in `manifest.json` to the new number.
4. Record the changes in `CHANGELOG.md` before committing — every version gets an entry (see Changelog below).
5. `git add` the changed files, commit, and `git push` to `origin master`.

### Changelog

`CHANGELOG.md` follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/):

- Newest version first. Work not yet released collects under `## [Unreleased]`; on a version bump, rename that heading to `## [x.y.z] - YYYY-MM-DD` (ISO date) and start a new empty `## [Unreleased]` above it.
- Group entries under these headings, in this order, leaving out empty ones: `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`.
- Write for people using the extension: what changed for them, one line each, not the commit log.
- Keep the link references at the bottom up to date: `[x.y.z]` compares the previous release's commit with this one's. A release can't name its own commit, so its link compares with `HEAD` until the next release replaces `HEAD` with that commit's short hash.

## Translations

- Every user-visible string lives in `dictionaries/<lang>.json` (`en`, `el`, `de`, `it`, `fr`, `es`, `ru`, `ar`, `he`, `ro`), a flat `{ "key": "message" }` object — the one place translations are kept. Add or change a string in every dictionary at once.
- Messages are ICU MessageFormat, read with `t(key, params)` from `utils/translations.js` (never build text by concatenating strings): named placeholders `"Active tab: {title}"` → `t('activeTab', { title })`; counts as one plural message, not one key per form: `"{count, plural, one {# tab} other {# tabs}}"` → `t('tabs', { count: 5 })`. Each language uses its own plural categories: Russian `one` / `few` / `many` / `other`, Romanian `one` / `few` / `other`, Hebrew `one` / `two` / `other`, Arabic `zero` / `one` / `two` / `few` / `many` / `other` (leave out a form that would say the same as `other`). Never an ASCII `'` in a message (ICU reads it as a quote before `{`): use `’`. Also `{n, number}`, `{x, select, a {…} other {…}}`, `=0 {…}` exact matches; `'{'` for a literal brace. Every language must use the same placeholder names; the tests check that, that each call passes exactly the values its message uses, and that every key is used somewhere: when a feature or a string goes, delete its key from every dictionary. A key used only through a variable must appear as a literal in the code (as in the `label: 'fAudio'` tables).
- `utils/i18n.js` only chooses the language (`loadLang`, `setLang`, `uiLang`) and fills static pages (`localizePage`, from `data-i18n*` attributes).
- `_locales/` is generated, never edited by hand: Chrome reads it only for what `manifest.json` names with `__MSG_key__`. After changing one of those keys, run `npm run i18n` (`scripts/i18n.js`). `tests/utils/dictionaries.test.js` fails while they disagree, or while a key the code uses is missing.
- A new language: add `dictionaries/<lang>.json` with every key, add the language to `LANGS` in `utils/i18n.js` and to the Settings list in `switcher.js`, then run `npm run i18n`. A right-to-left one also goes in `RTL` in `utils/i18n.js`; styles use start / end (`margin-inline-start`, `inset-inline-end`), never left / right, except for what is placed on screen by coordinates.

## Tests

Vitest + jsdom (`npm install` once, then `npm test` for everything, `npx vitest run <path>` for part of it).

Real-browser tests: `npm run test:e2e` (Puppeteer + Chrome for Testing, `tests/e2e/*.e2e.js`, ~1 min; `npx puppeteer browsers install chrome` once on a new machine). Run them after changing the media detection (media-hook.js, media-relay.js, utils/media.js), how pages host the switcher, or layout that jsdom can't check (it applies no CSS): `tests/e2e/palette.e2e.js` checks the switcher's layout in real Chrome. Never give `<html>` a class that elements also use (tests/switcher/html-classes.test.js).

- `tests/` mirrors the source: `tests/utils/<module>.test.js`, `tests/background*.test.js`, `tests/switcher/<area>.test.js`, `tests/hotkey.test.js`, `tests/sweep-page.test.js`.
- `tests/setup/chrome.js` is an in-memory fake of the `chrome.*` APIs (reset before every test); `tests/setup/dom.js` adds what jsdom lacks; `tests/helpers/switcher.js` (`bootSwitcher`) boots the real switcher page through its launch token.
- `switcher.js` and `background.js` end with an `export { … }` list so tests can reach their functions; add new top-level functions to it.
- **Selectors: tests find elements only by `data-testid`** (`[data-testid="card-tab"]`), never by role, CSS id, class or tag. Every element the extension creates carries one: in HTML as an attribute, in `switcher.js` through `h(tag, cls, text, testid)` (and `button(testid, label, cls, fn)` in dialogs), elsewhere via `el.dataset.testid`. Give every new element a test id; repeated elements share one per kind (`card-tab`, `card-closed`, `dd-row-mark`).
- The folder is `tests/`, not `__tests__`: Chrome refuses to load an unpacked extension with a root entry starting with `_` (other than `_locales`).

### Commit message format

```
<type>: <summary>

v<new version> (<major|minor|patch>)
```

Where `<type>` is one of `feat`, `fix`, `perf`, `style`, `refactor`, `chore`, `i18n`.

Example:

```
feat: add fuzzy search to the switcher

v1.13.0 (minor)
```
