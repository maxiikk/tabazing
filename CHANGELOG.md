# Changelog

All notable changes to Tabazing are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.1] - 2026-10-18

### Fixed

- The media player listed tabs whose video or audio had never played. It now follows Chrome's own media controls exactly: media shows up only once it has played with sound (never muted autoplay, videos without sound or sounds under 5 seconds), stays while paused, muted or finished, and leaves when it is taken off the page, the page loads something else, its source is reset, or it has been paused for an hour.

## [3.1.0] - 2026-10-18

### Added

- A media player in the header, beside the search box: the preview and title of what a tab is playing, with Previous, Play / Pause and Next. Its ⌄ button lists everything playable in all your tabs, each with its own buttons and Go to tab.
- Previous and Next work on sites that offer them to the browser (YouTube, Spotify, SoundCloud and others); play / pause works on any page with audio or video. Tabs already open when Tabazing is installed or updated get the player right away.

## [3.0.3] - 2026-10-17

### Removed

- For developers: 122 strings nothing used any more (for a tab-groups panel, bookmark editing, Help / Pro links, old tour steps and the old dropdown sections) are gone from every dictionary, and a test now fails if a string goes unused. Nothing changes for people using the extension.

## [3.0.2] - 2026-10-17

### Changed

- For developers: the translation function is `t(key, params)` (it was `getTranslation`); a test makes sure no local variable named `t` hides it where it is called. Nothing changes for people using the extension.

## [3.0.1] - 2026-10-17

### Changed

- Translations use ICU MessageFormat: named placeholders (`{title}`) and one plural message per counted phrase, which picks the right form from the count with each language's own plural rules, instead of a separate string per form. Counts in messages are written the way your language writes numbers (1,500 in English, 1 500 in Russian).

## [3.0.0] - 2026-10-17

### Changed

- The switcher opens faster: before its first draw it reads only the previews of the first cards on screen (the rest follow at once), and its settings once instead of three times.
- Faster while open: ticking, starring, muting or putting a tab to sleep redraws only that card, a preview saved meanwhile updates only its card, moving the selection touches only two cards, resizing redraws once per frame, icons are parsed once, screenshots aren't decoded again on every redraw, and web addresses are parsed once.
- All translations live in one place, `dictionaries/<lang>.json` (English, Spanish, Russian). The text Chrome itself shows (the extension's name, description and shortcut names) is generated from them into `_locales/` with `npm run i18n`.

### Removed

- Support for Chrome 116–122: Tabazing now needs Chrome 123 or later (it loads its dictionaries as JSON modules).

## [2.0.0] - 2026-10-17

### Added

- Shift+F10 (or the Menu key) opens a menu of every action for the selected card: select, star, copy link, capture, reload, duplicate, sleep, mute, pin, snooze, archive, note, close. Every button on a card is now reachable from the keyboard.
- A visible focus ring on every control; controls that only show on hover (tick box, star, ×, window merge) also show when they get the keyboard focus.
- In the archive, Ctrl+Z (⌘Z) undoes removing a tab, like the Undo button.
- README with a guide to every feature.
- Unit tests for every module (Vitest + jsdom) in `tests/`, with an in-memory fake of the `chrome.*` APIs; run them with `npm test`. Every element carries a `data-testid`, which the tests select elements by.

### Changed

- Tab and Shift+Tab move the keyboard focus through Tabazing's buttons and fields, like on any page. They step through the cards only while Alt is still held after Alt+Q / Alt+W (like Alt+Tab).
- While the search box has the focus, number keys type into it, so a tab whose title starts with a number can be searched for. Jump to a numbered card with Alt+1–9 (⌥1–9 on a Mac).
- Enter and Space on a focused button press that button instead of opening the selected tab.
- Settings, dialogs, the archive and the big preview keep the keyboard focus inside them while open, and give it back to what opened them when they close.
- Screen readers: the search box announces the selected card and search result, ticked tabs are announced as checked, each card says its site, buttons on cards no longer break the list, toasts and alerts are announced reliably, and the switcher is named in your language.
- The faintest text is brighter, so it keeps at least 4.5:1 contrast in both themes and over any page; dimmed cards dim only their picture, not their text.
- Small buttons (tick box, small quick buttons, the speaker, window merge) take clicks across at least 24×24 px.
- With "reduce motion" turned on in the system, nothing in the switcher animates.
- The note tooltip stays while the pointer is on it, and Esc hides it.
- The "use Alt+Q" note and the first-run card on web pages are dialogs that Esc closes, and they no longer disappear while the pointer or the keyboard focus is on them; their × is easier to hit.
- The "Capture all previews" progress bar is named for screen readers.
- Faster: each screenshot is decoded once instead of twice, saving a preview reads the open tabs and the bookmarks once instead of twice, closing many tabs writes the closed-tab log once, "Capture all previews" reads one index instead of every preview, and Alt+Q prepares the switcher while it takes the current tab's screenshot.

### Removed

- Tab / Shift+Tab no longer step through the cards unless Alt is held (use the arrow keys).
- Plain 1–9 no longer switch tabs while the search box has the focus (use Alt+1–9).

### Fixed

- A snoozed tab also appeared under "Recently closed".
- The tick box's tooltip said Ctrl+click selects a card; Ctrl+click shows the big preview.
- One malformed stored value stopped Tabazing from remembering pages Chrome refuses to screenshot for the rest of the browser session.

## [1.15.2] - 2026-10-17

### Fixed

- Alt+E opened the switcher on the previously used tab instead of the current one.

## [1.15.1] - 2026-10-17

### Changed

- Search results that match equally well are ordered by status: open tabs, then recently closed, archived, bookmarks, history.

### Fixed

- Typing in the search box lagged with a large history (up to ~300 ms per keystroke): scores are now remembered and the work is done once per frame.

## [1.15.0] - 2026-10-17

### Changed

- The search dropdown shows one list ranked by how well each result matches, instead of separate sections; an icon at the end of each title row says where the result comes from.

## [1.14.4] - 2026-10-17

### Fixed

- The cards flickered as the switcher opened.

## [1.14.3] - 2026-10-17

### Changed

- The selected card lifts and glows in the accent colour instead of the outline ring; the other cards step back.

## [1.14.2] - 2026-10-17

### Fixed

- Clicking a dropdown's button while it was open closed it and opened it again at once.

## [1.14.1] - 2026-10-17

### Changed

- The archive overlay is opaque black (white in the light theme).

## [1.14.0] - 2026-10-17

### Added

- An × on each archived tab removes it from the archive without opening it (also Del), with Undo.

## [1.13.0] - 2026-10-17

### Added

- Archive: a button on every tab card moves the tab into a "Tabs Archive" bookmarks folder in "Other bookmarks".
- An Archive button in the header opens an overlay with every archived tab and its preview; clicking one opens it again and takes it out of the archive.
- Archived tabs show up in the search dropdown.

## [1.12.1] - 2026-10-17

- First version in this repository.

[3.1.1]: https://github.com/maxiikk/tabazing/compare/b6177be...HEAD
[3.1.0]: https://github.com/maxiikk/tabazing/compare/9e19aa0...b6177be
[3.0.3]: https://github.com/maxiikk/tabazing/compare/868f87a...9e19aa0
[3.0.2]: https://github.com/maxiikk/tabazing/compare/6d950ea...868f87a
[3.0.1]: https://github.com/maxiikk/tabazing/compare/ef9a3f9...6d950ea
[3.0.0]: https://github.com/maxiikk/tabazing/compare/84ab029...ef9a3f9
[2.0.0]: https://github.com/maxiikk/tabazing/compare/5516898...84ab029
[1.15.2]: https://github.com/maxiikk/tabazing/compare/590bb83...5516898
[1.15.1]: https://github.com/maxiikk/tabazing/compare/f68d9b4...590bb83
[1.15.0]: https://github.com/maxiikk/tabazing/compare/4459890...f68d9b4
[1.14.4]: https://github.com/maxiikk/tabazing/compare/818eeb5...4459890
[1.14.3]: https://github.com/maxiikk/tabazing/compare/80b79c6...818eeb5
[1.14.2]: https://github.com/maxiikk/tabazing/compare/8396d86...80b79c6
[1.14.1]: https://github.com/maxiikk/tabazing/compare/e1690b3...8396d86
[1.14.0]: https://github.com/maxiikk/tabazing/compare/5ed4e6d...e1690b3
[1.13.0]: https://github.com/maxiikk/tabazing/compare/9dd9bb5...5ed4e6d
[1.12.1]: https://github.com/maxiikk/tabazing/commit/4052951
