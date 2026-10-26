#!/usr/bin/env python3
"""Stamp a version into every local code/data URL so browsers fetch fresh
copies after each update (GitHub Pages lets browsers cache files ~10 min).

Rewrites, in index.html and js/*.js:
  css/style.css, js/main.js                      -> ...?v=VERSION
  from './x.js' / from '../assets/x.json'        -> ...?v=VERSION
  fetch('photos/manifest.json')                  -> ...?v=VERSION
Run before committing changes to the web app:  python3 scripts/stamp_version.py
"""
import datetime
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
version = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now().strftime("%Y%m%d%H%M%S")


def stamp(m):
    return f"{m.group(1)}{m.group(2)}?v={version}{m.group(4)}"


patterns = [
    # ES module specifiers and dynamic imports of local files
    re.compile(r"""((?:from|import\()\s*['"])(\.{1,2}/[^'"?]+\.(js|json))(?:\?v=[^'"]*)?(['"])"""),
    # fetch() of local JSON (not API calls)
    re.compile(r"""(fetch\(\s*['"])((?!/?api/)[^'"?:]+\.(json))(?:\?v=[^'"]*)?(['"])"""),
    # index.html entry points
    re.compile(r"""((?:src|href)=")((?:js|css)/[^"?]+\.(js|css))(?:\?v=[^"]*)?(")"""),
]

changed = []
for path in [ROOT / "index.html", *sorted((ROOT / "js").glob("*.js"))]:
    text = path.read_text()
    new = text
    for pat in patterns:
        new = pat.sub(stamp, new)
    if new != text:
        path.write_text(new)
        changed.append(str(path.relative_to(ROOT)))
print(f"stamped v={version}: {', '.join(changed) or 'no changes'}")
