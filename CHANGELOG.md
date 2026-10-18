# Changelog

All notable changes to Tabazing are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [5.1.4] - 2026-10-18

### Changed

- Every action in a tab's menu (⋯, right-click, Shift+F10) has an icon before its name, the same as on the tab's buttons.

## [5.1.3] - 2026-10-18

### Fixed

- The command palette's list didn't scroll with the mouse wheel.

## [5.1.2] - 2026-10-18

### Fixed

- Opening the command palette shrank the whole switcher into a column as wide as the palette, which looked like the window resizing and broke the overlay. The palette now opens over the full switcher at the top of the screen.

## [5.1.1] - 2026-10-18

### Changed

- A tab's menu (⋯, right-click, Shift+F10), its buttons and its speaker say just what they do: "Reload", "Duplicate", "Pin", "Mute", "Archive", "Close" instead of "… this tab" (the command palette, which acts on the tab you came from, keeps "this tab").

### Fixed

- Opened from a small browser window (where Tabazing can't draw over the page), Tabazing's own window came out barely wider than the command palette; it is now at least 1000×680, centred on that window.

## [5.1.0] - 2026-10-18

### Added

- **Settings → Shortcuts**: the Chrome shortcuts that open Tabazing (previous card, next card, open and stay, command palette), each with the key Chrome has for it now or **Not set**, and a **Change** button that opens Chrome's shortcuts page; below them, the keys that work inside Tabazing.
- Settings opens on the category you used last.

### Changed

- **Settings is a dialog** in the middle of the screen, with a title, a **×**, its categories (Appearance, Cards, Search, Behaviour, Shortcuts) down the left and the chosen one's settings on the right; in a narrow window the categories are a row of tabs. The arrow keys, Home and End move between the categories; Esc, the × or a click outside closes it.
- "Change the Alt+Q shortcut" and "Keyboard and mouse shortcuts" left Settings: the Shortcuts category does both. The ⓘ card stays, and points to Settings → Shortcuts.

## [5.0.0] - 2026-10-18

### Changed

- **The command palette opens with Alt+R** (⌥R on a Mac) instead of Ctrl+Shift+Space, next to Tabazing's other keys; Alt+R inside Tabazing opens it too. Chrome keeps a shortcut it has already assigned when Tabazing updates: if yours still says Ctrl+Shift+Space, change it at `chrome://extensions/shortcuts`.
- "Show more" under Recently closed is a quiet text button that fills with the accent colour when you point at it.

## [4.1.2] - 2026-10-18

### Changed

- The **Merge windows** and **N duplicates** buttons moved to the **Open tabs** row too, before Sort and the filter chips; the toolbar above keeps only "Capture all previews".
- More room under the **Open tabs** row, so a hovered card no longer touches its buttons.

### Fixed

- Clicking an empty part of the header (around the search box or the media player) closed Tabazing.

## [4.1.1] - 2026-10-18

### Fixed

- This changelog: the 4.1.0 notes were released under "Unreleased".

## [4.1.0] - 2026-10-18

### Added

- **Command palette**: press **Ctrl+Shift+Space** (⌘⇧Space) on any page, or type **>** in the search box or press **Ctrl+K** (⌘K) in Tabazing. One box runs Chrome actions (new window, Incognito, reopen closed tab, Chrome's settings, extensions, history, downloads, passwords…), actions on the current tab (reload, duplicate, pin, mute, close, close others, move, zoom, full screen, copy link, bookmark) and Tabazing's own (close duplicates, merge windows, sleep tabs unused for a week, snooze, archive, theme, sort, capture previews, media…), and shows the same results as the search box.
- Quick answers in the palette: sums and percentages, unit conversions (length, weight, temperature, volume, area, speed, data, time), number bases, colours (with a swatch), time zones and date arithmetic. Enter copies the result; worked out on your computer. Currency isn't offered, as it would need the internet.
- The palette remembers the actions you ran recently, and finds actions by their English names in every language.
- The shortcuts card (ⓘ) and the tour cover the command palette.

### Changed

- Sort and the filter chips moved from the toolbar to the end of the **Open tabs** heading, which they apply to; the toolbar row takes no room when it has nothing to show.
- The Starred, Audio, Pinned, Asleep and Notes chips show only their icon and count; their name is in the tooltip and is what screen readers say, with the count.

## [4.0.0] - 2026-10-18

### Added

- **New Tab page**: Tabazing now provides Chrome's New Tab page (search box, your most visited sites, your starred pages, your shortcut), so the switcher opens as a real overlay there too instead of a separate window. Chrome asks once whether to keep it: choose "Keep it" ("Change it back" turns Tabazing off).
- An **ⓘ** button in the header lists every keyboard and mouse shortcut; the shortcut hint row is gone.
- A **⋯** button on each card, and right-click, open the card's full menu of actions.
- Selection: Ctrl/⌘+click ticks a card, Shift+click on a tick box ticks a range, Shift+arrows extend the selection and Ctrl+Space ticks the selected card.
- Undo for "Merge windows" and "Move to new window"; Undo after closing tabs brings them back with their back/forward history.
- Snooze: "Pick a time…" for any date and time, "Tomorrow evening" after 17:00, and a "Back from snooze" tag on tabs a snooze has just reopened.
- "Show more" in Recently closed.
- New settings: pinned tabs first, show Recently closed, show Snoozed, show "days ago" tags, title lines, search history / bookmarks, always open in its own window, replay the tour, keyboard shortcuts (grouped into Appearance, Cards, Search and Behaviour).
- The first-run tour also covers snooze, archive, windows and the media player.
- "Capture all previews" shows how long is left, and mutes each tab while it shows it.
- Media player: double-click a row in its list to play or pause it.

### Changed

- **Shift+click on a card opens the big preview** (it was Ctrl+click), and a plain click always switches to the tab, even while some are ticked.
- Alt+Q / Alt+W are described everywhere as they work: the previous / next card in the list, wrapping around; hold Alt and let go to switch.
- While you search, cards that don't match are dimmed, and the search box says what it searches (and leaves out history or bookmarks if you turn them off in Settings).
- Card headers are tidier: age, window and pinned tags sit on the preview, the star and × take no room until shown, and titles can use two lines. Cards show their most used buttons (pin, snooze, archive, note) and ⋯ for the rest.
- The header adapts to narrow windows: the search box is smaller, and the media player moves below it.
- No more "click again" confirmations: everything that asked for one now has Undo.
- The theme follows the system by default; in the light theme the selection and focus rings are darker so they stay visible.
- When Tabazing has to open in its own window (Chrome's own pages), the window covers your browser window.
- Toasts sit above the actions bar and stay while you point at them; the toolbar-icon tip shows at most 3 times; "Merge windows" moved into the windows list; "Capture all previews" is a compact button.
- Clicking between cards or on section headings no longer closes Tabazing; only clicking the backdrop does.
- Cards whose preview is still loading show a plain placeholder instead of "No preview yet".
- Clearer messages when an action fails, and consistent wording ("By recently used", sleep / asleep, close Tabazing).
- Media player detection matches Chrome's own media controls in more cases: video calls are left out, players moved within the page or inside web components are followed, streams of unknown length count after 5 s, the page's own playing / paused state is used, and the list is checked against the pages each time Tabazing opens (removed players, unloaded or crashed tabs drop out). Media in popup and app windows is listed too.

### Removed

- The shortcut hint row (see ⓘ).
- Ctrl+click for the big preview (now Shift+click) and Shift+click on a card for a range (now Shift+click on its tick box).
- Tabs that only make sound without media (games, calls) no longer appear in the media player, as in Chrome.

### Fixed

- Enter in the search box could open a hidden search result instead of the selected card.
- Media playing in a page that changes its own address (as YouTube does between videos) dropped out of the player.

## [3.1.2] - 2026-10-18

### Fixed

- A video stopped because you started one in another tab (as YouTube does) disappeared from the media player's list; like in Chrome's own media controls it now stays, paused.
- After Tabazing was updated or reloaded, media playing or paused in tabs that were already open was missing from the player until something changed there; those pages now report what they play right away, and a page that loads (or changes its own address) is asked again once loaded.

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

[5.1.4]: https://github.com/maxiikk/tabazing/compare/ad37917...HEAD
[5.1.3]: https://github.com/maxiikk/tabazing/compare/d593384...ad37917
[5.1.2]: https://github.com/maxiikk/tabazing/compare/6279c3f...d593384
[5.1.1]: https://github.com/maxiikk/tabazing/compare/bea73aa...6279c3f
[5.1.0]: https://github.com/maxiikk/tabazing/compare/b7f4bda...bea73aa
[5.0.0]: https://github.com/maxiikk/tabazing/compare/dcf07fc...b7f4bda
[4.1.2]: https://github.com/maxiikk/tabazing/compare/341c5d8...dcf07fc
[4.1.1]: https://github.com/maxiikk/tabazing/compare/e6117fd...341c5d8
[4.1.0]: https://github.com/maxiikk/tabazing/compare/9e8692c...e6117fd
[4.0.0]: https://github.com/maxiikk/tabazing/compare/81d1eae...9e8692c
[3.1.2]: https://github.com/maxiikk/tabazing/compare/6223238...81d1eae
[3.1.1]: https://github.com/maxiikk/tabazing/compare/b6177be...6223238
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
