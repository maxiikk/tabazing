# Changelog

All notable changes to Tabazing are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [6.16.5] - 2026-10-22

### Changed

- A tab group's tile: the pictures of its tabs no longer have a coloured frame of their own; the tile's border already shows the group's colour.

## [6.16.4] - 2026-10-22

### Removed

- Unused code and styles (nothing you could see or use changes).

## [6.16.3] - 2026-10-22

### Changed

- The license is the MIT License again: Tabazing is open source (see LICENSE).

## [6.16.2] - 2026-10-22

### Changed

- The license: Tabazing is no longer open source. All rights reserved: it may be installed, used and its code read, but not modified, copied or redistributed without permission (see LICENSE).

## [6.16.1] - 2026-10-22

### Added

- Tabazing is open source under the MIT License (the LICENSE file); the bundled Roboto font keeps its SIL Open Font License.

## [6.16.0] - 2026-10-22

### Changed

- Archive: a middle-click (or Ctrl+Enter) now opens the page in the background, and Tabazing stays open, as in the history and the bookmarks (it no longer takes the page out without opening it: its × still does); Undo puts it back in the archive.
- The history's and the bookmarks' search boxes start empty each time they open, and are emptied when they close; the last search no longer comes back.

## [6.15.0] - 2026-10-21

### Added

- Middle-click (press the mouse wheel on) a recently closed tab to take it off the list; Undo puts it back.
- Middle-click a snoozed tab to cancel its snooze, and a starred page that isn’t open to open it in the background.
- Middle-click a page in the Archive to take it out of the archive, as its × does.
- In the search results, middle-click a tab or a tab group to close it, a recently closed tab to take it off the list, and a bookmark or a visited page to open it in the background.

## [6.14.0] - 2026-10-21

### Added

- Drag a recently closed tab, a snoozed tab or a starred page onto the open tabs: it opens there in the background, and Tabazing stays open (By order, beside the card you drop it on). Onto a tab group's tile, it opens at the end of that group.
- Drag tabs, or a group's tile, onto a window in the list on the left to move them there (Undo moves them back); a page that isn't open opens in that window.
- Drop tabs on Snoozed to snooze them (its choices open), or on Recently closed to close them (Undo reopens them).
- Drop a link from another window or app on the open tabs, a group's tile or a window: it opens there in the background.
- While you drag, the places that take it are outlined.

### Changed

- A group's tile can be dragged in any sort (onto a window, or Recently closed); among the cards it still moves only By order.

## [6.13.1] - 2026-10-21

### Fixed

- Backup & Restore never doubles anything any more: two restores at once (two windows, or the dialog closed and opened again) waited for nothing and made every bookmark twice.
- Restore: bookmarks of addresses that differ only after "#" (such as `#inbox` and `#sent`) were taken for one; the second wasn't brought back, and its note could overwrite the other's.
- Restore: a page bookmarked in two folders came back in one of them only, with the other one's note.
- Restore: a folder you had moved came back empty in its old place.
- Restore: one bookmark Chrome refuses stopped the whole restore halfway; it is now left out and the rest restored. Bookmarks managed by an organization are no longer copied.
- Restore: notes kept the time they were restored instead of the time they were written; a setting with an invalid value reset that setting to its default.
- Restore: a folder holding several backups mixed them; a damaged or non-zip file said "Couldn't restore" instead of "That isn't a Tabazing backup"; broken entries and repeated notes were missing from the counts; bookmarks more than 40 folders deep were dropped.
- Arabic and Hebrew: English titles and addresses keep their punctuation where it belongs ("Hello, world!" showed as "!Hello, world"); dragging a card put it on the wrong side.
- The search, the palette and the bookmarks finder find words typed without their accents ("eglise" finds "Église", "καρτελα" "Καρτέλα").
- The highlighted search result no longer jumps to another row when history or bookmark results arrive late, so Enter opens the one you chose; in the history and bookmarks views, Enter right after typing opens what the text finds.
- Ctrl+H, Ctrl+Shift+O or Alt+R with Settings open opened a view or the palette that couldn't be used; Settings now closes first.
- Alt+R or Alt+E pressed while the switcher was still opening was ignored.
- Shift+→ on the last card wrapped round and replaced the ticked range; Shift+arrows on a group tile or closed card did nothing.
- Closing the selected group tile, or starring a page in the history or bookmarks view, sent the selection back to the first card; loading more history by scrolling moved the selection.
- History: a Shift+click after a new search ticked a range from the old list.
- A star or note on a very long address (over 2048 characters) was dropped without a word; Tabazing now says it can't keep one.
- A tab that went to the New Tab page (or another page Tabazing doesn't list) was logged as closing the page it had been on.
- A tab taken out of a group right after it changed could be remembered in the group (and reopen in it).
- Setting the computer's clock back made Alt+Q do nothing until the clock caught up.
- Capturing previews undid the "recent" order of a tab that Chrome replaced, or closed, meanwhile.
- A snoozed tab whose window closed just as it woke was lost; it now opens in another window, or waits for the next try.
- Quick answers: `cos(90)`, `0.3 - 0.1 - 0.2` and the like show 0, not a tiny leftover; `tan(90)` gives nothing; scientific notation (`2e10`, `1e-7`) is a number, not e; `10 mod -3` is 1; `0,001` is not a thousand; years before 100 and after 9999; dates in a sum, slashed dates (`12/25/2024`) and "Part 1 of 3" no longer give nonsense; `4k` is not −269 °C; `10 c in c` and `0xff in hex` give nothing; `mo` is a month; `15% + 15%` is 30%; `round(-2.5)` is −3; a copied number never has an exponent; "of" in every language (`15% von 80`, `15% от 80`), `Tokyo time?`, `UTC−5` with a real minus sign, and more Russian unit names.

## [6.13.0] - 2026-10-21

### Added

- Seven more languages: Greek, German, Italian, French, Arabic, Hebrew and Romanian, next to English, Spanish and Russian. Choose one in Settings → Appearance → Language, or leave it on Auto to follow Chrome.
- In Arabic and Hebrew, Tabazing runs right to left: the cards, the menu, Settings and every dialog are mirrored, and ← / → still go where they point (← is the next card).

### Changed

- In Hebrew and Arabic, a quick answer reads "1,234" as a thousand, as in English (these languages use a decimal point).

## [6.12.3] - 2026-10-21

### Changed

- MaxiiKK is named as Tabazing's author (in the extension's details and the README).

## [6.12.2] - 2026-10-21

### Changed

- The header's ⓘ (shortcuts) button comes first at the top right, the GitHub link last.

## [6.12.1] - 2026-10-21

### Changed

- History: the full date on a page's "last opened" tag shows only after the pointer stays on the tag for half a second.

## [6.12.0] - 2026-10-21

### Added

- Backup & Restore in the menu (☰): **Download backup** downloads `tabazing-backup-<date>.zip`, a `backup` folder with your notes, bookmark notes, stars, bookmarks, archive, snoozed tabs and settings as JSON files.
- Restore from the backup folder or the zip. A restore only adds: nothing you have is deleted, nothing is made twice, and the backup's notes go over the notes on the same pages and bookmarks. It says what was added, updated and skipped; settings only when you ask.

## [6.11.0] - 2026-10-21

### Added

- History: reaching the bottom of the list loads the next 50 pages by itself.

### Changed

- History: each page has a "last opened" tag saying how long ago ("5m ago", "3h ago", "1 year ago") instead of the time of day; hovering it shows the full date and time.

## [6.10.1] - 2026-10-21

### Changed

- A tab group's tile stands out: framed in the group's colour, its name on a chip of that colour with a tab-group icon, its picture in a frame of it. A tab's group tag is in the group's colour too.

### Fixed

- Dragging a tab onto a tab group's tile puts it in the group whatever the sort (it only worked when sorted By order); moving cards before or after others stays a By order thing.

## [6.10.0] - 2026-10-21

### Added

- A menu (☰) at the top left: a drawer from the left with History, Bookmarks, Archive and Settings, each with its icon and name.
- Every search that finds tabs also finds them by what they are: pinned, asleep, playing, muted, starred, with a note, in a group; and other pages by where they are: closed, archived, snoozed, bookmarked, history (in your language and in English).

### Changed

- History, Bookmarks and Archive open as dialogs, like Settings, over the dimmed switcher, with compact rows; a press beside one closes it.
- History, Bookmarks, Archive and Settings left the header for the menu, so the header keeps only the menu, New tab, the search box, GitHub and ⓘ.
- Tabs dropped on a tab group's tile join it at its end, in their order (a pinned tab is unpinned first), and so do tabs added with "Add to group".
- The switcher and the command palette show at once, with no opening animation.

## [6.9.1] - 2026-10-21

### Fixed

- Alt+Q / Alt+W no longer leave pinned tabs for the very end: they step through the cards in the order shown, so a pinned tab (shown first) is one Alt+Q away from the tab after it. Sorted by recently used, the first Alt+W still goes to the tab used just before, pinned or not.

## [6.9.0] - 2026-10-21

### Added

- History: a heading for each day, rows with previews (or cards, remembered), a time range (today, 7 or 30 days), and Clear browsing data….
- History: tick several pages (Shift+click for a range, Ctrl+A for all) to open, copy or remove them together; Undo after removing; "More from this site" and "Remove all from this site" (it asks first).
- Bookmarks: drag rows to move them, Ctrl+↑ ↓ to reorder, Move to… for ticked rows, and sort a folder by name or date added, all with Undo.
- Bookmarks: tick folders too, Shift+click for a range, Ctrl+A for all; the bar opens, moves, copies or deletes them.
- Bookmarks: Open all in a new window or in a new tab group; Duplicates shows the addresses bookmarked more than once; Bookmark your stars into a "Tabazing stars" folder.
- Bookmarks: the edit dialog has the note too and says where a page is bookmarked already; edits, new bookmarks and new folders have Undo.
- Ctrl+H (⌘Y) opens the History view and Ctrl+Shift+O (⌘⌥B) the Bookmarks view, from the switcher or from each other; the command palette has both too, and the ⓘ card, Settings → Shortcuts and the tour explain their keys.
- Both views: a middle-click or Ctrl+Enter opens a page behind Tabazing; Home, End, PgUp and PgDn move; matched words are marked; the big preview of a page without a picture shows what is known about it.
- Notes on bookmarks are found by the main search and the command palette.

### Changed

- Both views start with the focus in their search box, and bring back the last search (selected, so typing replaces it); the bookmarks also bring back the folders left open and the selected row.
- Esc in either view empties the search first, then unticks, then closes.
- History's count reads "50 shown" while there are more pages to load; searching says when it could only look through your newest 5000 visits.
- Opening more than 15 tabs at once, or deleting 10 bookmarks or more, asks first.
- On narrow windows the rows keep only their ⋯ menu.
- The Tabs Archive folder is marked as Tabazing's archive, with a way to its view.
- Big bookmark collections stay quick: the search waits for a pause in typing, far rows aren't laid out until needed, and previews load as rows come into view.

### Fixed

- A removed history page can be put back (Undo), also on Chrome versions that don't take a page's title and time.
- A note on a bookmark deleted elsewhere (in Chrome's bookmark manager) is dropped.

## [6.8.0] - 2026-10-21

### Added

- A Bookmarks button (after History) opens all your bookmarks as a tree with previews. Open, preview big, copy, star, snooze; add, edit (name, address, folder), delete one or several ticked at once, delete whole folders, all with Undo; search by name, site, address or note, typos forgiven.
- Notes on bookmarks: a bookmark's own note, kept with that bookmark even when its address changes, separate from the notes on tabs.
- A search box in the History view: pages by title, site, address or their note, typos forgiven.

### Changed

- The History button moved to the right of New tab, with the new Bookmarks button after it.

### Fixed

- A dialog opened from the History view (Bookmark…) no longer opens behind it.

## [6.7.0] - 2026-10-21

### Added

- A History button right of Settings opens your browsing history, newest first, 50 pages at a time with **Show 50 more** at the bottom. Each page shows its preview when Tabazing has one, otherwise its icon; open it, see it big, remove it from Chrome's history with its trash button (or Del), or use its ⋯ menu to open it in a new window or behind, copy, star, note, bookmark, snooze or archive it.
- Recently closed entries have a trash button that takes them off the list.

### Changed

- A recently closed tab's star moved into its ⋯ menu, to make room for the trash button.

## [6.6.3] - 2026-10-20

### Changed

- In the search results and the command palette, pointing at a row no longer moves the highlight: only ↑ / ↓ do, as with the cards. A click still opens or runs the row you click.

## [6.6.2] - 2026-10-20

### Changed

- A new icon in the switcher's modern look: four rounded tiles in blues on a dark rounded square, one of them lit, the tab you switch to.

## [6.6.1] - 2026-10-20

### Changed

- A card's buttons (star, ×, the quick actions, Capture preview) show only while the mouse is on the card, no longer on the selected card: the keyboard can't press them anyway (it has the card's menu, Shift+F10). A starred page's star and a note's button stay in view.

### Fixed

- While Alt is held (Alt+Q / Alt+W), Settings and New tab stay at the left end of the header and GitHub, ⓘ and Archive at the right, instead of bunching up together.

## [6.6.0] - 2026-10-20

### Added

- A GitHub button at the top right, left of the shortcuts button (ⓘ), opens Tabazing's repository in a new tab.

## [6.5.2] - 2026-10-20

### Fixed

- Clicking a card's buttons (×, the quick actions) no longer makes Chrome warn about a focused element hidden from screen readers: the focus stays in the search box, and a button that is given the focus back is no longer hidden while it has it.

## [6.5.1] - 2026-10-20

### Changed

- The look follows today's Material UI rather than the older Material style: quieter surfaces with thin borders and soft shadows, gently rounded corners, compact buttons, and no ripple on press.
- The keyboard focus is a soft halo in your accent colour; the selected card has an accent edge with that halo, and the highlighted search result and menu item are tinted with the accent instead of lifting and glowing.
- The open tab group sits on its own raised panel with a floating bar (the way back, the group's colour, name and tab count, Sort and filters) that stays at the top while you scroll.
- The capture-progress window and the cards Tabazing shows on web pages have the same look.

### Fixed

- Menus, select lists and small cards open right at what opened them and drop down from it (or up, when there is no room below), instead of growing in place; a long menu scrolls instead of running off the screen.
- A card's menu opened from the keyboard (Shift+F10, the menu key) drops from the card's ⋯ button instead of below the whole card.

## [6.5.0] - 2026-10-20

### Changed

- A new look in the manner of Material Design (as Material UI draws it): colours made from your accent colour for both themes, tonal surfaces with elevation shadows, rounded shapes, highlights on what you point at, and a ripple where you press.
- The header is a top app bar: a pill-shaped search bar, "New tab" as a floating action button, text buttons for Settings and Archive.
- Cards are elevated cards; filters, sorting and the setup actions are Material chips; the window list is a navigation drawer.
- Menus, dialogs, the command palette, the search results, the tooltip, the actions bar (a floating toolbar) and the note at the bottom (a snackbar) are drawn as Material draws them. Settings has switches and a navigation list, and its selects and text boxes are outlined fields.
- The archive opens as a full-screen dialog, the tour as a card on the accent's container colour.
- Roboto comes with the extension (Latin and Cyrillic), so the text looks the same everywhere.
- The capture-progress window and the first-run and "use Alt+Q" cards on web pages have the same look.

## [6.4.1] - 2026-10-20

### Changed

- Hovering a card no longer selects it: the selected card (lifted, what Enter opens) stays where the keyboard put it, and only a click switches to the tab. The same in the archive.

## [6.4.0] - 2026-10-19

### Added

- Tab groups from Tabazing: a tab's menu has "Add to group…" (the window's groups, or "New group…" with a name and one of Chrome's colours) and "Remove from group"; ticked tabs get "Add to group…" under More; the command palette can open, ungroup or close the current tab's group, and add the current tab to a group or take it out of one.
- A tile's menu has "Name and colour…", "Move group to new window", "Collapse / Expand in Chrome", and Put to sleep, Mute, Snooze and Archive for the whole group.
- A tile works like a card: Del, its × or a middle-click close the group (Undo brings it back), Ctrl+click, its tick box or Ctrl+Space tick all its tabs (some ticked shows a dash), Space or Shift+click show all its tabs' pictures big.
- A tile shows what its tabs are doing: "Current tab", how many play sound, sleep, have a note or a star, "Collapsed" in Chrome's tab strip, and its window when all windows are shown.
- Search finds tab groups by name (Enter opens one), and in a group lists that group's tabs first.
- "By order": drag a tile to move the whole group, or drop tabs on a tile to put them in that group.
- Settings → Cards → "Alt+Q / Alt+W go round inside a tab group" (off by default): they wrap at the group's ends instead of stepping out.
- A tour step about tab groups, and screen readers hear when you go into or out of a group.

### Changed

- Esc in a group goes back to all the tabs (one level back, as elsewhere); Esc again closes Tabazing. The "All tabs" button shows the key.
- Opening Tabazing in any way from a tab outside the group it was in leaves that group, as Alt+Q / Alt+W already did. Stepping out of a group with Alt+Q / Alt+W no longer forgets it until you actually go elsewhere.
- By recent use, the tab you used just before is always one Alt+W away, even when it is pinned (pinned tabs are still shown first).
- Sorted by name, a group's tile goes where its group's name does.
- Filters and the Starred filter keep groups as tiles, showing only the tabs they let through.
- An unnamed group is called by its colour ("Blue group"), as Chrome shows it.
- "Reopen in the background" on a closed tab Chrome remembers says it opens without its history.

### Fixed

- Merge windows broke up the other windows' tab groups; it now moves them as groups, and Undo puts them back in their groups.
- "Move to new window" took tabs out of their group; their group now goes along (Undo puts them back in it).
- "Select all" ticked tabs inside group tiles without showing it; a tile now shows its tabs' ticks.
- Undo after closing every tab of the group you were in brought the tabs back, but not the group view.
- Group changes made in Chrome while Tabazing was open (renamed, recoloured, tabs moved in or out) only showed after reopening it.
- The palette's "New tab" in a group didn't add the tab to the group, unlike the header's.
- A snoozed tab, or a closed tab reopened from Tabazing's own log, came back outside the group it was in.
- Close duplicates could close the copy inside a group and keep the loose one.

## [6.3.1] - 2026-10-19

### Changed

- Nothing you can see: a test now covers stepping inside a tab group by recent use (after going from one of its tabs to another, Alt+W goes back to the first).

## [6.3.0] - 2026-10-19

### Changed

- Alt+Q / Alt+W keep tab groups as tiles: a group is one step, and letting go of Alt on its tile opens the group instead of switching tabs. Inside a group they step through its tabs; before its first tab or after its last they step out of it, to the card before or after its tile (another group's tile opens only when you let go of Alt on it). This replaces 6.2.0's way, which showed every tab on its own while Alt was held.
- Alt+Q / Alt+W from a tab outside the group Tabazing was inside of (after going elsewhere in Chrome itself) leave the group and step among all the tabs.

## [6.2.1] - 2026-10-19

### Fixed

- A tab group with fewer than four tabs showed empty placeholders in its tile. Its picture now has one cell per tab: one fills it, two sit side by side, three are one big and two small.
- The thin "stacked card" edge under a group's tile, which looked like a stray line, is gone.

## [6.2.0] - 2026-10-19

### Added

- Settings → Cards → "Show tab groups as tiles" (on by default): off, every tab has its own card again, tagged with its group's name.

### Fixed

- Inside a tab group, Alt+Q / Alt+W couldn't reach the tabs outside it. While Alt is held they now step through every tab in the usual order, out of the group too; staying open brings the group view back.

## [6.1.0] - 2026-10-19

### Added

- Tab groups: each of Chrome's tab groups shows among the cards as one tile in the group's colour, its picture the group's first four tabs. Opening a tile shows only that group's tabs, and Tabazing stays inside the group every time it opens until you leave it ("‹ All tabs", Backspace in the empty search box, or the palette's "Leave the tab group"). Alt+Q steps through the group's tabs there, and "New tab" opens the tab in the group.
- A tile's menu: open the group, copy its links, bookmark it, ungroup it, or close it (Undo brings the tabs back in a group of the same name and colour).
- "Bookmark…" on every tab (its menu, a recently closed tab's, a group's, and More for ticked tabs): a dialog to choose the bookmarks folder (find one by name, or make a new one), starting on the folder used last, with Undo. The palette's "Bookmark this page" opens it too.
- Recently closed tabs have a note button and a menu: reopen, reopen in a new window, reopen in the background, copy link, star, note, bookmark, snooze, archive, and remove from the list (Del too, with Undo).
- Search results and the cards tag a tab with its group, outside the group view.

### Changed

- The highlighted result in the search list and the command palette lifts and glows like the selected card.
- The rows in the media player's list no longer light up or take the keyboard focus themselves: only their buttons do.

### Fixed

- A note is shown on a search result found by it whatever state its page is in: a recently closed, archived, bookmarked or visited page, not only an open tab. Those are now found by their notes too.
- A video playing muted or with its volume at 0 (a YouTube video with the sound off) was missing from the media player. The site's own player now shows there; muted autoplay in feeds and hover previews still doesn't.

## [6.0.1] - 2026-10-18

### Changed

- The source is organized into folders: the pages in `markup/`, the stylesheets in `styles/` and the shared modules in `utils/` (was `lib/`).

## [6.0.0] - 2026-10-18

### Removed

- Tabazing's own New Tab page. Chrome's New Tab page is back; Alt+Q there opens Tabazing in its own window, as on other `chrome://` pages. The "New tab" button and the palette's New Tab action still open a new tab.

## [5.2.0] - 2026-10-18

### Changed

- Clicking empty space anywhere in Tabazing (the backdrop, the header, between cards) no longer closes it; Esc does.
- Alt+R opens the command palette on its own, over the dimmed backdrop, without showing the switcher behind it. Opened from inside the switcher (> or Ctrl+K) it still shows over the dimmed switcher.

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

[6.16.5]: https://github.com/maxiikk/tabazing/compare/e090620...HEAD
[6.16.4]: https://github.com/maxiikk/tabazing/compare/4ee72f1...e090620
[6.16.3]: https://github.com/maxiikk/tabazing/compare/f7f0038...4ee72f1
[6.16.2]: https://github.com/maxiikk/tabazing/compare/1bf7dbf...f7f0038
[6.16.1]: https://github.com/maxiikk/tabazing/compare/1009dfe...1bf7dbf
[6.16.0]: https://github.com/maxiikk/tabazing/compare/bdd206e...1009dfe
[6.15.0]: https://github.com/maxiikk/tabazing/compare/1f3e285...bdd206e
[6.14.0]: https://github.com/maxiikk/tabazing/compare/19f50c5...1f3e285
[6.13.1]: https://github.com/maxiikk/tabazing/compare/e092117...19f50c5
[6.13.0]: https://github.com/maxiikk/tabazing/compare/ff28464...e092117
[6.12.3]: https://github.com/maxiikk/tabazing/compare/2315e98...ff28464
[6.12.2]: https://github.com/maxiikk/tabazing/compare/e93bf5c...2315e98
[6.12.1]: https://github.com/maxiikk/tabazing/compare/7b1c4c2...e93bf5c
[6.12.0]: https://github.com/maxiikk/tabazing/compare/be73ae8...7b1c4c2
[6.11.0]: https://github.com/maxiikk/tabazing/compare/e8b898b...be73ae8
[6.10.1]: https://github.com/maxiikk/tabazing/compare/14a2776...e8b898b
[6.10.0]: https://github.com/maxiikk/tabazing/compare/4e66da4...14a2776
[6.9.1]: https://github.com/maxiikk/tabazing/compare/b54e1f5...4e66da4
[6.9.0]: https://github.com/maxiikk/tabazing/compare/fcbc898...b54e1f5
[6.8.0]: https://github.com/maxiikk/tabazing/compare/55dba83...fcbc898
[6.7.0]: https://github.com/maxiikk/tabazing/compare/7e24214...55dba83
[6.6.3]: https://github.com/maxiikk/tabazing/compare/b995760...7e24214
[6.6.2]: https://github.com/maxiikk/tabazing/compare/4185787...b995760
[6.6.1]: https://github.com/maxiikk/tabazing/compare/d99194d...4185787
[6.6.0]: https://github.com/maxiikk/tabazing/compare/61fca4a...d99194d
[6.5.2]: https://github.com/maxiikk/tabazing/compare/d2ef9c3...61fca4a
[6.5.1]: https://github.com/maxiikk/tabazing/compare/2c4f60a...d2ef9c3
[6.5.0]: https://github.com/maxiikk/tabazing/compare/ed09220...2c4f60a
[6.4.1]: https://github.com/maxiikk/tabazing/compare/fbb6a27...ed09220
[6.4.0]: https://github.com/maxiikk/tabazing/compare/0c7ba85...fbb6a27
[6.3.1]: https://github.com/maxiikk/tabazing/compare/ad37a0b...0c7ba85
[6.3.0]: https://github.com/maxiikk/tabazing/compare/7e4fde2...ad37a0b
[6.2.1]: https://github.com/maxiikk/tabazing/compare/8a7846c...7e4fde2
[6.2.0]: https://github.com/maxiikk/tabazing/compare/f8a4757...8a7846c
[6.1.0]: https://github.com/maxiikk/tabazing/compare/ecbee9a...f8a4757
[6.0.1]: https://github.com/maxiikk/tabazing/compare/cce6e44...ecbee9a
[6.0.0]: https://github.com/maxiikk/tabazing/compare/5045321...cce6e44
[5.2.0]: https://github.com/maxiikk/tabazing/compare/9c671ea...5045321
[5.1.4]: https://github.com/maxiikk/tabazing/compare/ad37917...9c671ea
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
