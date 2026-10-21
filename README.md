# Tabazing

**Alt+Tab for Chrome tabs.** Tabazing shows every open tab as a card with a live preview of the page, so you can see where you are going before you get there. Hold Alt and tap Q to flick between tabs, or open it and type to find any tab, a tab you closed earlier, a bookmark or a page from your history. It also stars, notes, snoozes, archives, sleeps, mutes and tidies tabs, one at a time or many at once.

Everything stays on your computer. Previews, notes, stars and settings are stored locally by Chrome; the extension pages are locked down so they cannot make network requests at all, and nothing is sent anywhere.

Current version: **6.0.1** (from `manifest.json`). Available in English, Spanish and Russian.

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

Right after installing, a small card on the page you are on says "Tabazing is ready – Press Alt+Q and keep holding Alt to see your tabs; let go to switch".

**Changing the shortcuts:** go to `chrome://extensions/shortcuts`, or open Tabazing → **Settings** → **Shortcuts**, which shows the key each command has now and a **Change** button that takes you there. If another app or extension already uses Alt+Q, Chrome leaves it unassigned. Tabazing then shows a warning with a button that takes you to that page. On ordinary web pages Alt+Q still works, because the page itself listens for it.

Tabazing does not run in Incognito windows.

---

## Opening Tabazing

| Shortcut | Mac | What it does |
|---|---|---|
| **Alt+Q** | Option+Q | **Hold Alt and press Q** to see your tabs, with the **previous card in the list** selected (the card before the current tab, in the order the cards are shown). From the first card it wraps around to the last. Keep holding Alt and press Q again to go further back. **Let go of Alt to switch** to the selected tab, just like Alt+Tab. |
| **Alt+W** | Option+W | The same, but selects the **next card in the list** (wrapping around from the last card to the first). |
| **Alt+E** | Option+E | Opens Tabazing with the current tab selected and **keeps it open**, so you can search, use the arrow keys or the mouse. |
| **Alt+R** | ⌥R | Opens Tabazing straight into the [command palette](#command-palette): commands, sums, conversions and search in one box. |
| Toolbar icon | Toolbar icon | Opens Tabazing and keeps it open. The first three times, a note reminds you that Alt+Q does this from anywhere. |

While you hold Alt after Alt+Q or Alt+W:

- Press **Q** for the previous card in the list and **W** for the next (both wrap around). Add **Shift** to go the other way.
- **Turn the mouse wheel** to move through the cards. Scrolling a touchpad works too.
- **Tab** and **Shift+Tab** step to the next and previous card too.
- Press **1–9** (Alt is already down, so this is Alt+1–9) to jump straight to that numbered card.
- **Let go of Alt** to switch. If you start typing, move the mouse or let go of Alt without switching, Tabazing stays open as if you had pressed Alt+E. Pressing Alt+Q or Alt+W in an open Tabazing makes it behave like Alt+Tab again.

**Where it appears.** On normal web pages Tabazing opens as an overlay on top of the page. Chrome does not let extensions draw on some pages, such as `chrome://` pages, the New Tab page and the Chrome Web Store. On those, and on pages that block the overlay, it opens in its own small popup window instead. Both versions work the same way. Turn on **Always open in its own window** in Settings to use the popup window everywhere.

**Closing it.** Press **Esc** or switch to another window. Tabazing also closes after you pick a tab. Clicking empty space (the backdrop, the header, between cards) does not close it, so a missed click never loses your place.

**The source.** The GitHub button at the top right, left of ⓘ, opens Tabazing's repository in a new tab.

**All the shortcuts.** The **ⓘ** button at the top right (next to Archive) opens a card that lists every keyboard and mouse shortcut, grouped into opening and switching, moving around, acting on cards, search, the command palette, and what Esc does. It takes the keyboard focus; **Tab** stays inside it, and **Esc**, its **×**, a click outside or ⓘ again closes it. Settings → **Shortcuts** lists the same keys, next to the Chrome shortcuts that open Tabazing.

**A narrow window.** The header wraps cleanly down to about 800 px wide: below 1100 px the media player moves to its own row under the search box, and below 900 px the Settings, New tab and Archive buttons show only their icons. The cards always start right below the header.

**Open when Chrome starts.** Turn this on in Settings and Tabazing shows all your tabs a few seconds after Chrome starts, once your tabs have been restored.

**"Looking for a tab?"** If you often click through tabs one by one (Ctrl+Tab, Ctrl+PgDn), a small note may suggest Alt+Q instead. It appears at most once a day and three times in total. It stops once you are using Tabazing, and **Don't show again** turns it off for good.

**First-run tour.** The first time you open Tabazing, a short tour walks through switching (hold Alt and press Q; let go to switch), moving around, search, the command palette, the buttons on each card (notes among them), snooze and archive, selecting many tabs (every card shows its tick box for that step), sorting, the window list and the media player (when they are on screen) and settings. Use **Next**, **Back** or **Skip**, or the ← → arrow keys. Esc closes it. **Settings → Replay the tour** shows it again.

---

## Feature guide

### Cards and previews

Each open tab is a card that shows the page title, its favicon and a screenshot of the page.

- Chrome only lets extensions screenshot the tab that is currently on screen. Tabazing takes a picture every time you look at a tab, so previews fill in as you use your tabs. A tab you have not looked at since Chrome started shows its icon and "No preview yet".
- Right after Tabazing opens, the previews of the cards that fit on the screen are read first; the others follow a moment later. Until a card's preview arrives it shows just its icon on a plain tile.
- **Pinned tabs come first**, followed by the rest in the order you chose under [Sort](#sort-and-filters). Settings → **Pinned tabs first** turns this off.
- The **first nine cards are numbered**. Press **Alt+number** (⌥+number on a Mac) to switch to that tab.
- Titles get **two lines** on the default-size cards (Settings → **Title lines** → One line keeps them to one; small cards always use one).
- Small tags sit on the top left of the preview (in the List size, compactly in the row):
  - how long ago you last looked at the tab ("3 days ago", for tabs not viewed for a day or more; Settings → **Show "days ago" tags** turns them off)
  - which window it is in (when you view tabs from several windows)
  - **Back from snooze**, for a tab a snooze has just reopened, until you look at it
  - a pin for pinned tabs
- The site name shows next to the title on wide cards that have no tags.
- A speaker in the header marks a tab playing sound (click it to mute or unmute).
- The **☆ star** and **× close** buttons appear at the end of the header while the pointer is on the card (they are for the mouse: the keyboard has Shift+F10 and the keys); while hidden they take no room from the title. A starred page's star stays in view.
- Asleep tabs (unloaded by Chrome to save memory) show a moon with "Asleep".
- Hover a card to see its full title and address. Hovering doesn't select it: the selected card (lifted, what Enter opens) stays where the keyboard put it, and a click switches to the tab.

#### Capture preview / Capture all previews

- **One tab:** a card with no preview has a **Capture preview** button (or press **Alt+P** / Option+P with the card selected). Tabazing shows that tab for a moment, takes its picture and comes back.
- **Many tabs:** when some tabs have no preview, a small **camera button with the count** appears in the toolbar; its tooltip says "N without preview · Capture all" (or "Capture these" when the view is narrowed) and what it does. A small progress window opens, and each tab is shown briefly (up to 100 per run) before you are taken back where you were. Click **Stop** in that window to stop early. Asleep tabs are skipped so they are not woken up.
- Some pages cannot be captured, such as Chrome's own pages and the Web Store. If Chrome's **Site access** for Tabazing is not set to "On all sites", previews cannot be taken; Tabazing says so and offers an **Allow on all sites** button.

#### Big preview

- Press **Space** (with nothing typed in the search box), or **Shift+click** a card's preview, to see it in full size in the middle of the screen.
- In the big preview, **← / →** move to the previous or next card, **Enter** opens that tab, and **Esc**, Space or clicking outside closes it.

### Keyboard reference

On a Mac, "Alt" is the Option key (⌥).

| Key | Windows / Linux | Mac | What it does |
|---|---|---|---|
| Move | ← → ↑ ↓ | ← → ↑ ↓ | Move the selection between cards. With the search list open, ↑ ↓ move through the results. |
| Next / previous | Tab / Shift+Tab, while holding Alt | Tab / Shift+Tab, while holding ⌥ | Step to the next / previous card in the list (wrapping around), like Alt+Tab. Without Alt held, Tab moves the keyboard focus through Tabazing's buttons and fields, as on any page. |
| Card actions | Shift+F10 or the Menu key | Shift+F10 | Open a menu of everything you can do with the selected card: select it, star, copy link, capture, reload, duplicate, put to sleep, mute, pin, snooze, archive, note, bookmark, close. (Right-clicking a card, or its **⋯** button, opens the same menu.) |
| Jump | Alt+1 … Alt+9 | ⌥1 … ⌥9 | Switch to that numbered card. Works at any time, including while still holding Alt after Alt+Q. Plain digits do the same while you are not typing in the search box; there they type, so you can find titles that start with a number. |
| Tick | Ctrl+Space | ⌘Space | Tick or untick the selected card (see [Selecting many tabs](#selecting-many-tabs-and-the-actions-bar)). |
| Tick a range | Shift+← → ↑ ↓ | Shift+← → ↑ ↓ | Tick from the selected card to where the arrow goes, like in a file list; going back shrinks the range. Not while typing in the search box, where they select text. |
| Open | Enter | Enter | Switch to the selected tab, or open the highlighted search result. |
| Address / Google | Shift+Enter | Shift+Enter | Open what you typed as an address, or search Google for it. |
| Big preview | Space | Space | Show the selected card's preview in full size (when nothing is typed). |
| Close tab | Del | ⌘⌫ | Close the selected tab (on a group's tile, all its tabs; Undo brings them back in the group). On a snoozed tab, cancels the snooze. On a "Starred, not open" card, removes the star. On a recently closed one, removes it from the list. |
| Leave group | Esc, or Backspace | Esc, or ⌫ | In a [tab group](#tab-groups), go back to all tabs (Backspace with the search box empty). |
| Undo | Ctrl+Z | ⌘Z | Undo what you last did in Tabazing: reopen closed tabs, or move merged or moved tabs back (when the search box is empty). |
| Star | Alt+S | ⌥S | Star or unstar the selected page. |
| Capture | Alt+P | ⌥P | Take a preview of the selected tab. |
| Search | Ctrl+F | ⌘F | Jump to the search box. Just typing anywhere works too. |
| Windows | Ctrl+← / Ctrl+→ | ⌃← / ⌃→ | Show the previous or next window's tabs, or all windows (when there is more than one window). |
| Back / close | Esc | Esc | In this order: clears the search, leaves the duplicates view, clears the ticks, leaves the tab group, closes Tabazing. |

All of these, and the mouse shortcuts below, are also listed in the **ⓘ** card at the top right.

### Mouse

| Action | Result |
|---|---|
| Click a card | Switch to that tab, or reopen a closed, snoozed or starred page. Always, even while some tabs are ticked. |
| Shift+click a card's preview | Big preview. |
| Ctrl+click (Cmd+click) a card | Tick or untick it. |
| Click the tick box on a card | Tick or untick it. |
| Shift+click a tick box | Tick every tab between the last one you ticked and this one. |
| Right-click a card, or its **⋯** | The card's menu (everything it can do). |
| Middle-click (press the wheel) | Close the tab. |
| Drag a card | Move the tab in the tab strip. Only works when sorted **By order** (see below). |
| Alt + mouse wheel | Step through cards while holding Alt after Alt+Q or Alt+W. |

### Search

Type anywhere and the text goes into the search box, which says what it searches ("Search tabs, history, bookmarks and the archive"). As you type, a dropdown under the box shows **one ranked list** of everything that matches, best match first:

| Icon / source | What it covers |
|---|---|
| Open tab | Your open tabs. A tag shows the window if it is a different one. |
| Recently closed | Tabs and windows closed in the **last 7 days**. |
| Archived | Pages in your [Archive](#archive). |
| Bookmark | Your Chrome bookmarks, with their folder path (unless Settings → Search → **Include bookmarks** is off). |
| History | Pages from your browsing history: the last 90 days, plus Chrome's own history search for older pages (unless Settings → Search → **Include history** is off). |

- An icon at the right of each row shows where the result comes from. If the same page is found in several places, it is listed once, under the most useful source (an open tab comes before its bookmark, for example).
- **Typos are fine.** Words can match at the start of a word, as initials ("pr" finds "Pull request"), anywhere in a word, as letters in order ("gh" finds "GitHub"), or with one wrong, missing, extra or swapped letter (two in long words). Words that contain digits must be typed exactly. Search also looks at the **notes** you wrote on tabs.
- **↑ / ↓** move through the list, **Enter** opens the highlighted row, and a click does the same. Pointing at a row doesn't move the highlight (as with the cards); the same goes for the command palette. Open tabs are switched to. Closed tabs are reopened with their back/forward history when Chrome still has it. Bookmarks and history entries switch to the tab if the page is already open, or open a new tab otherwise. A click elsewhere hides the list (typing brings it back); while it is hidden, Enter opens the selected card instead.
- **Nothing found?** The list offers **Open \<address\>** when what you typed looks like a web address, and **Search Google for "…"**. **Shift+Enter** does this at any time.
- The count in the search box shows how many open and closed tabs matched.
- While searching, the bar at the bottom offers a **Select all N matching tabs** link, so you can act on every match at once (see [Selecting many tabs](#selecting-many-tabs-and-the-actions-bar)).
- The cards behind the dropdown keep their places while you search, but the ones that don't match are dimmed (and a dimmed selected card loses its glow). Press Esc to clear the search.
- With **Include history** or **Include bookmarks** turned off in Settings, Tabazing doesn't read that source at all.

### Command palette

One box for doing things, not just finding tabs, like the command palettes of code editors and Spotlight.

**Opening it.** Press **Alt+R** (⌥R on a Mac) on any page: the palette opens on its own, over the same dimmed backdrop as the switcher, without the switcher behind it. (Chrome keeps a shortcut it has already assigned when Tabazing is updated: if yours still says Ctrl+Shift+Space, change it at `chrome://extensions/shortcuts`.) Inside Tabazing, type **>** as the first character in the search box, or press **Ctrl+K** (⌘K). Like Alt+Q, the shortcut can be changed at `chrome://extensions/shortcuts`; on web pages it works even when Chrome left it unassigned.

A panel opens at the top centre with one box and one list; the switcher behind it is dimmed. As you type, the list mixes, best match first:

- **A quick answer** (a calculator icon): a sum or a conversion, shown big. **Enter** copies the result, **Shift+Enter** (or the copy button on the row) the whole expression, such as `10 km = 6.21371 mi`.
- **Actions**, found by their name and other words for them ("refresh" finds Reload) in your language and in English, so "new tab" works in Spanish and Russian too. Typos are fine, as in the search. An action comes before a search result that matches as well.
- **Search results**: exactly what the search dropdown shows for the same text (open tabs, recently closed, archived, bookmarks, history), with the same icons and pictures.

With nothing typed it lists the most useful actions first, then the ones you ran recently (tagged **Recent**), then all the others. Only what can be done right now is listed (no "Merge windows" with one window, no media controls when nothing plays).

**Keys.** **↑ / ↓** choose, **Enter** runs, **Shift+Enter** runs and stays in the palette (to zoom in a few steps, say), **Esc** goes back to your tabs with the search box as it was, or closes Tabazing when you opened the palette with the shortcut. **Backspace** in the empty box also goes back. The mouse works too.

After an action, Tabazing gives you the page back when the action was about the page or Chrome (reload, zoom, full screen, media, opening Chrome's pages), shows the switcher when the result (or its **Undo**) is there (closing tabs, pinning, theme, sort…), and stays in the palette after copying, with a note.

**Actions**

| Group | Actions |
|---|---|
| Chrome | New tab · New window · New Incognito window · Reopen the last closed tab · Chrome settings · Tabazing in Chrome's extension settings · Extensions · Extension keyboard shortcuts · Chrome history · Downloads · Bookmarks manager · Clear browsing data · Passwords |
| This tab (the one Tabazing was opened over) | Reload · Duplicate · Pin / Unpin · Mute / Unmute · Close tab · Close the other tabs in this window (not pinned ones) · Move this tab to a new window · Zoom in / Zoom out / Reset zoom (Chrome's own steps, 25 % to 500 %) · Full screen / Exit full screen · Copy link · Copy title and link (Markdown) · Bookmark this page |
| Tabazing | Close duplicate tabs · Merge all into this window · Put tabs not used for a week to sleep · Snooze this tab… · Archive this tab · Open the archive · Tabazing settings · Keyboard and mouse shortcuts · Theme: dark / light / match system · Sort by recently used / order / name · Capture all previews · Replay the tour · Media: play, pause, next, previous |

Closing, moving and archiving tabs keep their usual **Undo**.

**Quick answers** (worked out on your computer):

| Type | Examples |
|---|---|
| Sums | `2+2`, `(1 + 2) * 3`, `2^10`, `10 % 3` (remainder), `1,234.5 * 2`, `sqrt(16)`, `abs(-3)`, `round(2.5)`, `floor`, `ceil`, `cbrt`, `ln`, `log`, `sin(30)` (sin, cos and tan use **degrees**), `pi`, `2pi`, `e` |
| Percentages | `15% of 80` = 12, `80 + 15%` = 92, `80 - 15%` = 68 |
| Units | `10 km in mi`, `10km to miles`, `70f in c`, `5 lb kg`, `2 GB in MB`, `1 GiB in MB`, `1.5 h in min`, `100 km/h in mph`, `100 sq ft in m2`, `1 gal in l`; lengths, weights, temperatures, volumes, areas, speeds, data sizes (KB, MB… in 1000s; KiB, MiB… in 1024s; bits as "bit", "Mbit"…) and times. A unit alone converts to its usual counterpart (`10 km` → miles). |
| Number bases | `255 in hex`, `0xff`, `0b1010 in dec`, `hex 255`, `bin 5` |
| Colours | `#ff8800` → `rgb(255, 136, 0)` and `hsl(32, 100%, 50%)`; `rgb(255, 0, 0)` → `#FF0000`; `hsl(…)`; add `in hsl` to choose. The row shows a swatch. |
| Time zones | `time in Tokyo`, `Tokyo time`, `now in UTC`, `3pm London in New York`, `15:30 in Tokyo` (from your time zone), `time in UTC+3`; city names in English, Spanish or Russian, abbreviations like PST or CET, and every time zone Chrome knows (`Europe/Paris`, or just `Paris`) |
| Dates | `days until 2027-01-01`, `days since 2026-01-01`, `days between 2026-01-01 and 2026-12-25`, `2026-10-18 + 30 days`, `today - 1 month` (a month later than Jan 31 is the end of February) |

Numbers show in your language's format; calculations are rounded to 12 significant digits (so `0.1 + 0.2` is 0.3) and conversions to 6. Enter copies plain digits (`1234.5`, no thousands separator), a unit result with its unit, and a date as `YYYY-MM-DD`. A comma alone is the decimal mark (`1,5` = 1.5), except in English, where `1,234` is a thousand.

**Currency** needs today's exchange rates from the internet, and Tabazing never connects to it: typing something like `10 usd in eur` shows one row that says so, instead of a made-up rate.

### Media player

When a tab is playing a video or music, a small player appears in the header, right of the search box and the same height (in a window narrower than 1100 px, on its own row under the search box). It shows the preview of that tab (or its icon), the title of what is playing (and the artist or the site under it), and **Previous**, **Play / Pause** and **Next** buttons. It is hidden while nothing plays, and while you hold Alt after Alt+Q or Alt+W.

- **Play / Pause** works on any video or audio. **Previous** and **Next** work where the site has its own previous / next track buttons (the ones Chrome's own media controls show, as on YouTube, Spotify or SoundCloud); elsewhere they are greyed out.
- The **⌄** button at the end opens **All media in your tabs**: one row per tab that has something to play, in every window, playing first. Each row has its preview, title, site, a moving-bars sign while it plays, and its own **Previous**, **Play / Pause**, **Next** and **Go to tab** buttons. Click a row to show it in the header player; double-click it to play or pause it. **Go to tab** switches to that tab, like picking its card. **Tab** moves through the list, **Esc**, a click outside or the ⌄ again closes it.
- What counts is what Chrome's own media controls list: a video or audio shows up once it has **played with sound**. Media that is there but hasn't played yet, muted autoplay videos (feeds, backgrounds, animated "GIFs", hover previews), videos without sound and sounds shorter than 5 seconds never show. One thing more than Chrome: a site's own player also shows when you watch it **muted or with its volume at 0** (a YouTube video with the sound off), that is, a video the site names for Chrome's media controls that is at least 400×225 on the page. Once it has played, it stays while paused, muted or finished (also when the site stops it to play something in another tab, as YouTube does), until it is taken off the page, the page loads something else, or it has been paused for an hour.
- The rows themselves don't take the keyboard focus or light up: only their buttons do. (The row shown in the header player is still marked for screen readers.)
- Pages that were already open when Tabazing was installed, updated or reloaded get the player at once, including media that played there before; their **Previous** / **Next** work after the page is reloaded (or once the site sets them up again, as YouTube does for every video).
- If a page doesn't respond (some players ignore outside play requests), a message says so and the button goes back.

### Windows

- **Show tabs from all windows** (Settings) lists the tabs of every Chrome window. When it is off, Tabazing shows only the window you opened it in.
- With more than one window shown, a **window list** appears on the left. It starts with **Merge all into this window**, then **All windows**, then each window with a small picture of the tab it is showing and its number of tabs. Click a window, or press **Ctrl+← / Ctrl+→**, to see only that window's tabs. Cards from other windows carry a "Window N" tag.

#### Merge windows

- **Everything into this window:** click **Merge all into this window** at the top of the window list. All the other windows' tabs move into the current window, after the tabs it already has, at once. Pinned tabs stay pinned and the emptied windows close. (When **Show tabs from all windows** is on but the window list isn't shown, the **Open tabs** row has a **Merge N windows into this one** button instead, next to Sort; with that setting off, there is no merge button, since the other windows aren't in view.)
- **One window:** hover a window in the window list and click its **merge** icon to pull just that window's tabs in.
- A message offers **Undo** (or press Ctrl+Z / ⌘Z): every tab goes back to its window and place, and a window the merge closed is made again, behind Tabazing.

### Sort and filters

Sort and the filter chips sit at the right end of the **Open tabs** heading, since they only sort and filter the open tabs (on a narrow window they wrap under it).

**Sort** (the dropdown; your choice is remembered):

| Option | Order |
|---|---|
| **By recently used** (default) | Most recently used first, like Alt+Tab. |
| **By order** | The same order as Chrome's tab strip, current window first. **Drag cards to move tabs**: drop on the left or right half of another card to place the tab before or after it. If you selected several tabs, they all move together. With all windows shown, you can drag a tab into another window. |
| **By name** | Title, A to Z. |

Pinned tabs come first in every order (unless Settings → **Pinned tabs first** is off).

**Filters** (chips next to Sort): pick one at a time, and click it again to turn it off. A chip only appears when some tab matches it. Each chip shows just its icon and how many tabs it applies to; point at it for its name (screen readers hear the name and the count, such as "Pinned: 2").

| Chip | Shows |
|---|---|
| **Starred** | Only starred pages. Starred pages that are not open appear below in a **Starred, not open** section; click one to open it. |
| **Audio** | Tabs that are playing sound or are muted. |
| **Pinned** | Pinned tabs. |
| **Asleep** | Tabs that are unloaded, or marked to sleep. |
| **Notes** | Tabs that have a note. |

### Buttons on each card

Hover a card to show its quick buttons at the top right of the preview (only the mouse can press them; the keyboard has the card's menu, Shift+F10). With the **List** card size, they sit in the card's single row. On a narrow card they wrap rather than run off its edge. Only the most used ones are on the card; **⋯** opens the card's menu with everything else.

| Button | What it does |
|---|---|
| Pin / Unpin | Pins or unpins the tab. (A tab that plays sound has its mute button in the header, the speaker, so pin is the one on the card.) |
| Snooze (clock) | Closes the tab now and reopens it later. See [Snooze](#snooze). |
| Archive (box) | Moves the tab into the archive. See [Archive](#archive). |
| Note | Adds or edits a note. See [Notes](#notes). |
| ⋯ | The card's menu: select, star, copy link, capture preview, reload, duplicate, put to sleep, mute / unmute, pin / unpin, snooze, archive, note, **Bookmark…**, close. Right-clicking the card opens the same menu at the pointer, and Shift+F10 (or the Menu key) on the selected card. |

The card header also has a **☆ star** and an **× close** button.

### Stars

- Click **☆** on a card, or press **Alt+S** (⌥S), to star a page. Click or press again to remove the star.
- Stars belong to the page's address, not to the tab. A starred page stays starred after you close it, and it is kept by Tabazing, not in Chrome's bookmarks.
- The **Starred** chip (a star and a number, at the end of the Open tabs heading) shows how many pages are starred. Click it to see only starred tabs, plus starred pages that are **not open**, which you can reopen with one click. Pressing Del on one of those removes its star.

### Notes

1. Click the **note** button on a card.
2. Type your note (up to 1,000 characters). It is saved as you type. Click outside, press Esc or click the × to close it.
3. To remove a note, click **Clear**, or leave the box empty.

Notes belong to the page's address, so a note stays with the page when you close the tab. A card with a note has a highlighted note button, and hovering it shows the note. Search finds pages by their notes whatever state they are in (open, recently closed, archived, bookmarked or in your history): a result found by its note shows the note under its title, with the words you typed marked; one found some other way that has a note carries a **Note** tag. The **Notes** filter shows every open tab that has one.

### Snooze

Snoozing closes a tab now and has Tabazing reopen it later, in the background, in the window it came from.

1. Click the **clock** button on a card, or select several tabs and choose **More → Snooze…**.
2. Choose when: **In 1 hour**, **In 3 hours**, **This evening** (18:00, offered before 17:00), **Tomorrow morning** (9:00), **Tomorrow evening** (18:00, offered from 17:00 on, instead of this evening) or **Next week** (Monday 9:00). Or **Pick a time…**: a small card with a date and time box opens; choose any time still to come and press **Snooze** (Enter works too). A time that has already passed is refused with a note. Esc or **Cancel** closes it.
3. A message confirms the time and offers **Undo**.

Snoozed tabs appear in a **Snoozed** section below your open tabs, soonest first, each marked "back \<time\>" (Settings → **Show Snoozed** hides the section). Click one to open it now, or press its **×** (or Del) to cancel the snooze without reopening. If a snoozed tab comes due while Chrome is closed, it reopens the next time Chrome starts. A tab a snooze has reopened carries a **Back from snooze** tag until you look at it. Chrome's own pages (such as `chrome://` pages) cannot be snoozed.

### Archive

The archive is for tabs you want to keep but not have open. Archiving a tab saves it as a bookmark in a **"Tabs Archive"** folder under **Other bookmarks**, then closes it.

- **Archive a tab:** click the **box** button on its card, or select several tabs and choose **More → Archive**. A message offers **Undo**, which takes the tabs out of the archive and reopens them where they were.
- **See the archive:** click **Archive** at the top right of Tabazing. The Archive overlay shows every archived tab, newest first, with its preview when one is available and when it was archived.
  - **Open** a page by clicking it, or select it with the arrow keys and press **Enter**. It opens in a new tab and is **taken out of the archive**.
  - **Remove** a page without opening it with the **×** on its card, or **Del** (⌘⌫). Undo is offered.
  - Close the archive with **Esc** or the red ×.
- Archived pages also show up in [search](#search) with an Archived icon.
- Because the archive is a normal bookmarks folder, it **syncs with your Chrome account** like any bookmark and **is kept if you remove Tabazing**. You can also manage it in Chrome's bookmark manager.

### History

The **clock** button right of Settings opens your Chrome browsing history over the switcher, newest first.

- It shows **50 pages** at a time; **Show 50 more** at the bottom (or **↓** past the last row) adds the next 50.
- Each page is a card with its **preview** when Tabazing has one, and otherwise just the **page's icon**.
- **Open** a page by clicking it, or select it with the arrow keys and press **Enter**: its tab if one is open, otherwise a new tab beside the page you came from.
- **Big preview:** the card's **expand** button, **Shift+click**, or **Space**; **← →** step through the history, **Enter** opens that page, **Esc** goes back to the list.
- **Remove from history:** the card's **trash** button, or **Del** (⌘⌫). This removes every visit to that page from Chrome's history.
- **⋯** (or right-click, or Shift+F10): **Open**, **Open in a new window**, **Open in the background** (Tabazing stays), **Big preview**, **Copy link**, **Star**, **Note**, **Bookmark…**, **Snooze: open it later**, **Archive** and **Remove from history**.
- Close it with **Esc** or its ×.

### Recently closed

- Below your open tabs, a **Recently closed** section shows what you closed in the last few hours (up to 8 items, including up to 2 whole windows). Click one to reopen it. Tabs Chrome still remembers come back with their back/forward history.
- **Show more** under the section (a button, reachable with Tab) shows everything Tabazing knows you closed in the last 7 days, up to 24 items; **Show fewer** goes back.
- Settings → **Show Recently closed** hides the section (search still finds closed tabs).
- **Search reaches further back:** it finds anything closed in the **last 7 days**, using Chrome's own list plus Tabazing's local log of closed tabs.
- Each closed entry has a **trash** button at the end of its header (shown while the mouse is on the card): it takes the entry off the list, as **Remove from list** does (Undo puts it back).
- Each closed tab has its **note** button and **⋯** (or right-click it, or Shift+F10): **Reopen**, **Reopen in a new window**, **Reopen in the background** (Tabazing stays open and the tab joins your open tabs; it opens afresh, so the menu says "without its history" where Reopen would bring that back), **Copy link**, **Star**, **Note**, **Bookmark…**, **Snooze: reopen later**, **Archive** and **Remove from list** (also **Del**; Undo puts it back). A closed window offers Reopen window, Copy links, Bookmark… and Remove from list.

### Tab groups

- Chrome's tab groups show among your cards as one **tile** each, in the group's colour, where the group's first tab would be (sorted by name: where the group's name goes). Its picture is the group's first tabs, as many as it has up to four (one fills the picture, two sit side by side, three are one big and two small, four are two by two), with **+N** for the rest; its header has the group's name (an unnamed group is called by its colour, "Blue group") and how many tabs it has.
- Small pills on the tile say what its tabs are doing: **Current tab** (the tab you're on is in it), how many play sound (or are muted), sleep, have a note or a star, **Collapsed** when it is collapsed in Chrome's tab strip, and its window when all windows are shown.
- A tile works like a card: **click** (or Enter, or its number) opens the group, **Space** or **Shift+click** shows all its tabs' pictures big (Enter there opens it), **Ctrl+click** (⌘-click), its tick box or Ctrl+Space tick all its tabs (some ticked shows a dash), **Del**, its **×** or a middle-click close the group (**Undo** brings the tabs back in a group of the same name and colour), right-click or **⋯** open its menu.
- **Inside a group** Tabazing shows only its tabs, framed in its colour, with the group's name as the heading: everything works there as usual (search lists the group's tabs first), and **New tab** (the header's or the palette's) opens the tab in the group.
- Tabazing **stays inside the group** every time you open it from one of its tabs. You leave with **‹ All tabs**, **Esc** (one level back, as elsewhere; Esc again closes Tabazing), **Backspace** in the empty search box, or the palette's **Leave the tab group**. Opening Tabazing from a tab outside the group (you went elsewhere) also leaves it.
- **Alt+Q / Alt+W** treat a group as one card, its tile: stepping onto it doesn't open it, **letting go of Alt on it does** (instead of switching tabs). Inside a group they step through its tabs, and letting go switches to one, as usual. **Before its first tab** (Alt+Q) or **after its last** (Alt+W) they step out of the group, to the card before or after its tile among all your tabs; that may be another group's tile, which again opens only if you let go of Alt there. Settings → Cards → **Alt+Q / Alt+W go round inside a tab group** makes them wrap at the group's ends instead.
- A tile's **⋯** menu: **Open group**, **Name and colour…**, **Copy links**, **Bookmark…**, **Move group to new window**, **Collapse / Expand in Chrome**, **Put to sleep**, **Mute / Unmute**, **Snooze…**, **Archive**, **Ungroup** (the tabs stay open) and **Close group**.
- A tab's menu has **Add to group…** (the window's groups, or **New group…**, which asks for a name and one of Chrome's colours) and, for a grouped tab, **Remove from group**; ticked tabs get **Add to group…** under **More**. The command palette offers the same for the current tab and its group.
- With **By order**, drag a tile to move the whole group, or drop tabs on a tile to put them in that group.
- Groups stay groups: **Merge windows** and **Move group to new window** move a group as a group, **Move to new window** takes the tabs' group along, and **Undo**, a snoozed tab waking up and a recently closed tab reopened put tabs back in their group. **Close duplicates** keeps the copy that's in a group.
- Filters and the Starred filter narrow tiles to the tabs they let through. Search finds groups by name (Enter opens one) and tags each grouped tab with its group.
- Settings → Cards → **Show tab groups as tiles** (on by default): turn it off to give every tab its own card again, each tagged with its group's name.

### Bookmarks

**Bookmark…** (in a tab's menu, a recently closed tab's, a group tile's, the actions bar's **More** for ticked tabs, and the command palette's **Bookmark this page**) saves pages as Chrome bookmarks in the folder you choose:

- A dialog shows the **name** (for one page) and every bookmarks folder as a tree. Type in **Find a folder…** to narrow it down; ↑ / ↓ choose a folder; **New folder** makes one inside the chosen folder. **Save** (or Enter) saves; Esc or **Cancel** closes it.
- It starts on the folder you saved into last. If the page is already bookmarked, it says where; saving into that same folder only renames the bookmark instead of adding it twice.
- A message confirms where it went and offers **Undo**.

### Undo

Closing tabs in Tabazing (the × button, Del, middle-click, the **Close** action or closing duplicates), merging windows and moving tabs to a new window each show a message with an **Undo** button. **Ctrl+Z** (⌘Z) works too. Because everything can be undone, none of these asks "are you sure?" first.

- **Closed tabs** come back in the same window and position, pinned if they were pinned. A tab Chrome still lists as just closed is restored through Chrome itself, **with its back/forward history**; the window then shows the tab it showed before. Others are opened afresh, in the background.
- **Merged or moved tabs** go back to their windows and places; a window that was closed by the merge is made again, behind Tabazing.
- You can undo several steps in a row, up to the last 20, while Tabazing stays open.
- The message stays while the pointer or the keyboard focus is on it, so its Undo can't disappear under you, and it sits above the actions bar instead of covering it.

### Selecting many tabs and the actions bar

1. Tick tabs with the **tick box** on each card, or **Ctrl+click** (⌘-click) the cards. **Shift+click a tick box** ticks everything from the last one you ticked. From the keyboard, **Ctrl+Space** (⌘Space) ticks the selected card and **Shift+arrows** tick a range from it. A plain click on a card still switches to that tab; the bar reminds you: "Ctrl+click cards to select more". While searching, the **Select all N matching tabs** link selects every match; otherwise **Select all N tabs** selects everything shown.
2. A bar floats at the bottom of the screen with the number selected and these actions:

| Action | What it does |
|---|---|
| **Close** | Closes the selected tabs at once. Undo brings them back, and they appear under Recently closed. |
| **Copy links** | Copies their addresses, one per line. |
| **More → Copy as Markdown** | Copies `- [Title](link)` lines, which paste as clickable titles in Notion, Obsidian, GitHub, Slack or Docs. |
| **More → Move to new window** | Moves them into a window of their own, opened behind Tabazing, which stays open so you can undo it. (In an overlay, with the tab Tabazing is drawn over among them, Tabazing goes along and closes.) |
| **More → Put to sleep** | Marks them to be unloaded. |
| **More → Snooze…** | Snoozes them all until the time you choose. |
| **More → Archive** | Archives them all. |
| **More → Pin / Unpin** | Pins them, or unpins them if they are all pinned already. |
| **More → Mute / Unmute** | Mutes them, or unmutes them if they are all muted already. |

**Clear** (or Esc) deselects everything. When sorted By order, dragging one selected card moves all the selected tabs.

### Duplicates

When the same page is open in more than one tab, the **Open tabs** row shows **N duplicates**, next to Sort. Tabazing compares addresses and ignores the `#…` part and a trailing slash.

1. Click it. Tabazing shows only the duplicated pages, grouped by page. Each card is marked **Stays** or **Closes**. The copy that stays is the pinned one if any, otherwise the one you used most recently.
2. Click **Close N copies**. They close at once; Undo is offered.
3. **Back**, or Esc, leaves the view without closing anything.

### Sleep

Sleeping a tab unloads it from memory. It keeps its place and reloads when you open it.

- Choose **Put to sleep** in a card's menu (⋯, right-click or Shift+F10), or select tabs and choose **More → Put to sleep**. The card is marked "Goes to sleep when you close Tabazing". The tab is unloaded once you close Tabazing, so the switcher stays smooth. Choose **Don't put to sleep** to change your mind.
- Chrome won't unload the tab you are looking at.
- Tabs that Chrome itself unloaded (Memory Saver) are marked **Asleep**. The **Asleep** filter shows both kinds.

### New tab

The **New tab** button in the header opens a new tab in the current window.

### Settings

Click **Settings** (the gear at the top left). Settings opens as a dialog over the dimmed switcher, with its title and a **×** at the top, the categories down the left and the chosen category's settings on the right (they scroll inside on a short window). In a window narrower than about 640 px the categories become a row of tabs above the settings. **↑** / **↓** (and **←** / **→** when they are a row), **Home** and **End** move between the categories; **Tab** goes on into the settings. Tabazing opens Settings on the category you last used. **Esc**, the **×** or a click outside the dialog closes it, and the keyboard focus goes back to the gear. Every change is saved at once; a new language redraws Settings in it straight away.

| Category | Setting | Options |
|---|---|---|
| Appearance | **Language** | Auto (Chrome's language), English, Español, Русский. |
| | **Theme** | Match system (default), Dark, Light. In the light theme the selected card's edge, focus rings and other outlines use a darkened accent so they stay visible. |
| | **Accent colour** | A set of colour swatches, or **Pick any colour**. |
| | **Card size** | Default, Small, List (one line per tab, no screenshot). |
| | **Title lines** | Two lines (default) or one line, on the default-size cards. |
| Cards | **Pinned tabs first** | On (default): pinned tabs lead every sort order. |
| | **Show "days ago" tags** | On (default): the "3 days ago" tags on cards. |
| | **Show Recently closed** | On (default): the Recently closed section below the open tabs. |
| | **Show Snoozed** | On (default): the Snoozed section. |
| | **Show tabs from all windows** | Off: only the window you open Tabazing in. On: every window, with the window list on the left. |
| Search | **Include history** | On (default): search your browsing history. |
| | **Include bookmarks** | On (default): search your bookmarks. |
| Behaviour | **Always open in its own window** | Off (default): over the page you are on when Chrome allows it. On: always in its own popup window. |
| | **Open Tabazing when Chrome starts** | Shows all your tabs, where you left off, a few seconds after Chrome opens. |
| | **Replay the tour** | Shows the first-run tour again. |
| Shortcuts | **Chrome shortcuts** | Previous card (Alt+Q), Next card (Alt+W), Open and stay (Alt+E) and Command palette (Alt+R), each with the key Chrome has for it now, or **Not set** (then the key works only on web pages). Chrome lets you change them only on its own page: **Change**, or **Change in Chrome**, opens `chrome://extensions/shortcuts`. The list reads the keys again when you come back to Tabazing's window. |
| | **Inside Tabazing** | The keys that work inside Tabazing, the same list as the ⓘ card. |

Settings, the sort order and your stars, notes and snoozed tabs are remembered between sessions.

### Messages and errors

Short messages appear at the bottom ("Copied 5 links", "Closed 2 tabs · Undo"); while the actions bar shows, they sit just above it. When Chrome refuses something, the message says what failed ("Couldn't close that tab", "Couldn't move the tabs", "Couldn't pin or unpin the tab", …) instead of a generic error.

### Feedback prompt

After you have used Tabazing for a while, it may ask once "How is Tabazing working for you?". Your answer stays on your computer. The buttons only open a page (a Chrome Web Store review, or a short survey) in a new tab, where you decide what to send. **Don't ask again** stops it.

---

## Privacy and permissions

- **Nothing leaves your computer.** Tabazing's pages run under a content security policy with `connect-src 'none'`, so they cannot contact any server; even their font (Roboto) comes with the extension. The only web pages Tabazing ever opens are the ones you click, such as the review link.
- **What is stored, and for how long** (all in Chrome's local extension storage, on this device):
  - **Page previews** are kept by page address. A preview no open tab uses is deleted **7 days** after it was last captured or used. Storage is capped at 300 previews (plus up to 80 sharp copies for the big preview).
  - **Closed-tabs log:** address, title and icon of tabs you closed (and the name and colour of the tab group each was in), kept **7 days** (up to 200 entries), for search.
  - **Stars, notes and snoozed tabs** (address, title, time, and a snoozed tab's group name and colour) until you remove them.
  - **Settings and sort order**, the first-run, nudge and feedback-prompt counters, and the ids of the last few command-palette actions you ran.
  - **Quick answers** in the command palette are worked out on your computer. Currency conversion isn't offered, because it would need exchange rates from the internet.

  - **Tab usage order**, and the tab group Tabazing is showing, kept only in memory and cleared when Chrome closes.
  - **Recently closed entries you removed from the list** (their address and when), for a month.
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
| `history` | Search your browsing history from the search box, show it in the History view, and remove a page from it when you ask. |
| `tabGroups` | Show your tab groups (their names and colours) as tiles, and keep a tab in its group when Undo reopens it. |

---

## Development

The extension itself has no build step and no runtime dependencies. Load the folder unpacked (see [Installation](#installation)); after editing, click the reload button on Tabazing's card at `chrome://extensions`. Reload the extension after a change to `manifest.json` permissions; Chrome only grants new permissions then.

### Layout

- The root holds `manifest.json`, the service worker (`background.js`), the content scripts (`hotkey.js`, `media-hook.js`, `media-relay.js`) and each page's script (`switcher.js`, `sweep.js`).
- `markup/`: the HTML pages (`switcher.html`, `sweep.html`).
- `styles/`: their stylesheets, in the manner of today's Material UI (neutral surfaces with thin borders and soft shadows, the accent for what is primary or selected, a translucent accent halo for the keyboard focus; menus and small cards drop down from what opened them, `switcher.js` dropFrom), and `styles/fonts/` with Roboto (bundled, SIL Open Font License: extension pages load nothing from the web).
- `utils/`: the shared modules (storage, translations, capture, media…), imported by the scripts above.
- `dictionaries/`: every string, one file per language; `_locales/` is generated from it.
- `icons/` (the PNGs Chrome shows, drawn from `icon.svg` by `npm run icons`: `scripts/icons.js`), `scripts/` (dev tooling), `tests/`.

### Tests

The tests use [Vitest](https://vitest.dev) with jsdom.

```sh
npm install                              # once
npm test                                 # run everything
npx vitest run tests/switcher/archive    # run part of it
npm run test:watch                       # re-run on change
```

- `tests/` mirrors the source: `tests/utils/<module>.test.js`, `tests/background*.test.js`, `tests/switcher/<area>.test.js`, `tests/hotkey.test.js`, `tests/media-hook.test.js`, `tests/media-relay.test.js`, `tests/sweep-page.test.js`.
- `tests/setup/chrome.js` is an in-memory fake of the `chrome.*` APIs, reset before every test. `tests/setup/dom.js` adds what jsdom lacks. `tests/helpers/switcher.js` (`bootSwitcher`) boots the real switcher page.
- `switcher.js` and `background.js` end with an `export { … }` list so tests can reach their functions. Add new top-level functions to it.
- **Tests find elements only by `data-testid`**, never by role, id, class or tag. Every element the extension creates carries one: in HTML as an attribute, in `switcher.js` through `h(tag, cls, text, testid)` (and `button(testid, label, cls, fn)` in dialogs), elsewhere via `el.dataset.testid`. Repeated elements share one test id per kind (`card-tab`, `card-closed`, `dd-row-mark`).
- The folder is `tests/`, not `__tests__`: Chrome refuses to load an unpacked extension that has a root entry starting with `_` (other than `_locales`).

### Translations

All the text lives in `dictionaries/` — one JSON file per language (`en.json`, `es.json`, `ru.json`), a flat list of `"key": "message"` pairs. To change a string, edit it there, in every language.

Messages use [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/) and are read in the code with `t(key, params)` from `utils/translations.js`:

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
