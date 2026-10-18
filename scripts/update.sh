#!/bin/sh
# Vendor the site's zmanim code at the pinned commit (SITE_COMMIT) into vendor/site.
#
#   ./scripts/update.sh            the commit in SITE_COMMIT (after a git pull of this repository)
#   ./scripts/update.sh --latest   move the pin to the site's main branch first
#   ./scripts/update.sh <commit>   move the pin to that commit
#
# Then restart the service: sudo systemctl restart royzmanim-notif
set -eu
cd "$(dirname "$0")/.."
SITE_REPO="https://github.com/Zemaneh-Yosef/royzmanimwebsite"

case "${1:-}" in
	"") ;;
	--latest) git ls-remote "$SITE_REPO" refs/heads/main | cut -f1 > SITE_COMMIT ;;
	*) printf '%s\n' "$1" > SITE_COMMIT ;;
esac
SHA=$(tr -d '[:space:]' < SITE_COMMIT)
case "$SHA" in
	*[!0-9a-f]*|"") echo "SITE_COMMIT must be a full commit hash, got '$SHA'" >&2; exit 1 ;;
esac
[ ${#SHA} -eq 40 ] || { echo "SITE_COMMIT must be a full 40-character commit hash" >&2; exit 1; }

TMP=vendor/site.tmp
rm -rf "$TMP"
mkdir -p vendor
git clone --quiet --filter=blob:none --no-checkout "$SITE_REPO" "$TMP"
git -C "$TMP" sparse-checkout set --no-cone \
	/assets/js/ /assets/libraries/kosherZmanim/ /assets/libraries/n2words.esm.js \
	/assets/libraries/light-pollution-client.js /assets/libraries/temporal-polyfill/ /_data/zmanim.yml
git -C "$TMP" -c advice.detachedHead=false checkout --quiet "$SHA"
# git checks every object against its hash: what is checked out is exactly that commit
[ "$(git -C "$TMP" rev-parse HEAD)" = "$SHA" ] || { echo "checked out the wrong commit" >&2; exit 1; }
[ -f "$TMP/assets/js/core/zmanimCore.js" ] || { echo "commit $SHA has no assets/js/core/zmanimCore.js" >&2; exit 1; }

deno run --quiet --allow-read="$TMP" --allow-write="$TMP" scripts/build-data.ts "$TMP"
echo "$SHA" > "$TMP/COMMIT"
rm -rf "$TMP/.git"

rm -rf vendor/site.old
[ -d vendor/site ] && mv vendor/site vendor/site.old
mv "$TMP" vendor/site
rm -rf vendor/site.old
echo "vendored the site at $SHA"
