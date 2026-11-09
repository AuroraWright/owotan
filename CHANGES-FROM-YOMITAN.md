# Changes from upstream Yomitan

This fork (the `safari` branch) is based on Yomitan's `master` at ac1d839f (2026-11-01). It makes three
large changes:

- a new dictionary engine;
- builds for Safari on iOS and macOS;
- features that Safari on iOS needs because it has no AnkiConnect or native messaging host.

Along the way it also fixes some performance and layout problems.

## Dictionary storage: hoshidicts replaces IndexedDB

- **New engine.** [hoshidicts](https://github.com/bee-san/hoshidicts) is a C++ dictionary engine, compiled to
  WebAssembly. It now imports and stores dictionaries in place of the Dexie/IndexedDB database. A dedicated worker
  reads the dictionary files.
  - Chrome, Edge and Firefox store them in the origin private file system (OPFS).
  - Safari stores them as Blobs in IndexedDB, because iOS Safari gives the extension a new origin each launch and
    only IndexedDB and localStorage are carried over.
- **Faster imports.**
  - hoshidicts parses and validates the dictionary banks itself, instead of JavaScript validating them first.
  - Image sizes are read from the file headers for PNG, GIF, JPEG (including EXIF orientation), WebP, BMP and AVIF,
    instead of decoding every image. A dictionary with 15,000 images went from 34 s to 9 s.
  - Chrome and Edge import on up to 8 threads. Their extension pages are cross-origin isolated for this, using
    COEP `credentialless` so that audio from servers without CORP headers still loads. Measured imports:

    | Dictionary | One thread | Threaded |
    |---|---|---|
    | Jitendex | 3.4 s | 1.4 s |
    | 大辞泉 | 8.9 s | 4.4 s |
    | ja.Wikipedia | 13.9 s | 3.4 s |

    Firefox and Safari use the single-threaded build, and each package includes only the build it uses.
- **Less memory.**
  - Imports read the archive on demand instead of holding it in memory. A 558 MB archive used to need about 1.2 GB
    extra at its peak; it now needs about 75 MB.
  - Hash indexes are read through a page cache rather than copied into memory.
  - Lookups tell the file system what they will read, so Safari reads it in a few large reads.
- **Lazy definitions.** Lookups load term definitions only for the rows left after deinflection matching.
- **Removed features.**
  - Searches are exact-match only; prefix and suffix wildcard searches and their options are gone.
  - Dictionary collection backups (the Dexie database export) are gone.
  - The persistent storage setting is gone; it did nothing in any browser.
- **Upstream patch.** Yomitan's changes to hoshidicts are in `dev/hoshidicts/hoshidicts.patch`, applied to a pinned
  upstream commit by `npm run build:hoshidicts`. The patch is proposed upstream as bee-san/hoshidicts#87. The
  record-reading code that is specific to Yomitan is in `dev/hoshidicts/rows.cpp`.

## Safari on iOS and macOS

- **Building.** `npm run build:safari-app` wraps the Safari build in the app that Safari loads extensions from. It
  builds for macOS, the iOS Simulator or iOS devices, and `--ipa` exports an IPA. iOS 18 or later is required.
- **Messaging workarounds.**
  - Safari's `tabs.sendMessage` only reaches content scripts, and on macOS it never reaches tabs that were open when
    the extension started. Popups therefore talk to pages through MessageChannel ports set up in the frame
    handshake, and pages open their own port to the backend.
  - iOS reorders the keys of objects in messages, which scrambled card format fields. Safari messages are now sent as
    JSON strings.
  - Popup ports are kept when a page is restored from the back/forward cache.
  - Extension pages no longer listen for ports from the backend, which Safari never connects to them. Listening made
    Safari offer them the ports that popups open to the backend, and close such a port when an extension page
    answered before the backend, so popups kept reconnecting.
- **Other Safari quirks handled.**
  - Safari runs the content scripts again in the open pages when the extension loads, as when it reloads, and the
    copies that were already running keep working. A new copy now stops when a working one is in the page. Before,
    each copy showed its own popup over the other, so a popup that hides when the cursor leaves it needed two exits.
  - `commands.getAll` from a popup crashes the page, so it is read through the backend.
  - Safari has no usable SharedWorker, so images are drawn through the backend.
  - Missing CSS is worked around:
    - Furigana is kept out of the scan highlight.
    - Monochrome images are drawn on a canvas instead of with a CSS filter.
    - Custom CSS gets `-webkit-` prefixes added and its `summary::marker` rules mapped.
- **Touch on iOS.**
  - Tapping outside the popup hides it.
  - A long press opens the audio and Anki menus, since iOS sends no `contextmenu` event.
  - Looked-up text is selected only after the touch ends, so iOS doesn't open its edit menu.
  - Tapping text in a nested popup focuses its frame, so the selection shows.
- **Audio in Safari.** All popup audio plays through the app extension, so it autoplays without a gesture. On iOS
  the app extension can play in the background, and other audio such as music is lowered while it plays. Audio from
  local network addresses is downloaded by the background page.
- **Local android.db audio on iOS.** A new audio source plays audio from the `android.db` file that the Local Audio
  Server for Yomichan add-on generates. The file is copied into the Yomitan app's folder in the Files app.
- **Returning from suspension.**
  - iOS throttles the extension's background page after Safari is suspended, making lookups take seconds. The
    extension now reloads itself when a page shows again after Safari has been away for 10 s or more.
  - Safari often freezes a page when it leaves for another app before the page learns that it's hidden. The page
    now notices this from a check that runs late, so the extension still reloads.
  - Timeouts for messages between a page and its popups, and for connecting a popup, wait again when they run late
    because the page was frozen, instead of failing as soon as Safari returns.
- **Background page priority on macOS.** Because of a WebKit bug, Safari on macOS runs the background page at a low
  priority: only on the efficiency cores, with its disk reads throttled. Lookups took 1–6 s, and up to 15 s after
  Safari launched or while the Mac was busy. When the background page starts, the extension opens a page of its own
  in a tab that isn't selected and reloads itself. Safari then runs the new background page in that page's process,
  at a normal priority, and the tab closes after about a second. Lookups take about 100 ms.
- **Keeping the background page loaded.** Safari unloads the background page 30 s after the last message to it,
  and pages' heartbeats don't always reach it in time, as Safari delays the timers of pages that aren't shown. It was
  unloaded every few minutes while Safari was in the background, and the next lookup waited for it to load again; on
  macOS a tab also showed for a moment. The background page now posts to a page's port every minute, which keeps it
  loaded while a page has Yomitan.
- **Exports on iOS.** Exported settings and Anki decks go to the share sheet, since Safari on iOS can't download
  files from extension pages.
- **Layout on small screens.**
  - Text keeps its set size, so the page doesn't zoom when a field is focused.
  - Settings rows wrap on screens just over 400 px wide.
  - Long menu items wrap.
- **Platform-specific features.**
  - The clipboard monitor is hidden on iOS and Android.
  - On macOS, the clipboard is read through the app extension.
  - On macOS, the Yomitan API is served by the Yomitan app.

## Anki through AnkiMobile

- **New connection setting.** Safari on iOS can't reach AnkiConnect, so notes can be added by opening AnkiMobile's
  `addnote` link, which returns to the page. AnkiConnect remains the default.
- **Decks and note types.** AnkiMobile passes its decks and note types to the Yomitan app, which gives them to the
  extension.
- **Duplicate checks.** Yomitan can keep a read-only copy of the collection from the sync server that AnkiMobile uses.
  It syncs as Anki does but always aborts, so nothing on the server changes.
  Duplicates are then checked by Anki's rules.
- **Media.** With a sync server login, images and audio are uploaded through a media sync, the way Anki does it.
  Without one, they're sent in the note as data URLs.

## Other additions

- **Forvo audio source.**
  - Uses your own API key; every audio source now has an API key field.
  - Lists speakers from countries where the language is spoken first, best-rated first.
  - Names each pronunciation by the speaker's gender, name and country.
  - Comes before text-to-speech in the default order.
- **MeCab everywhere.** MeCab runs in WebAssembly in every browser, with no native messaging host to install. The
  settings page downloads and imports its dictionaries (ipadic or unidic-mecab-translate). `nativeMessaging` is now
  only needed for the Yomitan API.
- **Settings versioning.** The fork's settings are versioned separately (`options.forkVersion`), so Yomitan's own
  settings updates still apply when they're merged in.

## Performance and fixes that apply to every browser

- Anki duplicate checks render each field marker once per dictionary entry, and dictionary styles are scoped and
  sanitized once instead of per definition and per note. A word with 158 definitions went from 448 renders (2.35 s)
  to 126 renders (0.23 s).
- Anki duplicate checks render only each note's first field, which is all they use, and send only it to the background
  page; the other fields are rendered when the note is added. On iOS this cut the check's message from about 500 KB
  (up to 6.8 MB) to about 10 KB.
- Auto-play audio starts once the first entry is shown, instead of after every entry. The 400 ms delay before it is
  kept only for lookups made by hovering a mouse or pen, so taps and clicks play sooner: on iOS, audio started about
  240 ms after a tap instead of 700 ms.
- Entries after the first are added in batches, instead of waiting after each one, which made long lists 10–30% faster
  on iOS.
- The first entry is drawn before the others are added. The wait after it was shorter than a frame, so the browser drew
  every entry at once: on iOS, the first entry now shows about 180 ms after a tap instead of 230 ms.
- A popup's entries are removed when it is hidden, instead of when the next lookup starts, which spent about 7 ms
  (up to 17 ms) on it on iOS.
- When a lookup adds an entry, only the last entry is restyled; previously the whole list was.
- Collapsible definitions are checked together rather than one at a time, and only once their entry comes within a
  popup's height of the visible part, except for the first entry's, which are checked before it's drawn. Checking them
  made the browser lay out every entry, including those that `content-visibility: auto` would otherwise skip until
  they're scrolled to. On iOS this halved the time to show every entry, from about 200 ms to about 110 ms.
- The popup's custom CSS and dictionary styles are set only when they change. Every lookup set them twice, so the
  browser parsed them twice and restyled the popup, about 14 ms per lookup on iOS with 130 KB of styles.
- The settings page updates its count of enabled dictionaries, the popup preview and the "all dictionaries" select
  once when the dictionary list is made, instead of once per dictionary. With 89 dictionaries, opening the settings page
  made 91 preview lookups and about 300 requests for the options, about 85 MB of messages; it now makes 3 lookups and
  47 requests. As the list is made again after each import, importing dictionaries one after another grew with the
  square of their number: importing 89 made 4,150 preview lookups and 20,518 requests for the options.
- The parts of the settings page that ask for the installed dictionaries at the same time share one request, and the
  Anki field menus ask once instead of once per menu. Opening the settings page made 20 of these requests, 3 MB with 89
  dictionaries; it now makes 4.
- Fixed dictionary list bugs:
  - Overlapping list updates duplicated entries.
  - Dictionaries imported while another settings page was open could end up disabled.
  - The list sometimes stayed on "Deleting dictionary…" after a delete had finished.
- Local audio that isn't allowed to play no longer hangs the audio player.
- A mouse button press is recognized from the button that was pressed, not only from the buttons held when the event
  was made. In Safari on macOS those were usually missing a short press, as from a mouse that sends a side button's
  release with its press, so scanning with mouse3 and detecting it in the settings rarely worked.
- The background page makes a lookup when it starts, except in Firefox for Android, so the dictionaries are already
  loaded for the first lookup on a page. In Chromium this made the first lookup after the browser started about 90 ms
  faster (450 ms to 366 ms). In Safari, whose background page can run at a low priority, loading them had taken 5 s.
- The progress bar for audio that never loads goes away when other audio is played or the popup shows another lookup.
  Previously it stayed until the popup was reloaded. In Safari this happened when a request for audio never got an
  answer, which Safari allows when the background page stops while answering.
- When a popup's options couldn't be set, as when its frame didn't answer in time, the scanner is still set up, and
  the popup is updated again on the next lookup. Previously lookups stopped working in that page or popup until it
  was reloaded; in a popup, this left nested popups broken.
- Custom popup styles are only sent to popups whose frame has connected.
