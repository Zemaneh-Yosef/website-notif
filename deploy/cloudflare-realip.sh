#!/bin/sh
# Writes /etc/nginx/cloudflare-realip.conf: trust CF-Connecting-IP (the visitor's address) only from Cloudflare's
# own address ranges, so rate limits apply per visitor rather than per Cloudflare server, and a request that
# bypasses Cloudflare can't fake its address. Cloudflare's ranges change now and then: run this again monthly
# (e.g. from /etc/cron.monthly) — it only reloads nginx when the list changed and nginx accepts it.
set -eu
OUT=/etc/nginx/cloudflare-realip.conf
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

{
	echo "# Cloudflare's address ranges, from https://www.cloudflare.com/ips/ — written by cloudflare-realip.sh"
	for list in ips-v4 ips-v6; do
		curl -fsS --max-time 20 "https://www.cloudflare.com/$list" | while read -r range; do
			case "$range" in
				"") ;;
				*[!0-9a-fA-F.:/]*) echo "unexpected line from Cloudflare: $range" >&2; exit 1 ;;
				*/*) echo "set_real_ip_from $range;" ;;
				*) echo "unexpected line from Cloudflare: $range" >&2; exit 1 ;;
			esac
		done
	done
	echo "real_ip_header CF-Connecting-IP;"
} > "$TMP"

[ "$(grep -c '^set_real_ip_from' "$TMP")" -ge 10 ] || { echo "too few ranges from Cloudflare; not changing anything" >&2; exit 1; }

if [ -f "$OUT" ] && cmp -s "$TMP" "$OUT"; then
	echo "unchanged"
	exit 0
fi
[ -f "$OUT" ] && cp "$OUT" "$OUT.previous"
install -m 644 "$TMP" "$OUT"
if nginx -t 2>/dev/null; then
	systemctl reload nginx
	echo "updated and reloaded nginx"
else
	[ -f "$OUT.previous" ] && mv "$OUT.previous" "$OUT"
	echo "nginx refused the new list; kept the previous one" >&2
	exit 1
fi
