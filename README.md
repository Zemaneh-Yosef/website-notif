# website-notif

Sends [Zemaneh Yosef](https://royzmanim.com)'s zeman notifications by Web Push, so they arrive when the site is closed.

The zmanim come from **the site's own code**: `scripts/update.sh` vendors the site's `assets/js/core/` (and what it
imports) at the commit pinned in `SITE_COMMIT`, and the service runs it in Deno. The times, the list, the settings rules
and the wording are the calendar's, not a copy. When the site's zmanim code changes, move the pin (below); an hourly
check logs a warning while the pin is behind.

The running service uses no third-party packages: Web Push (VAPID and RFC 8291 encryption) is written on WebCrypto,
and the database is Deno's built-in SQLite. Deno's permissions limit it to its own files and a fixed list of hosts.

## How it works

- The site sends the browser's push subscription, the place, the settings that change the zemanim, which zemanim to
  notify and how long before, and the display language and time format. It gets back a secret token, needed to change
  or delete the subscription.
- The service plans each subscriber's next 48 hours with the site's code and stores what to send. It plans again
  when they change anything, when their place's forecast is refreshed (every 3 hours), and every 6 hours.
- Every 30 seconds it sends what is due. A notification that can't go out until 2 minutes after its zeman is dropped.
  The notification `tag` is the one the page uses, so when the calendar is open and has already shown it, the
  service worker replaces it silently instead of showing it twice.
- Forecasts come from the refraction server on this machine (`127.0.0.1:8787`) and the weather services the site uses,
  once per place (not per person), and are kept in memory.

## API

| | |
|---|---|
| `GET /v1/key` | the VAPID public key |
| `POST /v1/subscribe` | `{ subscription, location, settings, notifications, display }` → `{ token }` |
| `GET /v1/subscription` | `Authorization: Bearer <token>`: what the server has |
| `PUT /v1/subscription` | `Bearer`: any of the fields above |
| `DELETE /v1/subscription` | `Bearer`: stop and forget |
| `GET /v1/health` | status, the pinned commit, and the drift check |

```jsonc
{
	"subscription": { "endpoint": "https://fcm.googleapis.com/…", "keys": { "p256dh": "…", "auth": "…" } },
	"location": { "lat": 40.7128, "lon": -74.006, "elevation": 10, "timeZone": "America/New_York", "name": "New York" },
	"settings": { "candles": "18" },                              // only the site's ZMANIM_SETTING_KEYS
	"notifications": { "sunset": { "enabled": true, "minutes": 15 } },  // keys from the site's zmanim list
	"display": { "language": "en", "hourCycle": "h12", "seconds": false, "locale": "en-US" }
}
```

## Safeguards

- **Push services only.** A subscription whose endpoint isn't an `https` URL on a known push service (Google, Mozilla,
  Apple, Microsoft) is refused. The service never sends a request to an address a client chose.
- **No client text in notifications.** Clients send zeman keys, numbers and settings from fixed lists; the text comes
  from the site's code. The one exception is the place's name, shortened to 100 characters with control and
  direction characters removed.
- **Checked input.** Unknown settings or zemanim, minutes outside 0–1440, impossible coordinates, unknown time zones
  and bodies over 16 KB are refused.
- **A token per subscription.** 32 random bytes, stored only as a SHA-256 hash.
- **Limits.** Per address: 10 new subscriptions and 120 changes an hour (on top of nginx's limits). At most 40
  notifications per subscription per day, and 50,000 subscriptions in all. All adjustable in the config.
- **Cleanup.** A subscription is removed when its push service says it's gone (404/410), or after 20 refusals in a row.
  Inactive subscriptions are kept by default (`inactiveDays: null`), so someone who never opens the site again keeps
  their notifications.
- **CORS.** Only the site's origins are allowed; a page on another site gets 403.
- **Two sandboxes.** Deno's permissions (`deploy/royzmanim-notif.service`): read only the code, config and key, write
  only the database, reach only listed hosts. systemd's: its own user, read-only system, no home directories, no
  new privileges.

## Setup (Ubuntu, nginx; Deno already installed)

```sh
# 0. Deno where sudo and the service can use it (the installer puts it in ~/.deno/bin, which neither can reach)
sudo install -m 755 "$(command -v deno)" /usr/local/bin/deno
sudo deno --version

# 1. A user and directories
sudo useradd --system --home /var/lib/royzmanim-notif --shell /usr/sbin/nologin royzmanim-notif
sudo mkdir -p /opt/royzmanim-notif /var/lib/royzmanim-notif /etc/royzmanim-notif
sudo chown royzmanim-notif: /var/lib/royzmanim-notif

# 2. The code, and the site's zmanim code at the pinned commit
sudo git clone https://github.com/Zemaneh-Yosef/website-notif /opt/royzmanim-notif
cd /opt/royzmanim-notif
sudo ./scripts/update.sh
sudo DENO_DIR=/var/lib/royzmanim-notif/deno deno cache src/main.ts   # nothing to download; checks it compiles
sudo chown -R royzmanim-notif: /var/lib/royzmanim-notif

# 3. Config and key (the key is the one you generated in /etc/royzmanim-notif)
sudo cp deploy/config.example.json /etc/royzmanim-notif/config.json   # publicKey and contact are already yours
sudo chown root:royzmanim-notif /etc/royzmanim-notif/config.json /etc/royzmanim-notif/vapid_private.pem
sudo chmod 640 /etc/royzmanim-notif/config.json /etc/royzmanim-notif/vapid_private.pem

# 4. The service
sudo cp deploy/royzmanim-notif.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now royzmanim-notif
journalctl -u royzmanim-notif -f        # "listening on 127.0.0.1:8790; zmanim code at …"

# 5. nginx and TLS (DNS: an A record for notifs.royzmanim.com pointing here)
sudo cp deploy/nginx-proxy.conf /etc/nginx/royzmanim-notif-proxy.conf
sudo cp deploy/nginx.conf /etc/nginx/sites-available/notifs.royzmanim.com
sudo ln -s ../sites-available/notifs.royzmanim.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d notifs.royzmanim.com
curl https://notifs.royzmanim.com/v1/health
```

After `deno upgrade` (which only updates `~/.deno/bin`), run step 0 again and restart the service.

## Updating

```sh
cd /opt/royzmanim-notif
sudo git pull                      # this service's own changes, if any
sudo ./scripts/update.sh --latest  # the site's zmanim code: move the pin to the site's main branch
sudo systemctl restart royzmanim-notif
```

`./scripts/update.sh <commit>` pins a specific commit; `./scripts/update.sh` alone re-vendors the commit in
`SITE_COMMIT`. After moving the pin, commit `SITE_COMMIT` here so the repository records which code is running.
`/v1/health` shows the running commit and whether the site's zmanim files changed since (`drift.changedFiles`).

`SITE_COMMIT` currently points at the `zmanim-core` branch of the site (PR #49). Once that PR is merged, run
`./scripts/update.sh --latest`.

## Development

```sh
./scripts/update.sh                 # vendor the site first
deno task test
deno task check
```
