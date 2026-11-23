# What's new in FicShelf

Each release's section here is shown at the top of its page on GitHub.

## 1.2.1

- **AniList and MyAnimeList sign-in now works** (Settings → AniList and MyAnimeList).

## 1.2.0

Ideas borrowed from Mangayomi, for manga and comics especially.

- **Long-strip (webtoon) mode** for comics: one continuous scroll instead of pages. It turns on by itself for books with very tall pages; switch between Pages, Right-to-left and Long strip in the comic settings.
- **Display settings** in the reader (⋯ → Display): brightness, warmth, black and white, crop white borders off comic pages, keep the screen on, and auto-scroll at a speed you choose.
- **History** (new in the menu): what you read and when, with **reading statistics**: time read this week, month and year, a daily streak, and the books you have spent most time with.
- **Continue reading** row at the top of the Library.
- **Incognito mode** (Library ⋯): nothing you open is added to history, statistics or AniList/MyAnimeList, and sync waits until you turn it off.
- **Shelves**: pin tags as tabs across the top of the Library (Library ⋯ → Shelves…).
- **Book servers** (new in the menu): browse, search and download from Komga, Kavita, Calibre-Web, Calibre's content server or any other OPDS catalogue.
- **AniList and MyAnimeList**: sign in under Settings, link a series with its **Track** button, and your list is updated as you finish volumes.

## 1.1.9

- The series header no longer stays on screen after going back to the list of all series.

## 1.1.8

- The Library remembers **All books / Series**, and the series you had open, after switching apps or restarting.

## 1.1.7

- **Removing several books** (Library ⋯ → Select books → Remove) removes them all at once and says how many went.
- Books you remove from a watched folder are not added back by the next folder check (unless the file changes).

## 1.1.6

- **The bookshelf icon on Android.** Phones showed Tauri's default logo; now they show FicShelf's own, shaped to fit the phone's icon style.

## 1.1.5

- Fixes backups (and AO3 saves, podfic downloads and conversions) failing with "Operation not permitted" in Android's Download and Documents folders, and tidies up the unfinished files they left.

## 1.1.4

- **Check for app updates** in the Library ⋯ menu (it is also under Settings → About FicShelf).

## 1.1.3

- **Rename a series** in one go: open it and tap Rename series, or long-press its cover in the Series view. Every book keeps its number; a name already in use merges the two.
- **Look again** in Find duplicates, to scan once more after merging.

## 1.1.2

- Fixes 1.1.0 and 1.1.1 closing straight away on Android phones.

## 1.1.1

- Withdrawn: still closed on Android.

## 1.1.0

Library tools in the spirit of Calibre:

- **Tags, ratings and read status.** Tag books your own way, give them 1–5
  stars, and mark them unread, reading or finished (Edit details, or Mark
  as finished in the book menu). They sync between devices.
- **Search like Calibre.** The library filter understands `tag:`,
  `author:`, `series:`, `rating:>=4`, `status:unread`, `format:manga` and
  more, with `-` to leave things out. Library ⋯ → Search tips lists them.
- **Edit many books at once.** Library ⋯ → Select books: set the author or
  series (and number them in order), add or remove tags, set the rating or
  status, or remove them, all together.
- **Find duplicates.** Library ⋯ → Find duplicates finds identical files and
  books added twice in different formats; keep one and the others' notes,
  tags and place move to it.
- **Find details online.** From a book's menu: look it up on Google Books
  and Open Library and use the title, author and cover.
- **More formats.** CBR, CB7 and folders of page images read as comics;
  DRM-free MOBI and AZW3 (Kindle) books open in the reader.
- **Convert.** Kindle books to EPUB and comics to CBZ, from the book menu,
  keeping notes and place. The original file is left as it was.
- **Share over Wi-Fi.** Settings → Share over Wi-Fi shows an address and a
  PIN; open it in a browser on another device on the same Wi-Fi to browse
  and download books. Off unless switched on.
- Android 8.0 or newer is now needed.

- **Folders are watched.** Folders added with Add folder (read in place on a
  phone; any folder on a computer) are checked for new books each time
  FicShelf opens, and with the new **Check folders** button in the Library.
  Only new files are opened, so it takes seconds even for a big library.
- Adding a folder again only adds what is new, quickly.
- Settings → Folders FicShelf watches lists them, with Stop watching.

## 1.0.0

The first stable release.

- **Big libraries**: on a phone, Add folder can read books where they are
  (no copies), folders import in the background with progress, and covers
  are kept as thumbnails.
- **New version notices.** FicShelf checks for a newer release once a day
  (one request to GitHub, never to AO3) and offers the download for your
  device. It can be switched off in Settings → About FicShelf.
- **Report a problem** in Settings → About FicShelf opens your email app
  with the error log filled in; nothing is sent until you press Send.
- **About FicShelf**: version, what's new, the privacy policy.
- **A short welcome** on a fresh install.
- **Accessibility**: every symbol-only button has a label for screen
  readers, keyboard focus is visible, and on phones the text follows the
  system font size.
- **Gentle with AO3**: a cooldown when AO3 says slow down or is overloaded,
  at most 30 works saved an hour, and automatic sign-in stops after two
  refused passwords.
- **Safe keeping**: backup and restore, and a weekly automatic backup of
  your reading data.
- **Podfics**: play in the background with lock-screen controls, players
  inside works stream the same way, and every chapter's audio is kept.

## 0.8.1

For big libraries:

- **Read in place** (phone): Add folder can read books straight from the
  folder, with no copies, using Android's All files access. Copying is still
  there for small folders.
- **Folders come in in the background** with a progress bar, instead of
  freezing the app on a big folder.
- **Covers are stored as thumbnails**, so a big comic library does not fill
  the database with full-size pages.

## 0.8.0

The release candidate for 1.0.0: everything in the 1.0.0 list, ready for testing. When 1.0.0 is published, this version will offer it by itself.
