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
2. Edit `"version"` in `manifest.json` to the new number.
3. `git add` the changed files, commit, and `git push` to `origin master`.

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
