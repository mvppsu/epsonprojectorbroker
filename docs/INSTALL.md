# Installing on UNRAID

## Before you start

- **Projector menu** (Network → Projector Control): Basic Control **on**, PJLink **on**,
  Notified IP Address **192.168.20.120** (the UNRAID host). Standby Mode must stay at
  *Communication On*.
- **Give the projector a DHCP reservation** for 192.168.20.159 if it doesn't have one,
  so a router reboot can't move it.
- **Turn off anything else that polls the projector.** In particular, remove HA's
  built-in `epson` integration if it's set up: it polls ESC/VP.net directly, which is
  the traffic pattern that hung this projector's network control in testing.
- **Port 4352/udp must be free on the UNRAID host** for the notification listener. If it
  isn't, the broker logs `[notify] disabled` and carries on with polling alone.

## Publishing the image

The GitHub Actions workflow (`.github/workflows/docker-publish.yml`) builds a
multi-arch image and pushes it to `ghcr.io/<owner>/epsonprojectorbroker` on every push to
`main`. As with the McIntosh broker, set the GHCR *package's* visibility to Public once,
under github.com → Packages → epsonprojectorbroker → Package settings, so UNRAID can
pull it without credentials.

To build on the UNRAID box instead, run this from a checkout:

```sh
docker build -f docker/Dockerfile -t epson-broker:latest .
```

Then use `epson-broker:latest` as the repository below.

## Add Container

1. Docker tab → **Add Container** → **Advanced View**.
2. Set these fields:

   | Field | Value |
   |---|---|
   | Name | `epson-broker` |
   | Repository | `ghcr.io/mvppsu/epsonprojectorbroker:latest` |
   | Network Type | `Host` |

3. Add a Path: Container Path `/config`, Host Path `/mnt/user/appdata/epson-broker`,
   Read/Write.
4. Click **Apply**.

**Networking:** Host networking needs no port mappings. The broker listens on tcp/8096
for the API and on udp/4352 for notifications. It accepts notifications only from the
projector's own IP. Bridge networking also works if you publish `8096:8096` and
`4352:4352/udp`.

**The McIntosh broker uses 8095 on the same host;** this one defaults to 8096 so they
don't collide.

## Add Stack (Compose Manager)

Paste `docker/compose.yml` into a new stack. Change the volume to an absolute path, for
example `/mnt/user/appdata/epson-broker:/config`, then run **Compose Up**.

## Verify

Open the container's **Logs**. You should see:

```
[http] listening on :8096
[notify] listening for PJLink notifications on udp/4352
[projector] PJLink reachable
[projector] power off
```

Then:

1. Open `http://192.168.20.120:8096/`. The panel should show the model, the power state
   and the laser hours.
2. **Check that notifications arrive.** Press power on the IR remote. Within about a
   second the broker log should show `notification %2POWR=…`, and the panel should
   change before the next 15 s poll would. If nothing arrives, recheck Notified IP
   Address in the projector menu. Polling still keeps state correct either way.
3. Try `curl -X POST http://192.168.20.120:8096/api/power/on`. Expect `accepted`, then
   about 50 s of `warming`, then `on`.

## Home Assistant

1. Copy `custom_components/epson_projector_broker/` into HA's `config/custom_components/`.
2. Restart Home Assistant. A new integration needs a full restart, not a reload.
3. Go to **Settings → Devices & Services → Add Integration → Epson Projector Broker**.
   Enter host `192.168.20.120`, port `8096`, and the token if you set `http.authToken`.

## Optional: ESC/VP.net reads

Set `escvp.enabled: true` in `broker.yaml` and restart the container. The broker then
reads source, color mode and signal over ESC/VP.net once the projector has been on for
15 s, and every 5 minutes after that. It also allows `{"protocol":"escvp"}` raw commands
on `/api/raw`.

ESC/VP.net is never used during warm-up or shutdown, never at the same time as PJLink,
and never more than once every 30 s.

If ESC/VP.net stops answering, power control isn't affected. The panel shows
"ESC/VP.net: Unavailable". The projector's network-reset menu item, or a firmware
update, has brought it back before.
