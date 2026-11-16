#!/usr/bin/env python3
"""Add FicShelf's native Android pieces to the generated Android project.

`tauri android init` writes src-tauri/gen/android fresh, and that folder is
not kept in git, so this runs straight after it (in CI, and by hand for local
Android builds). It adds volume-button page turning to MainActivity:

* The web side switches it on while a book is open and off otherwise, through
  a small JavaScript interface, so the buttons keep changing the volume
  everywhere else.
* While it is on, volume down turns to the next page and volume up to the
  previous one, and the key is consumed so the volume does not change.

Safe to run more than once.
"""

import pathlib
import re
import sys

MARK = "// FicShelf: volume-button page turning"

IMPORTS = [
    "android.view.KeyEvent",
    "android.webkit.JavascriptInterface",
    "android.webkit.WebView",
]

MEMBERS = f"""
  {MARK}
  private var ficshelfWebView: WebView? = null
  @Volatile private var ficshelfVolumePaging = false

  override fun onWebViewCreate(webView: WebView) {{
    super.onWebViewCreate(webView)
    ficshelfWebView = webView
    webView.addJavascriptInterface(object {{
      @JavascriptInterface
      fun setVolumePaging(on: Boolean) {{ ficshelfVolumePaging = on }}
    }}, "FicShelfAndroid")
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
        return 0

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
