#!/usr/bin/env python3
"""Add FicShelf's native Android pieces to the generated Android project.

`tauri android init` writes src-tauri/gen/android fresh, and that folder is
not kept in git, so this runs straight after it (in CI, and by hand for local
Android builds). It adds two things to MainActivity.

Volume-button page turning:

* The web side switches it on while a book is open and off otherwise, through
  a small JavaScript interface, so the buttons keep changing the volume
  everywhere else.
* While it is on, volume down turns to the next page and volume up to the
  previous one, and the key is consumed so the volume does not change.

Add folder: Android only lets an app into a folder the user picks in the
system's own picker, and hands back a tree link rather than a path. The web
side calls `FicShelfAndroid.pickFolder()`; this opens the picker, lists every
EPUB, PDF and CBZ inside (subfolders included) and passes the list back to
`window.__ficshelfFolderPicked`, which imports them one at a time.

Open in another app: DRM-locked books stay in the library but can only be
read by apps licensed for that DRM. `FicShelfAndroid.openExternally(path,
mime)` offers the book to the phone's other reading apps. Android only lets
an app share its private files through a FileProvider, so this also adds one
(FicShelfFileProvider) to the manifest.

Safe to run more than once.
"""

import pathlib
import re
import sys

MARK = "// FicShelf: volume-button page turning"

IMPORTS = [
    "android.content.Intent",
    "android.os.Build",
    "android.os.Environment",
    "android.provider.Settings",
    "android.net.Uri",
    "androidx.core.content.FileProvider",
    "java.io.File",
    "android.provider.DocumentsContract",
    "android.view.KeyEvent",
    "android.webkit.JavascriptInterface",
    "android.webkit.WebView",
    "androidx.activity.result.contract.ActivityResultContracts",
    "org.json.JSONArray",
    "org.json.JSONObject",
]

MEMBERS = f"""
  {MARK}
  private var ficshelfWebView: WebView? = null
  @Volatile private var ficshelfVolumePaging = false

  override fun onWebViewCreate(webView: WebView) {{
    super.onWebViewCreate(webView)
    ficshelfWebView = webView
    // Lets chrome://inspect on a computer connected by USB show the app's
    // console. It only works with USB debugging switched on in the phone's
    // developer options, so it opens nothing to anyone else.
    WebView.setWebContentsDebuggingEnabled(true)
    // Follow the phone's own text-size setting (Settings → Display → Font
    // size), within limits the layout is built for.
    webView.settings.textZoom = (resources.configuration.fontScale * 100f).toInt().coerceIn(85, 130)
    webView.addJavascriptInterface(object {{
      @JavascriptInterface
      fun setVolumePaging(on: Boolean) {{ ficshelfVolumePaging = on }}

      @JavascriptInterface
      fun pickFolder() {{ runOnUiThread {{ ficshelfPickFolder.launch(null) }} }}

      // Read in place: with All files access, books are opened straight
      // from the folder she picks, by path, so nothing is copied.
      @JavascriptInterface
      fun hasAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()

      @JavascriptInterface
      fun requestAllFilesAccess() {{
        runOnUiThread {{
          try {{
            startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
              Uri.parse("package:" + packageName)))
          }} catch (e: Exception) {{
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          }}
        }}
      }}

      @JavascriptInterface
      fun pickFolderPath() {{ runOnUiThread {{ ficshelfPickFolderPath.launch(null) }} }}

      @JavascriptInterface
      fun openExternally(path: String, mime: String): Boolean {{
        return try {{
          val uri = FileProvider.getUriForFile(
            this@MainActivity, packageName + ".ficshelf.files", File(path))
          val view = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          val chooser = Intent.createChooser(view, "Open with")
          runOnUiThread {{ startActivity(chooser) }}
          true
        }} catch (e: Exception) {{
          false
        }}
      }}

      // Podfics play natively (FicShelfAudio), so they keep going with the
      // screen off and get lock-screen and notification controls.
      @JavascriptInterface
      fun audioLoad(path: String, title: String, artist: String): String =
        FicShelfAudio.load(this@MainActivity, path, title, artist)

      @JavascriptInterface
      fun audioLoadUrl(url: String, title: String, artist: String) {{
        FicShelfAudio.loadUrl(this@MainActivity, url, title, artist)
      }}

      @JavascriptInterface
      fun audioPlay() {{ runOnUiThread {{ FicShelfAudio.play() }} }}

      @JavascriptInterface
      fun audioPause() {{ runOnUiThread {{ FicShelfAudio.pause() }} }}

      @JavascriptInterface
      fun audioSeek(seconds: Double) {{ runOnUiThread {{ FicShelfAudio.seek(seconds) }} }}

      @JavascriptInterface
      fun audioRate(rate: Double) {{ runOnUiThread {{ FicShelfAudio.setRate(rate.toFloat()) }} }}

      @JavascriptInterface
      fun audioStop() {{ runOnUiThread {{ FicShelfAudio.stop() }} }}

      @JavascriptInterface
      fun audioState(): String = FicShelfAudio.state()

      @JavascriptInterface
      fun audioSaved(): String = FicShelfAudio.saved(this@MainActivity)
    }}, "FicShelfAndroid")
  }}

  // FicShelf: Add folder, read in place. The picker answers with a tree
  // link; for the phone's own storage and SD cards that names a real
  // folder, which is passed back as a path ("" when it cannot be).
  private val ficshelfPickFolderPath =
    registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) {{ tree ->
      val path = if (tree == null) null else ficshelfTreePath(tree) ?: ""
      val arg = if (path == null) "null" else JSONObject.quote(path)
      ficshelfWebView?.post {{
        ficshelfWebView?.evaluateJavascript(
          "window.__ficshelfFolderPath && window.__ficshelfFolderPath(" + arg + ")", null)
      }}
    }}

  private fun ficshelfTreePath(tree: Uri): String? {{
    return try {{
      val id = DocumentsContract.getTreeDocumentId(tree)
      if (id.startsWith("raw:")) return id.removePrefix("raw:")
      val colon = id.indexOf(':')
      if (colon < 0) return null
      val volume = id.substring(0, colon)
      val rel = id.substring(colon + 1)
      val base = if (volume.equals("primary", ignoreCase = true))
        Environment.getExternalStorageDirectory().absolutePath
      else "/storage/" + volume
      if (rel.isEmpty()) base else base + "/" + rel
    }} catch (e: Exception) {{
      null
    }}
  }}

  // FicShelf: Add folder
  private val ficshelfPickFolder =
    registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) {{ tree ->
      if (tree == null) {{
        ficshelfFolderResult(null)
      }} else {{
        Thread {{
          val out = JSONArray()
          try {{
            val rootId = DocumentsContract.getTreeDocumentId(tree)
            ficshelfListTree(tree, rootId, ficshelfDisplayName(tree, rootId) ?: "", 0, out)
          }} catch (e: Exception) {{
            // Whatever was listed before the failure is still worth importing.
          }}
          ficshelfFolderResult(out.toString())
        }}.start()
      }}
    }}

  private fun ficshelfFolderResult(json: String?) {{
    val arg = if (json == null) "null" else JSONObject.quote(json)
    ficshelfWebView?.post {{
      ficshelfWebView?.evaluateJavascript(
        "window.__ficshelfFolderPicked && window.__ficshelfFolderPicked(" + arg + ")", null)
    }}
  }}

  private fun ficshelfDisplayName(tree: Uri, docId: String): String? {{
    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
      ?.use {{ c -> if (c.moveToFirst()) return c.getString(0) }}
    return null
  }}

  // Books, comics and podfic audio.
  private val ficshelfImportable = setOf(
    "epub", "pdf", "cbz", "zip",
    "mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav")

  private fun ficshelfListTree(tree: Uri, parentId: String, folder: String, depth: Int, out: JSONArray) {{
    if (depth > 8 || out.length() >= 5000) return
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE)
    val dirs = ArrayList<Pair<String, String>>()
    contentResolver.query(children, cols, null, null, null)?.use {{ c ->
      while (c.moveToNext()) {{
        val id = c.getString(0) ?: continue
        val name = c.getString(1) ?: continue
        val mime = c.getString(2) ?: ""
        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {{
          dirs.add(Pair(id, name))
        }} else {{
          val lower = name.lowercase()
          val ext = lower.substringAfterLast('.', "")
          if (ext in ficshelfImportable) {{
            val item = JSONObject()
            item.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
            item.put("name", name)
            item.put("folder", folder)
            out.put(item)
          }}
        }}
      }}
    }}
    for ((id, name) in dirs) ficshelfListTree(tree, id, name, depth + 1, out)
  }}

  private fun isVolumeKey(keyCode: Int) =
    keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {{
    if (ficshelfVolumePaging && isVolumeKey(keyCode)) {{
      val dir = if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) "next" else "prev"
      ficshelfWebView?.evaluateJavascript(
        "window.__ficshelfPage && window.__ficshelfPage('" + dir + "')", null)
      return true
    }}
    return super.onKeyDown(keyCode, event)
  }}

  override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {{
    if (ficshelfVolumePaging && isVolumeKey(keyCode)) return true
    return super.onKeyUp(keyCode, event)
  }}
"""


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "gen" / "android"
    found = list(root.rglob("MainActivity.kt"))
    if len(found) != 1:
        print(f"expected one MainActivity.kt under {root}, found {len(found)}", file=sys.stderr)
        return 1
    path = found[0]
    src = path.read_text()
    if MARK in src:
        print(f"{path} already patched")
        return patch_file_provider(path)

    # Imports go after the package line.
    pkg = re.search(r"^package [\w.]+\s*$", src, re.M)
    if not pkg:
        print("no package line in MainActivity.kt", file=sys.stderr)
        return 1
    missing = [i for i in IMPORTS if f"import {i}" not in src]
    if missing:
        block = "\n" + "\n".join(f"import {i}" for i in missing)
        src = src[: pkg.end()] + "\n" + block + src[pkg.end():]

    # Members go inside the class body, which the template may or may not have.
    cls = re.search(r"class MainActivity\s*:\s*TauriActivity\(\)\s*(\{)?", src)
    if not cls:
        print("could not find `class MainActivity : TauriActivity()`", file=sys.stderr)
        return 1
    if cls.group(1):
        at = cls.end()
        src = src[:at] + MEMBERS + src[at:]
    else:
        at = cls.end()
        src = src[:at].rstrip() + " {" + MEMBERS + "}\n" + src[at:]

    path.write_text(src)
    print(f"patched {path}:\n")
    print(src)
    return patch_file_provider(path)


PROVIDER = """
        <!-- FicShelf: share books with reading apps that can open DRM. -->
        <provider
            android:name=".FicShelfFileProvider"
            android:authorities="${applicationId}.ficshelf.files"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/ficshelf_file_paths" />
        </provider>
"""

PATHS_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- The library lives in the app's private storage; this lets FicShelf hand
     a single book to another app, with permission for that book only. -->
<paths>
    <root-path name="app" path="." />
</paths>
"""


def patch_file_provider(activity: pathlib.Path) -> int:
    # A subclass, so it cannot clash with any FileProvider a plugin declares.
    pkg = re.search(r"^package ([\w.]+)", activity.read_text(), re.M).group(1)
    sub = activity.with_name("FicShelfFileProvider.kt")
    if not sub.exists():
        sub.write_text(
            f"package {pkg}\n\n"
            "import androidx.core.content.FileProvider\n\n"
            "class FicShelfFileProvider : FileProvider()\n"
        )

    main = next(p for p in activity.parents if p.name == "main")
    manifest = main / "AndroidManifest.xml"
    text = manifest.read_text()
    if "FicShelfFileProvider" not in text:
        if "</application>" not in text:
            print("no </application> in AndroidManifest.xml", file=sys.stderr)
            return 1
        text = text.replace("</application>", PROVIDER + "    </application>", 1)
        manifest.write_text(text)
        print(f"added FicShelfFileProvider to {manifest}")

    xml = main / "res" / "xml" / "ficshelf_file_paths.xml"
    xml.parent.mkdir(parents=True, exist_ok=True)
    xml.write_text(PATHS_XML)
    return allow_cleartext(manifest) or patch_audio(activity, manifest)


AUDIO_KT = """package __PKG__

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONObject

/**
 * FicShelf's podfic player: one file at a time through Android's own
 * MediaPlayer, kept alive by a media-playback foreground service so it keeps
 * playing with the screen off or the app in the background, with controls in
 * the notification, on the lock screen and on headphones.
 *
 * The web page drives it through FicShelfAndroid.audio*() and polls
 * audioState() for where it is. The place is also kept in shared
 * preferences on pause, finish and when the app is swiped away, so it is not
 * lost if the page was not running to save it.
 */
object FicShelfAudio {
  private var player: MediaPlayer? = null
  private var app: Context? = null
  private var session: MediaSession? = null
  private var focus: AudioFocusRequest? = null
  private var noisyOn = false
  private var rate = 1f
  @Volatile private var ended = false
  var title = ""
  var artist = ""
  var path = ""

  private val attrs: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  // Headphones unplugged or Bluetooth dropped: pause rather than blare.
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
      if (i.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) pause()
    }
  }

  private val focusChange = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause()
  }

  @Synchronized
  fun load(ctx: Context, p: String, t: String, a: String): String {
    app = ctx.applicationContext
    release()
    preparing = false
    lastError = ""
    return try {
      val mp = MediaPlayer()
      mp.setAudioAttributes(attrs)
      mp.setWakeMode(ctx.applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
      mp.setDataSource(p)
      mp.prepare()
      mp.setOnCompletionListener {
        ended = true
        savePlace()
        update()
      }
      player = mp
      path = p
      title = t
      artist = a
      ended = false
      ensureSession(ctx.applicationContext)
      update()
      ""
    } catch (e: Exception) {
      player = null
      e.message ?: e.toString()
    }
  }

  @Volatile private var preparing = false
  @Volatile private var lastError = ""

  /** Stream from the web (a podfic's player inside a work). Prepares in
   *  the background; state() says when it is ready or what went wrong. */
  @Synchronized
  fun loadUrl(ctx: Context, url: String, t: String, a: String) {
    app = ctx.applicationContext
    release()
    lastError = ""
    preparing = true
    try {
      val mp = MediaPlayer()
      mp.setAudioAttributes(attrs)
      mp.setWakeMode(ctx.applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
      mp.setDataSource(url)
      mp.setOnPreparedListener {
        preparing = false
        update()
      }
      mp.setOnErrorListener { _, what, extra ->
        preparing = false
        lastError = "the stream could not be played (error $what/$extra)"
        true
      }
      mp.setOnCompletionListener {
        ended = true
        savePlace()
        update()
      }
      player = mp
      path = url
      title = t
      artist = a
      ended = false
      ensureSession(ctx.applicationContext)
      mp.prepareAsync()
    } catch (e: Exception) {
      preparing = false
      player = null
      lastError = e.message ?: e.toString()
    }
  }

  @Synchronized
  fun play() {
    if (preparing) return
    val mp = player ?: return
    val ctx = app ?: return
    if (!requestFocus(ctx)) return
    if (ended) {
      mp.seekTo(0)
      ended = false
    }
    mp.start()
    applyRate(mp)
    if (!noisyOn) {
      val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
      if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(noisy, filter, Context.RECEIVER_EXPORTED)
      else ctx.registerReceiver(noisy, filter)
      noisyOn = true
    }
    val svc = Intent(ctx, FicShelfAudioService::class.java)
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc) else ctx.startService(svc)
    update()
  }

  @Synchronized
  fun pause() {
    if (preparing) return
    val mp = player ?: return
    if (mp.isPlaying) mp.pause()
    savePlace()
    update()
  }

  @Synchronized
  fun toggle() {
    if (preparing) return
    val mp = player ?: return
    if (mp.isPlaying) pause() else play()
  }

  @Synchronized
  fun seek(seconds: Double) {
    if (preparing) return
    val mp = player ?: return
    val ms = (seconds * 1000).toLong().coerceIn(0L, mp.duration.toLong().coerceAtLeast(0L))
    mp.seekTo(ms.toInt())
    if (ms < mp.duration) ended = false
    update()
  }

  @Synchronized
  fun skip(seconds: Int) {
    if (preparing) return
    val mp = player ?: return
    seek((mp.currentPosition + seconds * 1000).toDouble() / 1000.0)
  }

  @Synchronized
  fun setRate(r: Float) {
    rate = r.coerceIn(0.5f, 3f)
    if (preparing) return
    val mp = player ?: return
    // Changing speed on a paused player would start it, so a paused one
    // takes the new speed when it next plays.
    if (mp.isPlaying) applyRate(mp)
    update()
  }

  private fun applyRate(mp: MediaPlayer) {
    try {
      mp.playbackParams = mp.playbackParams.setSpeed(rate)
    } catch (e: Exception) {
      // Some files or devices cannot change speed; keep playing at 1x.
    }
  }

  @Synchronized
  fun stop() {
    savePlace()
    release()
    app?.let { it.stopService(Intent(it, FicShelfAudioService::class.java)) }
  }

  private fun release() {
    player?.let {
      try { it.stop() } catch (e: Exception) {}
      it.release()
    }
    player = null
    abandonFocus()
    if (noisyOn) {
      try { app?.unregisterReceiver(noisy) } catch (e: Exception) {}
      noisyOn = false
    }
  }

  @Synchronized
  fun state(): String {
    val o = JSONObject()
    val mp = if (preparing) null else player
    var pos = 0.0
    var dur: Any = JSONObject.NULL
    var playing = false
    try {
      if (mp != null) {
        pos = mp.currentPosition / 1000.0
        if (mp.duration > 0) dur = mp.duration / 1000.0
        playing = mp.isPlaying
      }
    } catch (e: Exception) {
      // A player in its error state answers nothing; report it as stopped.
    }
    o.put("loaded", player != null)
    o.put("preparing", preparing)
    o.put("error", lastError)
    o.put("path", path)
    o.put("pos", pos)
    o.put("dur", dur)
    o.put("playing", playing)
    o.put("ended", ended)
    o.put("rate", rate.toDouble())
    return o.toString()
  }

  fun savePlace() {
    val ctx = app ?: return
    val mp = player ?: return
    if (preparing) return
    val pos = try { if (ended) 0.0 else mp.currentPosition / 1000.0 } catch (e: Exception) { return }
    ctx.getSharedPreferences("ficshelf_audio", Context.MODE_PRIVATE).edit()
      .putString("path", path)
      .putString("pos", pos.toString())
      .putLong("at", System.currentTimeMillis())
      .apply()
  }

  fun saved(ctx: Context): String {
    val prefs = ctx.getSharedPreferences("ficshelf_audio", Context.MODE_PRIVATE)
    val o = JSONObject()
    o.put("path", prefs.getString("path", "") ?: "")
    o.put("pos", (prefs.getString("pos", "0") ?: "0").toDoubleOrNull() ?: 0.0)
    o.put("at", prefs.getLong("at", 0L))
    return o.toString()
  }

  private fun requestFocus(ctx: Context): Boolean {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val granted = if (Build.VERSION.SDK_INT >= 26) {
      val req = focus ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attrs)
        .setOnAudioFocusChangeListener(focusChange)
        .build()
      focus = req
      am.requestAudioFocus(req)
    } else {
      am.requestAudioFocus(focusChange, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    }
    return granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    val am = app?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    if (Build.VERSION.SDK_INT >= 26) {
      focus?.let { am.abandonAudioFocusRequest(it) }
    } else {
      am.abandonAudioFocus(focusChange)
    }
  }

  private fun ensureSession(ctx: Context) {
    if (session != null) return
    val s = MediaSession(ctx, "FicShelf")
    s.setCallback(object : MediaSession.Callback() {
      override fun onPlay() = play()
      override fun onPause() = pause()
      override fun onSeekTo(pos: Long) = seek(pos / 1000.0)
      override fun onRewind() = skip(-15)
      override fun onFastForward() = skip(30)
      override fun onSkipToPrevious() = skip(-15)
      override fun onSkipToNext() = skip(30)
      override fun onStop() = stop()
    })
    s.isActive = true
    session = s
  }

  /** Bring the session, lock screen and notification up to date. */
  fun update() {
    val ctx = app ?: return
    val s = session ?: return
    val mp = if (preparing) null else player
    val playing = try { mp?.isPlaying == true } catch (e: Exception) { false }
    s.setMetadata(MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, try { (mp?.duration ?: 0).toLong() } catch (e: Exception) { 0L })
      .build())
    s.setPlaybackState(PlaybackState.Builder()
      .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO or
        PlaybackState.ACTION_REWIND or PlaybackState.ACTION_FAST_FORWARD or
        PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SKIP_TO_NEXT or
        PlaybackState.ACTION_STOP)
      .setState(
        if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
        try { (mp?.currentPosition ?: 0).toLong() } catch (e: Exception) { 0L },
        if (playing) rate else 0f)
      .build())
    if (FicShelfAudioService.running) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.notify(FicShelfAudioService.ID, notification(ctx))
    }
  }

  fun notification(ctx: Context): Notification {
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Podfic playback", NotificationManager.IMPORTANCE_LOW))
    }
    val playing = try { !preparing && player?.isPlaying == true } catch (e: Exception) { false }
    fun action(icon: Int, label: String, act: String): Notification.Action {
      val i = Intent(ctx, FicShelfAudioService::class.java).setAction(act)
      val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      val pi = if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(ctx, act.hashCode(), i, flags)
        else PendingIntent.getService(ctx, act.hashCode(), i, flags)
      return Notification.Action.Builder(icon, label, pi).build()
    }
    val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
      PendingIntent.getActivity(ctx, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else Notification.Builder(ctx)
    b.setSmallIcon(if (playing) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause)
      .setContentTitle(title.ifEmpty { "Podfic" })
      .setContentText(artist)
      .setOngoing(playing)
      .setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .addAction(action(android.R.drawable.ic_media_rew, "Back 15 seconds", FicShelfAudioService.BACK))
      .addAction(
        if (playing) action(android.R.drawable.ic_media_pause, "Pause", FicShelfAudioService.TOGGLE)
        else action(android.R.drawable.ic_media_play, "Play", FicShelfAudioService.TOGGLE))
      .addAction(action(android.R.drawable.ic_media_ff, "Forward 30 seconds", FicShelfAudioService.FWD))
      .addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "Stop", FicShelfAudioService.STOP))
      .setStyle(Notification.MediaStyle()
        .setMediaSession(session?.sessionToken)
        .setShowActionsInCompactView(0, 1, 2))
    open?.let { b.setContentIntent(it) }
    return b.build()
  }

  const val CHANNEL = "ficshelf_podfic"
}

class FicShelfAudioService : Service() {
  companion object {
    const val ID = 4207
    const val TOGGLE = "ficshelf.audio.TOGGLE"
    const val BACK = "ficshelf.audio.BACK"
    const val FWD = "ficshelf.audio.FWD"
    const val STOP = "ficshelf.audio.STOP"
    @Volatile var running = false
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Android requires a notification straight away once started this way.
    val n = FicShelfAudio.notification(this)
    if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    else startForeground(ID, n)
    running = true
    when (intent?.action) {
      TOGGLE -> FicShelfAudio.toggle()
      BACK -> FicShelfAudio.skip(-15)
      FWD -> FicShelfAudio.skip(30)
      STOP -> {
        FicShelfAudio.pause()
        running = false
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    FicShelfAudio.savePlace()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}
"""

AUDIO_MANIFEST_PERMS = """    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
"""

AUDIO_SERVICE = """
        <!-- FicShelf: podfics keep playing with the screen off. -->
        <service
            android:name=".FicShelfAudioService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />
"""


def patch_audio(activity: pathlib.Path, manifest: pathlib.Path) -> int:
    pkg = re.search(r"^package ([\w.]+)", activity.read_text(), re.M).group(1)
    activity.with_name("FicShelfAudio.kt").write_text(AUDIO_KT.replace("__PKG__", pkg))
    text = manifest.read_text()
    if "FicShelfAudioService" not in text:
        text = text.replace("</application>", AUDIO_SERVICE + "    </application>", 1)
    if "FOREGROUND_SERVICE_MEDIA_PLAYBACK" not in text:
        app = re.search(r"<application\b", text)
        if not app:
            print("no <application> in AndroidManifest.xml", file=sys.stderr)
            return 1
        text = text[: app.start()] + AUDIO_MANIFEST_PERMS.lstrip(" ") + "    " + text[app.start():]
    manifest.write_text(text)
    print(f"added the podfic player to {manifest}")
    return 0


def allow_cleartext(manifest: pathlib.Path) -> int:
    """Let the WebView load plain http:// images and audio.

    Works embed cover art, fanart and podfic players from old personal
    hosts that never moved to https. Release builds of the Tauri template
    turn cleartext off, so the WebView refused them (broken images, a podfic
    player stuck at 0:00) while a desktop browser showed them fine.
    """
    text = manifest.read_text()
    attr = re.search(r'android:usesCleartextTraffic="[^"]*"', text)
    if attr:
        text = text[: attr.start()] + 'android:usesCleartextTraffic="true"' + text[attr.end():]
    else:
        app = re.search(r"<application\b", text)
        if not app:
            print("no <application> in AndroidManifest.xml", file=sys.stderr)
            return 1
        text = text[: app.end()] + '\n        android:usesCleartextTraffic="true"' + text[app.end():]
    manifest.write_text(text)
    print(f"allowed http:// in {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
