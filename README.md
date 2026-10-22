# epson-projector-broker

A broker that keeps the authoritative power state of an Epson LS11000 projector and
shares power control with Home Assistant, a REST API, and a small web panel. It follows
the same shape as `mcintoshremotebroker`: one container talks to the device, and
everything else talks to the broker.

```
Home Assistant ─┐                                   PJLink  tcp/4352  (control + polling)
REST clients   ─┼─ epson-projector-broker (Docker) ─┤
Web panel      ─┘                                   PJLink  udp/4352  ← class 2 notifications
                                                    ESC/VP.net tcp/3629 (optional, off by default)
                                                          │
                                                   Epson LS11000 (192.168.20.159)
```

## Why PJLink and not Epson's own protocol

Live testing against this projector (written up in `docs/INVESTIGATION.md`) found
that Epson's native ESC/VP.net service **hangs after it is used during shutdown, and
stays hung across power cycles**. It was later seen refusing connections outright after
being probed hard during warm-up. PJLink kept working throughout, and a power-off sent
over PJLink with no ESC/VP.net traffic left ESC/VP.net healthy. So the broker:

- uses **PJLink only** for power on/off and power state, polled gently (every 15 s when
  idle, every 5 s around changes);
- takes the projector's **PJLink class 2 notifications** as a fast path, so a power
  change from the IR remote shows up right away;
- sends everything to the projector through **one serialized queue**, so two protocols
  never talk to it at once;
- keeps **ESC/VP.net disabled by default**. When enabled, it is only used for brief reads
  (source, color mode, signal) once the projector has been on and settled for 15 s, and
  never during a power transition.

A power request is held until the projector confirms it. If the projector is busy
(PJLink `ERR3`), the request is retried; it isn't dropped.

## Status

- Broker validated against the real projector: identity, power state, laser hours,
  fault status, and a full power-on/power-off cycle through the REST API in the
  Docker image.
- 36 unit tests (`node --test`, no hardware required).
- Home Assistant integration installed and working on the live HA instance. It was
  import-checked against a real `homeassistant` install first.
- Deployed on UNRAID (192.168.20.120). PJLink class 2 notifications confirmed: an
  IR-remote power-on produced `%2POWR=1` straight away. That notification marks the
  *start* of warm-up, so the broker treats it as `warming` and lets the next poll confirm.

## Layout

```
broker/               Node.js broker: PJLink client + notification listener, optional
                        ESC/VP.net client, power state machine, REST/WebSocket API, web panel
custom_components/    Home Assistant integration (epson_projector_broker)
docker/                Dockerfile, compose.yml, UNRAID template
docs/                  Investigation write-up and raw protocol captures, install guide
```

## REST API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/power` | `{power, pendingPower, powerSince, connected}` |
| POST | `/api/power/on`, `/api/power/off`, `/api/power/toggle` | 202 with `result`: `accepted`, `deferred` (busy, will retry), `unreachable` (will retry), or `already` |
| POST | `/api/power` | Body `{"on": true}` |
| GET | `/api/state` | Full state: power, input, sources, laser hours, faults, link, ESC/VP.net status |
| POST | `/api/command` | `{"cmd": "power"\|"powerToggle"\|"input"\|"refresh", "value": …}`. `input` takes a name (`"HDMI1"`) or a PJLink code (`"32"`) |
| POST | `/api/raw` | `{"line": "%1POWR ?"}` for PJLink, or `{"protocol": "escvp", "line": "CMODE?"}` (only when ESC/VP.net is enabled and the projector is on and settled) |
| GET | `/api/log` | Recent protocol lines |
| GET/POST | `/api/config` | Secrets are redacted on GET |
| GET | `/healthz` | Always 200 while the broker is healthy; reports projector reachability in the body |
| WS | `/ws` | `state` snapshot on connect, then `patch` diffs. Send `{"type":"command","cmd":"power","value":true}` |

`power` is one of `off`, `warming`, `on`, `cooling` or `unknown`.

If `http.authToken` is set, every POST and every WebSocket command needs
`Authorization: Bearer <token>`. Reads stay open.

```sh
curl -X POST http://192.168.20.120:8096/api/power/on
curl http://192.168.20.120:8096/api/power
```

## Home Assistant

Copy `custom_components/epson_projector_broker/` into Home Assistant's `config/`
folder, restart HA, then go to **Settings → Devices & Services → Add Integration →
Epson Projector Broker** and enter `192.168.20.120`, port `8096`. You get:

- `media_player`: on/off and source;
- `switch`: Power. It shows a request in flight, so it doesn't flip back during the ~50 s
  warm-up;
- `sensor`: Power state (standby, warming up, on, cooling down);
- `sensor`: Laser hours;
- `binary_sensor`: Projector link and Projector fault (from PJLink `ERST`).

The integration has a different domain from HA's built-in `epson` integration, so the
two can't clash. Don't run both: the built-in one polls ESC/VP.net directly.

## Configuration

`broker.yaml` lives in `/config` and is created with defaults on first run:

```yaml
projector: { host: 192.168.20.159 }
pjlink:
  port: 4352
  password: ""            # only if PJLink authentication is turned on
  pollIdleSec: 15
  pollActiveSec: 5         # around changes, and for activeWindowSec afterwards
  activeWindowSec: 90
  infoEveryPolls: 4        # input / laser hours / faults ride along every Nth poll
  failThreshold: 3         # consecutive failed polls before "unreachable"
  powerRetrySec: 10        # retry a deferred (ERR3) power request
  powerAcceptGraceSec: 45  # retry an accepted one only if nothing changed by then
  powerDeadlineSec: 180
notify: { enabled: true, port: 4352 }
escvp: { enabled: false, settleSec: 15, refreshSec: 300, minIntervalSec: 30 }
http: { port: 8096, authToken: "" }
inputs:
  32: { name: HDMI1, enabled: true }
  33: { name: HDMI2, enabled: true }
```

Changes take effect when the container restarts.

### Projector menu settings

Under **Network → Projector Control**:

- **Basic Control:** on.
- **PJLink:** on.
- **Notified IP Address:** the broker host, `192.168.20.120`.
- **AMX** and **Control4 SDDP:** off. They aren't used.

Keep **Standby Mode** at *Communication On*, or the projector can't be woken over the
network.

## Development

```sh
cd broker
npm install
npm test     # 36 tests, no hardware needed
BROKER_CONFIG=../config/broker.yaml npm start
```

Deployment details are in `docs/INSTALL.md`.
