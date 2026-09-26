#!/usr/bin/env bash
# Publishes the built dashboard to the gh-pages branch, which is the source for
# GitHub Pages (Settings -> Pages -> Deploy from a branch -> gh-pages / root).
#
#   npm run publish:pages
#
# Run this after changing anything under src/, index.html or public/. The branch
# only ever contains build output, so it is force-pushed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Building"
npm run build

TMP="$ROOT/.pages-tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
cp -R dist/. "$TMP/"
find "$TMP" -name '*.map' -delete   # sourcemaps are dev-only; keeps the branch small
touch "$TMP/.nojekyll"              # serve files as-is, no Jekyll processing

NAME="$(git -C "$ROOT" config user.name 2>/dev/null || true)"
EMAIL="$(git -C "$ROOT" config user.email 2>/dev/null || true)"
NAME="${NAME:-pages-bot}"
EMAIL="${EMAIL:-pages-bot@users.noreply.github.com}"

cd "$TMP"
git init -q -b gh-pages
git add -A
git -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "Publish built EPFD dashboard"
git push -f "$(git -C "$ROOT" remote get-url origin)" gh-pages

cd "$ROOT"
rm -rf "$TMP"
echo "==> Published. Live in ~1 min at https://psxd.github.io/epfdtool/"
