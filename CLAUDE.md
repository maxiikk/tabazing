# Tabazing

Chrome extension (Manifest V3) tab switcher. The canonical version lives in `manifest.json` (`"version"`).

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

## Tests

Vitest + jsdom (`npm install` once, then `npm test` for everything, `npx vitest run <path>` for part of it).

- `tests/` mirrors the source: `tests/lib/<module>.test.js`, `tests/background*.test.js`, `tests/switcher/<area>.test.js`, `tests/hotkey.test.js`, `tests/sweep-page.test.js`.
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
