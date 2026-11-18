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
    webView.addJavascriptInterface(object {{
      @JavascriptInterface
      fun setVolumePaging(on: Boolean) {{ ficshelfVolumePaging = on }}

      @JavascriptInterface
      fun pickFolder() {{ runOnUiThread {{ ficshelfPickFolder.launch(null) }} }}

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
    }}, "FicShelfAndroid")
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
    return allow_cleartext(manifest)


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
