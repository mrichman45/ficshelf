#!/usr/bin/env bash
# Publish a new FicShelf release.
#
#   ./release.sh 0.2.0
#
# Sets the version in the three places it lives, commits, tags v0.2.0 and
# pushes. GitHub Actions then builds Windows, Linux and Android and publishes
# a Release with every file attached, in about 15 minutes.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

new="${1:-}"
if [[ ! "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: ./release.sh X.Y.Z   (currently $(node -p "require('./package.json').version"))" >&2
  exit 1
fi
if git rev-parse "v$new" >/dev/null 2>&1; then
  echo "v$new already exists. Pick a higher version." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "You have uncommitted changes. Commit them first, then run this again." >&2
  git status --short >&2
  exit 1
fi

# package.json and tauri.conf.json
for f in package.json src-tauri/tauri.conf.json; do
  node -e '
    const fs = require("fs");
    const [file, v] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.version = v;
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  ' "$f" "$new"
done

# Cargo.toml: only the package's own version, the first one in the file.
sed -i "0,/^version = \".*\"/s//version = \"$new\"/" src-tauri/Cargo.toml

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "FicShelf $new"
git tag "v$new"
git push
git push origin "v$new"

repo=$(git remote get-url origin | sed -E 's#(\.git)?$##; s#.*github.com[:/]##')
echo
echo "Tagged v$new. Building now; the release appears when all three finish:"
echo "  https://github.com/$repo/actions"
echo "  https://github.com/$repo/releases"
