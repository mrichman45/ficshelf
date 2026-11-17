# FicShelf

A local reading library for **EPUB**, **PDF** and **CBZ** files, with an
optional Archive of Our Own fetcher attached.

Everything lives on your own machine. Books you add stay where they are on
disk; works saved from AO3 are downloaded into a folder you choose. Nothing is
uploaded, nothing is served to anyone else, and the app works with no internet
at all apart from the AO3 features.

---

## What it does

**Library** — add individual files or a whole folder, subfolders included.
Covers, titles and series are read out of EPUBs (Calibre and EPUB 3 series
tags) and comics (`ComicInfo.xml`) automatically; comics use their first page
as a cover; PDFs get one the first time you open them.

**Series** — the Library's second tab groups books by series, or by the
folder they were added from when they have none, in reading order.

**Edit details** — right-click a cover (long-press on a phone) to change its
title, author, series and number, or to remove it from the library (the file
itself is never deleted). Your edits survive re-importing the file or
re-downloading the work.

**DRM** — books locked with Adobe or store DRM are recognised when added and
kept in the library with a 🔒. FicShelf cannot open them and does not remove
DRM; tapping one hands it to software licensed for that DRM: the computer's
default reader (Adobe Digital Editions, say) or, on Android, a choice of the
phone's reading apps that support it.

**Reader** — EPUB via epub.js with your place remembered as a CFI, PDF via
pdf.js remembering the page, CBZ as a page-turner reading images straight out
of the archive without extracting anything. Arrow keys turn pages, Escape goes
back.

**Reading comfort** — an **Aa** button in the EPUB reader sets text size and
a serif or sans font; **Settings → Appearance** chooses System, Light, Dark or
Sepia for the app and the page alike.

**Reading like FBReader** — books open full screen; a middle tap brings
the menu over the page (chapters, title, day/night, search, bookmarks, a
chapter-and-page panel with a slider and jump-back). A status line shows
progress, page, time and battery. Swipe the left edge to dim. Text layout
(spacing, alignment, hyphenation), pages or continuous scroll, tap zones
(left/right, top/bottom, mostly forward) and page-turn style are all
settings. Select a word and Look up opens its Wiktionary entry.

**Highlights and notes** — select text in an EPUB to highlight it in one of
four colours or attach a note. The **✎** button lists them; tap one to jump
there. They are kept per book in the library database and removed with it.

**Search AO3** — search by words, or paste a work link or id to save it
directly. Saved searches can be re-run from the sidebar.

**Bookmarks** — once signed in, lists your AO3 Bookmarks and Marked for
Later twenty at a time, marking which are already in your library. **Save**
puts a work in a download queue; nothing downloads until you press **Start**,
and each run saves at most 5, 10 or 20 works, then stops. After a run that
uses its whole allowance, Start is unavailable for a minute. There is no
"save all", on purpose — see below.

**Updates** — re-checks saved AO3 works that are not finished and tells you
which have new chapters, so you can download the newer version.

---

## Building

You need [Rust](https://rustup.rs) and [Node 20+](https://nodejs.org).

### Linux (CachyOS / Arch)

```fish
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
                        appmenu-gtk-module libappindicator-gtk3 librsvg
npm install
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/` as an AppImage and a `.deb`.
For a plain binary, `src-tauri/target/release/ficshelf`.

To run it while working on it: `npm run tauri dev`.

### Windows

Install the [Microsoft C++ Build
Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and
[WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (already
present on Windows 11), then:

```powershell
npm install
npm run tauri build
```

Output lands in `src-tauri\target\release\bundle\` as an `.msi` and an NSIS
`.exe`.

### Android (Galaxy phones and other 64-bit ARM devices)

One-time setup on CachyOS (fish):

```fish
sudo pacman -S --needed jdk17-openjdk
paru -S android-studio
# In Android Studio: More Actions → SDK Manager. Install Android 15 (API 35),
# Build-Tools, NDK (Side by side), Command-line Tools and Platform-Tools.
set -Ux JAVA_HOME /usr/lib/jvm/java-17-openjdk
set -Ux ANDROID_HOME $HOME/Android/Sdk
set -Ux NDK_HOME $ANDROID_HOME/ndk/(ls $ANDROID_HOME/ndk | tail -1)
fish_add_path $ANDROID_HOME/platform-tools
rustup target add aarch64-linux-android
npm install
npm run tauri android init      # once; creates src-tauri/gen/android
python3 scripts/patch-android.py   # adds volume-button page turning
```

Build an APK, then install it on a phone connected over USB:

```fish
npm run tauri android build -- --apk --target aarch64 --debug
adb install -r (find src-tauri/gen/android/app/build/outputs/apk -name '*.apk' | head -1)
```

Or copy the APK to the phone and open it, allowing "Install unknown apps"
for the file manager when Android asks. A debug APK is signed with this
computer's debug key, so later builds from the same computer install over it.

`npm run tauri android dev` runs it live on a connected phone while you work.

What is different on a phone:

- **Your password is not stored.** There is no system keyring for the app to
  use, so you sign in once per launch and nothing is kept.
- **Add files… copies** the chosen files into the app's own storage, because
  Android only lends the app the original. There is no Add folder.
- **Swipe or tap the edges to turn pages**, or use the volume buttons
  (down for next, up for previous; switch off under Settings). Tap the
  middle to hide the toolbar. Long-press a cover to remove it. The back button leaves the
  reader.

### Both at once, without a Windows machine

Push this to a GitHub repository and run the **build** workflow from the
Actions tab. It builds on Ubuntu and Windows in parallel and attaches the
installers as artefacts. Tagging a commit `v0.1.0` runs it automatically.

Cross-compiling Windows binaries from Linux is possible but not worth the
trouble here — the GitHub runner is simpler and gives you a clean machine.

### Google Drive sync (one-time setup)

Sync needs FicShelf registered with Google once, as an OAuth client:

1. At console.cloud.google.com, create a project (e.g. "FicShelf").
2. APIs & Services → Library → **Google Drive API** → Enable.
3. Google Auth Platform → Get started: app name FicShelf, your email,
   audience **External**.
4. Data access → Add scopes → `https://www.googleapis.com/auth/drive.appdata`.
5. Audience → **Publish app**. (Left in Testing, Google signs devices out
   every 7 days.)
6. Clients → Create client → type **TVs and Limited Input devices**. Copy
   the client ID and secret.
7. In this repository: Settings → Secrets and variables → Actions → add
   `FICSHELF_GOOGLE_CLIENT_ID` and `FICSHELF_GOOGLE_CLIENT_SECRET`.

Builds after that have sync. On each device: Settings → Sync between devices
→ Connect Google Drive, then enter the code shown at google.com/device.

### Releases

GitHub Actions builds every platform. To publish a new version:

```fish
./release.sh 0.2.0
```

That sets the version everywhere it lives, commits, tags `v0.2.0` and pushes.
About fifteen minutes later the **Releases** page has the Windows installer,
the three Linux files and the signed Android APK, under headings saying
which is which. Versions must only go up: Android refuses to install an
older version over a newer one.

The Android APK is signed with the key in the repository secrets
`ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD`. Keep a backup of that
key: an APK signed with a different one cannot update the installed app.

---

## How the AO3 part behaves

This matters more than the features, so it is written down rather than assumed.

- **Works are fetched through AO3's own Download link**, the same one you would
  click on the page. The app never assembles a book out of scraped chapter
  HTML.
- **One request at a time, with at least 1.5 seconds between them**, enforced in
  `ao3.rs` by a lock held across the wait *and* the request itself, so a slow
  download can never overlap the next request; the gap is measured from when
  the previous one finished. An update check over forty works therefore takes
  over a minute, by design.
- **If AO3's EPUB download is unavailable** (after its November 2026 outage
  it came back with only HTML downloads switched on), FicShelf fetches AO3's
  own HTML download of the same work, one more paced request, and packages
  it as an EPUB locally. Still AO3's Download link, never scraped chapters.
- **Metadata is read from a work's first page**, not the full-work view, so a
  check never makes AO3 render a whole novel to report a chapter count.
- **The user agent identifies the app honestly**, so AO3 can recognise and
  block it specifically if they ever wish to.
- **Nothing is cached, re-hosted or shared.** Downloads go to your folder and
  no further.
- **Signing in is optional.** Everything public works without an account.

### If you do sign in

Many authors restrict works to registered users, so for some libraries signing
in is the difference between the app being useful and not. How it is handled:

- **The password goes to your operating system's credential store** — KDE
  Wallet or GNOME Keyring on Linux, Credential Manager on Windows — via the
  `keyring` crate. It is never written to the app's database, its settings, or
  any file the app controls.
- **The password is tried before it is stored,** so a typo is never saved.
- **The session cookie lives in memory only,** for as long as the app is
  running. On the next start it signs in again from the keyring.
- **It is sent to AO3 and nowhere else.** There is no server, no telemetry,
  nothing else to send it to.
- **Sign out and forget** deletes the credential from the keyring and throws
  away the session cookie, so nothing afterwards reaches AO3 as you.

Two things worth understanding before you use it:

1. **A stored credential is only as safe as the computer it is on.** The
   keyring is unlocked by your desktop login, so anything running as you can
   ask for it. This is the same trust model as a browser's saved passwords,
   which is to say: fine on your own machine, not fine on a shared one.
2. **Being signed in raises the stakes on rate limiting.** AO3 can ban an
   *account* for scraping, not just an address. The 1.5-second floor exists
   partly for this reason; do not shorten it. It is also why Bookmarks has a
   queue with a per-run cap instead of a "save all" button: hundreds of
   back-to-back downloads from one account is exactly the pattern AO3 blocks
   for. A run stops by itself the moment AO3 says to slow down or the session
   ends. The app never logs the password
   or the cookie.

If you would rather not sign in, download restricted works from the site in
your browser and use **Add files…** — same result, nothing stored.

AO3's Terms of Service FAQ forbids scraping to obtain material for commercial
generative AI, and forbids creating an app that hosts or paywalls AO3 content.
This app does neither, and is built to keep it that way.

If you are reading a lot in one sitting, use the site. This is for keeping
copies of things you already love.

---

## Layout

```
src/                 front end (vanilla JS, no framework)
  main.js            all five screens and the three readers
  style.css
src-tauri/src/
  lib.rs             Tauri commands; the seam between UI and core
  db.rs              SQLite: books, saved searches, settings
  archive.rs         reading inside EPUB and CBZ (both are zips)
  opf.rs             EPUB metadata, hand-rolled and unit tested
  ao3.rs             the paced AO3 client
  ao3_parse.rs       AO3 URLs and numbers, unit tested
  util.rs            file names and natural sort, unit tested
```

`opf.rs`, `ao3_parse.rs` and `util.rs` deliberately use no external crates, so
they can be tested without a network:

```fish
cd src-tauri && cargo test
```

## Known rough edges

- AO3's HTML is scraped with CSS selectors in `ao3.rs`. If AO3 changes its
  markup, search results or chapter counts will come back empty; everything
  else keeps working. Those selectors are kept together at the bottom of that
  file so they are easy to fix.
- EPUB reading position is a CFI, which is tied to that exact file. Re-download
  a work and the position resets.
- The library stores a cover thumbnail per book, so a very large library makes
  a larger database. Thumbnails are whatever size the EPUB shipped.
