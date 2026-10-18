# Tabazing

**Alt+Tab for Chrome tabs.** Tabazing shows every open tab as a card with a live preview of the page, so you can see where you are going before you get there. Hold Alt and tap Q to flick between tabs, or open it and type to find any tab, a tab you closed earlier, a bookmark or a page from your history. It also stars, notes, snoozes, archives, sleeps, mutes and tidies tabs, one at a time or many at once.

Everything stays on your computer. Previews, notes, stars and settings are stored locally by Chrome; the extension pages are locked down so they cannot make network requests at all, and nothing is sent anywhere.

Current version: **3.1.0** (from `manifest.json`). Available in English, Spanish and Russian.

---

## Contents

1. [Installation](#installation)
2. [Opening Tabazing](#opening-tabazing)
3. [Feature guide](#feature-guide)
4. [Privacy and permissions](#privacy-and-permissions)
5. [Development](#development)

---

## Installation

Tabazing needs **Chrome 123 or later**.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (the one that contains `manifest.json`).
4. Pin the Tabazing icon to the toolbar if you like. The icon shows how many tabs you have open.

Right after installing, a small card on the page you are on says "Tabazing is ready – Press Alt+Q to see all your tabs".

**Changing the shortcuts:** go to `chrome://extensions/shortcuts`, or open Tabazing → **Settings** → **Change the Alt+Q shortcut**. If another app or extension already uses Alt+Q, Chrome leaves it unassigned. Tabazing then shows a warning with a button that takes you to that page. On ordinary web pages Alt+Q still works, because the page itself listens for it.

Tabazing does not run in Incognito windows.

---

## Opening Tabazing

| Shortcut | Mac | What it does |
|---|---|---|
| **Alt+Q** | Option+Q | Opens Tabazing with the card **before** the current tab selected. Keep holding Alt and press Q again to go further back. **Let go of Alt to switch** to the selected tab, just like Alt+Tab. |
| **Alt+W** | Option+W | The same, but moves **forward** (the card after the current tab). |
| **Alt+E** | Option+E | Opens Tabazing with the current tab selected and **keeps it open**, so you can search, use the arrow keys or the mouse. |
| Toolbar icon | Toolbar icon | Opens Tabazing and keeps it open. |

While you hold Alt after Alt+Q or Alt+W:

- Press **Q** to go back and **W** to go forward. Add **Shift** to go the other way.
- **Turn the mouse wheel** to move through the cards. Scrolling a touchpad works too.
- Press **1–9** (Alt is already down, so this is Alt+1–9) to jump straight to that numbered card.
- **Let go of Alt** to switch. If you start typing, move the mouse or let go of Alt without switching, Tabazing stays open as if you had pressed Alt+E. Pressing Alt+Q or Alt+W in an open Tabazing makes it behave like Alt+Tab again.

**Where it appears.** On normal web pages Tabazing opens as an overlay on top of the page. Chrome does not let extensions draw on some pages, such as `chrome://` pages, the New Tab page and the Chrome Web Store. On those, and on pages that block the overlay, it opens in its own small popup window instead. Both versions work the same way.

**Closing it.** Press **Esc**, click an empty area, or switch to another window. Tabazing also closes after you pick a tab.

**Open when Chrome starts.** Turn this on in Settings and Tabazing shows all your tabs a few seconds after Chrome starts, once your tabs have been restored.

**"Looking for a tab?"** If you often click through tabs one by one (Ctrl+Tab, Ctrl+PgDn), a small note may suggest Alt+Q instead. It appears at most once a day and three times in total. It stops once you are using Tabazing, and **Don't show again** turns it off for good.

**First-run tour.** The first time you open Tabazing, a short tour walks through switching, moving around, search, the buttons on each card, selecting many tabs, sorting and settings. Use **Next**, **Back** or **Skip**, or the ← → arrow keys. Esc closes it.

---

## Feature guide

### Cards and previews

Each open tab is a card that shows the page title, its favicon and a screenshot of the page.

- Chrome only lets extensions screenshot the tab that is currently on screen. Tabazing takes a picture every time you look at a tab, so previews fill in as you use your tabs. A tab you have not looked at since Chrome started shows its icon and "No preview yet".
- **Pinned tabs always come first**, followed by the rest in the order you chose under [Sort](#sort-and-filters).
- The **first nine cards are numbered**. Press **Alt+number** (⌥+number on a Mac) to switch to that tab.
- Small tags on a card show:
  - how long ago you last looked at the tab ("3 days ago", for tabs not viewed for a day or more)
  - which window it is in (when you view tabs from several windows)
  - a pin for pinned tabs
  - a speaker for tabs playing sound (click it to mute or unmute)
- Sleeping tabs (unloaded by Chrome to save memory) show a moon with "Sleeping".
- Hover a card to see its full title and address.

#### Capture preview / Capture all previews

- **One tab:** a card with no preview has a **Capture preview** button (or press **Alt+P** / Option+P with the card selected). Tabazing shows that tab for a moment, takes its picture and comes back.
- **Many tabs:** when some tabs have no preview, a **"N without preview · Capture all"** button appears in the toolbar. When the view is narrowed, it reads "Capture these" instead. A small progress window opens, and each tab is shown briefly (up to 100 per run) before you are taken back where you were. Click **Stop** in that window to stop early. Sleeping tabs are skipped so they are not woken up.
- Some pages cannot be captured, such as Chrome's own pages and the Web Store. If Chrome's **Site access** for Tabazing is not set to "On all sites", previews cannot be taken; Tabazing says so and offers an **Allow on all sites** button.

#### Big preview

- Press **Space** (with nothing typed in the search box), or **Ctrl+click** a card (**Cmd+click** on a Mac), to see its preview in full size in the middle of the screen.
- In the big preview, **← / →** move to the previous or next card, **Enter** opens that tab, and **Esc**, Space or clicking outside closes it.

### Keyboard reference

On a Mac, "Alt" is the Option key (⌥).

| Key | Windows / Linux | Mac | What it does |
|---|---|---|---|
| Move | ← → ↑ ↓ | ← → ↑ ↓ | Move the selection between cards. With the search list open, ↑ ↓ move through the results. |
| Next / previous | Tab / Shift+Tab, while holding Alt | Tab / Shift+Tab, while holding ⌥ | Step through the open tabs in the order shown, like Alt+Tab. Without Alt held, Tab moves the keyboard focus through Tabazing's buttons and fields, as on any page. |
| Card actions | Shift+F10 or the Menu key | Shift+F10 | Open a menu of everything you can do with the selected card: select it, star, copy link, capture, reload, duplicate, sleep, mute, pin, snooze, archive, note, close. |
| Jump | Alt+1 … Alt+9 | ⌥1 … ⌥9 | Switch to that numbered card. Works at any time, including while still holding Alt after Alt+Q. Plain digits type into the search box, so you can find titles that start with a number. |
| Open | Enter | Enter | Switch to the selected tab, or open the highlighted search result. |
| Address / Google | Shift+Enter | Shift+Enter | Open what you typed as an address, or search Google for it. |
| Big preview | Space | Space | Show the selected card's preview in full size (when nothing is typed). |
| Close tab | Del | ⌘⌫ | Close the selected tab. On a snoozed tab, cancels the snooze. On a "Starred, not open" card, removes the star. |
| Undo close | Ctrl+Z | ⌘Z | Reopen what you last closed in Tabazing, in the same window and position (when the search box is empty). |
| Star | Alt+S | ⌥S | Star or unstar the selected page. |
| Capture | Alt+P | ⌥P | Take a preview of the selected tab. |
| Search | Ctrl+F | ⌘F | Jump to the search box. Just typing anywhere works too. |
| Windows | Ctrl+← / Ctrl+→ | ⌃← / ⌃→ | Show the previous or next window's tabs, or all windows (when there is more than one window). |
| Back / exit | Esc | Esc | In this order: clears the search, leaves the duplicates view, clears the selection, closes Tabazing. |

### Mouse

| Action | Result |
|---|---|
| Click a card | Switch to that tab, or reopen a closed, snoozed or starred page. |
| Ctrl+click (Cmd+click) | Big preview. |
| Shift+click | Select every tab between the last one you selected and this one. |
| Click the tick box on a card | Select or deselect it. Once any tab is selected, a plain click on a card also selects or deselects it. |
| Middle-click (press the wheel) | Close the tab. |
| Drag a card | Move the tab in the tab strip. Only works when sorted **By order** (see below). |
| Alt + mouse wheel | Step through cards while holding Alt after Alt+Q or Alt+W. |
| Click empty space | Close Tabazing. |

### Search

Type anywhere and the text goes into the search box. As you type, a dropdown under the box shows **one ranked list** of everything that matches, best match first:

| Icon / source | What it covers |
|---|---|
| Open tab | Your open tabs. A tag shows the window if it is a different one. |
| Recently closed | Tabs and windows closed in the **last 7 days**. |
| Archived | Pages in your [Archive](#archive). |
| Bookmark | Your Chrome bookmarks, with their folder path. |
| History | Pages from your browsing history: the last 90 days, plus Chrome's own history search for older pages. |

- An icon at the right of each row shows where the result comes from. If the same page is found in several places, it is listed once, under the most useful source (an open tab comes before its bookmark, for example).
- **Typos are fine.** Words can match at the start of a word, as initials ("pr" finds "Pull request"), anywhere in a word, as letters in order ("gh" finds "GitHub"), or with one wrong, missing, extra or swapped letter (two in long words). Words that contain digits must be typed exactly. Search also looks at the **notes** you wrote on tabs.
- **↑ / ↓** move through the list, **Enter** opens the highlighted row, and a click does the same. Open tabs are switched to. Closed tabs are reopened with their back/forward history when Chrome still has it. Bookmarks and history entries switch to the tab if the page is already open, or open a new tab otherwise.
- **Nothing found?** The list offers **Open \<address\>** when what you typed looks like a web address, and **Search Google for "…"**. **Shift+Enter** does this at any time.
- The count in the search box shows how many open and closed tabs matched.
- While searching, the bar at the bottom offers **Select all N matching tabs**, so you can act on every match at once (see [Selecting many tabs](#selecting-many-tabs-and-the-actions-bar)).
- The cards behind the dropdown do not change while you search. Press Esc to clear the search.

### Media player

When a tab is playing a video or music, a small player appears in the header, right of the search box and the same height. It shows the preview of that tab (or its icon), the title of what is playing (and the artist or the site under it), and **Previous**, **Play / Pause** and **Next** buttons. It is hidden while nothing plays, and while you hold Alt after Alt+Q or Alt+W.

- **Play / Pause** works on any video or audio. **Previous** and **Next** work where the site has its own previous / next track buttons (the ones Chrome's own media controls show, as on YouTube, Spotify or SoundCloud); elsewhere they are greyed out.
- The **⌄** button at the end opens **All media in your tabs**: one row per tab that has something to play, in every window, playing first. Each row has its preview, title, site, a moving-bars sign while it plays, and its own **Previous**, **Play / Pause**, **Next** and **Go to tab** buttons. Click a row to show it in the header player. **Go to tab** switches to that tab, like picking its card. **Tab** moves through the list, **Esc**, a click outside or the ⌄ again closes it.
- Short clips (under 30 seconds), muted looping videos (background videos, animated "GIFs") and media that has nothing loaded are left out, unless the site describes them as media to Chrome.
- Pages that were already open when Tabazing was installed or updated only show up once they play sound, with their tab's title, and only Play / Pause works there until they are reloaded.
- If a page doesn't respond (some players ignore outside play requests), a message says so and the button goes back.

### Windows

- **Show tabs from all windows** (Settings) lists the tabs of every Chrome window. When it is off, Tabazing shows only the window you opened it in.
- With more than one window shown, a **window list** appears on the left. It starts with **All windows**, then each window with a small picture of the tab it is showing and its number of tabs. Click a window, or press **Ctrl+← / Ctrl+→**, to see only that window's tabs. Cards from other windows carry a "Window N" tag.

#### Merge windows

- **Everything into this window:** when you have other windows open, the toolbar shows **Merge N windows into this one**. Click it, then click again to confirm. All their tabs move into the current window, after the tabs it already has. Pinned tabs stay pinned and the emptied windows close.
- **One window:** hover a window in the window list and click its **merge** icon (click twice to confirm) to pull just that window's tabs in.

### Sort and filters

**Sort** (the dropdown on the toolbar; your choice is remembered):

| Option | Order |
|---|---|
| **By recently opened** (default) | Most recently used first, like Alt+Tab. |
| **By order** | The same order as Chrome's tab strip, current window first. **Drag cards to move tabs**: drop on the left or right half of another card to place the tab before or after it. If you selected several tabs, they all move together. With all windows shown, you can drag a tab into another window. |
| **By name** | Title, A to Z. |

Pinned tabs come first in every order.

**Filters** (chips next to Sort): pick one at a time, and click it again to turn it off. A chip only appears when some tab matches it, and it shows how many do.

| Chip | Shows |
|---|---|
| **Starred** | Only starred pages. Starred pages that are not open appear below in a **Starred, not open** section; click one to open it. |
| **Audio** | Tabs that are playing sound or are muted. |
| **Pinned** | Pinned tabs. |
| **Asleep** | Tabs that are unloaded, or marked to sleep. |
| **Notes** | Tabs that have a note. |

### Buttons on each card

Hover a card to show its quick buttons along the bottom of the preview. With the **List** card size, they sit in the card's single row.

| Button | What it does |
|---|---|
| Copy link | Copies the tab's address. |
| Reload | Reloads the tab. A sleeping tab wakes up. |
| Duplicate | Opens a copy right after it, in the background. |
| Sleep (moon) | Marks the tab to be unloaded to free memory. See [Sleep](#sleep). Not shown on the active tab. |
| Mute / Unmute | Turns the tab's sound off or on. |
| Pin / Unpin | Pins or unpins the tab. |
| Snooze (clock) | Closes the tab now and reopens it later. See [Snooze](#snooze). |
| Archive (box) | Moves the tab into the archive. See [Archive](#archive). |
| Note | Adds or edits a note. See [Notes](#notes). |

The card header also has a **☆ star** and an **× close** button.

### Stars

- Click **☆** on a card, or press **Alt+S** (⌥S), to star a page. Click or press again to remove the star.
- Stars belong to the page's address, not to the tab. A starred page stays starred after you close it, and it is kept by Tabazing, not in Chrome's bookmarks.
- The **Starred** chip shows how many pages are starred. Click it to see only starred tabs, plus starred pages that are **not open**, which you can reopen with one click. Pressing Del on one of those removes its star.

### Notes

1. Click the **note** button on a card.
2. Type your note (up to 1,000 characters). It is saved as you type and when the note card closes. Click outside, press Esc or click the ×.
3. To remove a note, click **Clear**, or leave the box empty.

Notes belong to the page's address. A card with a note has a highlighted note button, and hovering it shows the note. Search finds tabs by their notes, and the **Notes** filter shows every tab that has one.

### Snooze

Snoozing closes a tab now and has Tabazing reopen it later, in the background, in the window it came from.

1. Click the **clock** button on a card, or select several tabs and choose **More → Snooze…**.
2. Choose when: **In 1 hour**, **In 3 hours**, **This evening** (18:00, offered before 17:00), **Tomorrow morning** (9:00) or **Next week** (Monday 9:00).
3. A message confirms the time and offers **Undo**.

Snoozed tabs appear in a **Snoozed** section below your open tabs, soonest first, each marked "back \<time\>". Click one to open it now, or press its **×** (or Del) to cancel the snooze without reopening. If a snoozed tab comes due while Chrome is closed, it reopens the next time Chrome starts. Chrome's own pages (such as `chrome://` pages) cannot be snoozed.

### Archive

The archive is for tabs you want to keep but not have open. Archiving a tab saves it as a bookmark in a **"Tabs Archive"** folder under **Other bookmarks**, then closes it.

- **Archive a tab:** click the **box** button on its card, or select several tabs and choose **More → Archive**. A message offers **Undo**, which takes the tabs out of the archive and reopens them where they were.
- **See the archive:** click **Archive** at the top right of Tabazing. The Archive overlay shows every archived tab, newest first, with its preview when one is available and when it was archived.
  - **Open** a page by clicking it, or select it with the arrow keys and press **Enter**. It opens in a new tab and is **taken out of the archive**.
  - **Remove** a page without opening it with the **×** on its card, or **Del** (⌘⌫). Undo is offered.
  - Close the archive with **Esc** or the red ×.
- Archived pages also show up in [search](#search) with an Archived icon.
- Because the archive is a normal bookmarks folder, it **syncs with your Chrome account** like any bookmark and **is kept if you remove Tabazing**. You can also manage it in Chrome's bookmark manager.

### Recently closed

- Below your open tabs, a **Recently closed** section shows what you closed in the last few hours (up to 8 items, including up to 2 whole windows). Click one to reopen it. Tabs Chrome still remembers come back with their back/forward history.
- **Search reaches further back:** it finds anything closed in the **last 7 days**, using Chrome's own list plus Tabazing's local log of closed tabs.

### Undo close

Closing a tab in Tabazing, with the × button, Del, middle-click or the **Close** action, shows a message with an **Undo** button. **Ctrl+Z** (⌘Z) works too. Undo reopens the tabs in the same window and position, pinned if they were pinned. You can undo several closes in a row, up to the last 20, while Tabazing stays open.

### Selecting many tabs and the actions bar

1. Select tabs with the **tick box** on each card. **Shift+click** selects a range. While searching, **Select all N matching tabs** selects every match; otherwise **Select all N tabs** selects everything shown.
2. A bar floats at the bottom of the screen with the number selected and these actions:

| Action | What it does |
|---|---|
| **Close** | Closes the selected tabs. With more than one, click twice to confirm. They can be undone and appear under Recently closed. |
| **Copy links** | Copies their addresses, one per line. |
| **More → Copy as Markdown** | Copies `- [Title](link)` lines, which paste as clickable titles in Notion, Obsidian, GitHub, Slack or Docs. |
| **More → Move to new window** | Moves them into a window of their own. |
| **More → Sleep** | Marks them to be unloaded. |
| **More → Snooze…** | Snoozes them all until the time you choose. |
| **More → Archive** | Archives them all. |
| **More → Pin / Unpin** | Pins them, or unpins them if they are all pinned already. |
| **More → Mute / Unmute** | Mutes them, or unmutes them if they are all muted already. |

**Clear** (or Esc) deselects everything. When sorted By order, dragging one selected card moves all the selected tabs.

### Duplicates

When the same page is open in more than one tab, the toolbar shows **N duplicates**. Tabazing compares addresses and ignores the `#…` part and a trailing slash.

1. Click it. Tabazing shows only the duplicated pages, grouped by page. Each card is marked **Stays** or **Closes**. The copy that stays is the pinned one if any, otherwise the one you used most recently.
2. Click **Close N copies**, then click again to confirm. Undo is offered.
3. **Back**, or Esc, leaves the view without closing anything.

### Sleep

Sleeping a tab unloads it from memory. It keeps its place and reloads when you open it.

- Click the **moon** on a card, or select tabs and choose **More → Sleep**. The card is marked "Sleeps when you leave". The tab is unloaded once you close Tabazing, so the switcher stays smooth. Click the moon again to change your mind.
- Chrome won't unload the tab you are looking at.
- Tabs that Chrome itself unloaded (Memory Saver) are marked **Sleeping**. The **Asleep** filter shows both kinds.

### New tab

The **New tab** button in the header opens a new tab in the current window.

### Settings

Click **Settings** (the gear at the top left).

| Setting | Options |
|---|---|
| **Language** | Auto (Chrome's language), English, Español, Русский. |
| **Theme** | Dark (default), Light, Match system. |
| **Card size** | Default, Small, List (one line per tab, no screenshot). |
| **Accent colour** | A set of colour swatches, or **Pick any colour**. |
| **Show tabs from all windows** | Off: only the window you open Tabazing in. On: every window, with the window list on the left. |
| **Open Tabazing when Chrome starts** | Shows all your tabs, where you left off, a few seconds after Chrome opens. |
| **Change the Alt+Q shortcut** | Opens `chrome://extensions/shortcuts`. |

Settings, the sort order and your stars, notes and snoozed tabs are remembered between sessions.

### Feedback prompt

After you have used Tabazing for a while, it may ask once "How is Tabazing working for you?". Your answer stays on your computer. The buttons only open a page (a Chrome Web Store review, or a short survey) in a new tab, where you decide what to send. **Don't ask again** stops it.

---

## Privacy and permissions

- **Nothing leaves your computer.** Tabazing's pages run under a content security policy with `connect-src 'none'`, so they cannot contact any server. The only web pages Tabazing ever opens are the ones you click, such as the review link.
- **What is stored, and for how long** (all in Chrome's local extension storage, on this device):
  - **Page previews** are kept by page address. A preview no open tab uses is deleted **7 days** after it was last captured or used. Storage is capped at 300 previews (plus up to 80 sharp copies for the big preview).
  - **Closed-tabs log:** address, title and icon of tabs you closed, kept **7 days** (up to 200 entries), for search.
  - **Stars, notes and snoozed tabs** (address, title, time) until you remove them.
  - **Settings and sort order**, the first-run, nudge and feedback-prompt counters.
  - **Tab usage order**, kept only in memory and cleared when Chrome closes.
  - **What each tab is playing** (title, artist, playing or paused, which buttons the site offers) for the media player, kept only in memory and forgotten when the tab closes or loads another page.
- **Archived tabs** are ordinary Chrome bookmarks, so they sync with your Chrome account if you have bookmark sync turned on.

| Permission | Why Tabazing needs it |
|---|---|
| `tabs` | List your tabs and their titles and addresses, and switch, close, move, pin, mute, reload, duplicate and unload them. |
| Host access to all sites (`<all_urls>`) | Take a screenshot of the visible tab for its preview, show the switcher as an overlay on the page, catch Alt+Q on web pages when Chrome's shortcut is unavailable, and see what a page is playing for the media player. |
| `scripting` | Put the overlay, the Alt+Q listener, the "Tabazing is ready" card and the "Looking for a tab?" note into pages, and press play, pause, previous or next in a page from the media player. |
| `storage` | Save previews, stars, notes, snoozed tabs, settings and the closed-tabs log on this device. |
| `unlimitedStorage` | Lift Chrome's 10 MB storage limit so the sharp copies used by the big preview fit. Previews are still capped and expire. |
| `favicon` | Show each site's icon on its card and in search results. |
| `sessions` | List recently closed tabs and windows, and restore them with their history. |
| `alarms` | Wake up at the right time to reopen snoozed tabs. |
| `bookmarks` | Keep the "Tabs Archive" folder, and search your bookmarks. |
| `history` | Search your browsing history from the search box. |

---

## Development

The extension itself has no build step and no runtime dependencies. Load the folder unpacked (see [Installation](#installation)); after editing, click the reload button on Tabazing's card at `chrome://extensions`. Reload the extension after a change to `manifest.json` permissions; Chrome only grants new permissions then.

### Tests

The tests use [Vitest](https://vitest.dev) with jsdom.

```sh
npm install                              # once
npm test                                 # run everything
npx vitest run tests/switcher/archive    # run part of it
npm run test:watch                       # re-run on change
```

- `tests/` mirrors the source: `tests/lib/<module>.test.js`, `tests/background*.test.js`, `tests/switcher/<area>.test.js`, `tests/hotkey.test.js`, `tests/media-hook.test.js`, `tests/media-relay.test.js`, `tests/sweep-page.test.js`.
- `tests/setup/chrome.js` is an in-memory fake of the `chrome.*` APIs, reset before every test. `tests/setup/dom.js` adds what jsdom lacks. `tests/helpers/switcher.js` (`bootSwitcher`) boots the real switcher page.
- `switcher.js` and `background.js` end with an `export { … }` list so tests can reach their functions. Add new top-level functions to it.
- **Tests find elements only by `data-testid`**, never by role, id, class or tag. Every element the extension creates carries one: in HTML as an attribute, in `switcher.js` through `h(tag, cls, text, testid)` (and `button(testid, label, cls, fn)` in dialogs), elsewhere via `el.dataset.testid`. Repeated elements share one test id per kind (`card-tab`, `card-closed`, `dd-row-mark`).
- The folder is `tests/`, not `__tests__`: Chrome refuses to load an unpacked extension that has a root entry starting with `_` (other than `_locales`).

### Translations

All the text lives in `dictionaries/` — one JSON file per language (`en.json`, `es.json`, `ru.json`), a flat list of `"key": "message"` pairs. To change a string, edit it there, in every language.

Messages use [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/) and are read in the code with `t(key, params)` from `lib/translations.js`:

```json
"activeTab": "Active tab: {title}",
"tabs": "{count, plural, one {# tab} other {# tabs}}"
```

```js
t('activeTab', { title: 'Inbox' }); // "Active tab: Inbox"
t('tabs', { count: 5 });            // "5 tabs" — in Russian "5 вкладок" (one / few / many / other)
```

A counted phrase is one plural message that picks its form from the count (`#` is the count), using each language's own plural rules. Tabazing implements the ICU syntax it needs itself (placeholders, `plural`, `selectordinal`, `select`, `number`), so there is no library to bundle.

`_locales/` is generated from the dictionaries and only holds what Chrome itself shows (the extension's name, description, shortcut names and toolbar title). After changing one of those, run:

```sh
npm run i18n
```

The tests fail if `_locales/` and the dictionaries disagree, if a language is missing a key, or if the code uses a key no dictionary has.

### Release workflow

See `CLAUDE.md` for the full rules. In short, every finished change is committed and pushed, and each commit:

1. Adds or updates tests, and the affected tests pass.
2. Bumps `"version"` in `manifest.json`: **major** for breaking changes (removed or renamed shortcuts, storage changes without migration, dropped permissions), **minor** for new features, **patch** for fixes, performance, styling, copy and refactors.
3. Adds an entry to [CHANGELOG.md](CHANGELOG.md), following [Keep a Changelog](https://keepachangelog.com).
4. Uses the message format `<type>: <summary>`, then a blank line and `v<version> (<major|minor|patch>)`, where type is `feat`, `fix`, `perf`, `style`, `refactor`, `chore` or `i18n`. Then it is pushed to `origin master`.
