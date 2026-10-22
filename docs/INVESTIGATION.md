# Epson LS11000 broker — investigation

Feasibility study for an `epson-projector-broker` modelled on `mcintoshremotebroker/`:
one Node.js process that owns the projector's control link, keeps authoritative power
state, and shares control with Home Assistant (custom integration over WebSocket) and a
REST API. Written 2026-10-21 from live, read-only probes of the projector at
`192.168.20.159`. No command that changes projector state was sent.

## What's on the network

| Port | Service | Result |
|------|---------|--------|
| 3629/tcp | ESC/VP.net (Epson's native control protocol) | Open, no password, handshake OK |
| 4352/tcp | PJLink | Open, `PJLINK 0` (no authentication) |
| 80/tcp | Epson Web Control | Open; `/cgi-bin/*` returns 401 (digest auth) |

Identity, read live:

- PJLink `INF2` → `EPSON LS11000W`, `NAME` → `EB7EA9D1`
- ESC/VP21 `SNO?` → `XATB3800017`
- `LAMP?` → `599` (laser operating hours; PJLink `LAMP` → `599 0`)
- PJLink `INST` → `32 33` (two digital inputs: HDMI1 and HDMI2)
- PJLink `ERST` → `000000` (no faults)

Power was `PWR=04`, meaning standby with network on. That's the mode the broker needs:
in plain standby (`PWR=00`) the network stack is down and the projector can't be woken
remotely. Make sure the projector's **Standby Mode** menu setting stays at
*Communication On*.

## Protocol: ESC/VP.net + ESC/VP21

1. Open TCP to 3629 and send the 16-byte handshake
   `"ESC/VP.net" 0x10 0x03 0x00 0x00 0x00 0x00` (protocol 1.0, type CONNECT, no headers).
2. The projector echoes the header back with status byte `0x20` (OK). Observed:
   `ESC/VP.net\x10\x03\x00\x00\x20\x00`. If a Web Control password is set later, the
   handshake has to carry a password header, and a missing or wrong password comes back
   as status `0x41`/`0x43`.
3. After the handshake, the link is plain ASCII ESC/VP21. Each request is `CMD?\r` or
   `CMD PARAM\r`. Each reply ends with the `:` prompt: `PWR=04\r:` for a value, `:` alone
   for an accepted set, `ERR\r:` for a rejection.

Framing is much simpler than on the C2700. Every reply ends in `:`, so the driver sends
one command and waits for the next `:`. No reply ever needs to be correlated by name.

### `PWR?` values (the core of "maintain power status")

| Code | Meaning | Broker state |
|------|---------|--------------|
| `00` | Standby, network off | `off` (unreachable once it settles) |
| `01` | Lamp/laser on | `on` |
| `02` | Warming up | `warming` |
| `03` | Cooling down | `cooling` |
| `04` | Standby, network on | `off` |
| `05` | Abnormal standby (fault) | `error` (also read `ERR?`) |
| `09` | A/V standby | `standby_av` |

### Key differences from the C2700

| | McIntosh C2700 (via iTach) | Epson LS11000 (verified live) |
|---|---|---|
| Concurrent clients | Exactly one TCP client | Several allowed. Two simultaneous ESC/VP.net sessions both worked |
| State feedback | Unsolicited push on every change | **Partial push.** Power-state changes arrive unsolicited as `IMEVENT=…` frames on any open session. Other settings have to be polled |
| Framing | `(CMD param)` groups, no reliable delimiter | Every frame ends in `:`. `IMEVENT` frames can land before *or* after a reply in the same TCP read, so split on every `:` and route `IMEVENT` separately |
| Errors | `(ERROR - …)` text | Bare `ERR`. `ERR?` itself returns `ERR`, both in standby and when on |
| Commands while off | Most work | Only `PWR?`, `LAMP?`, `SNO?` answer in standby |
| Transitions | ~15–20 s tube warm-up | Warm-up ~48 s. Shutdown can leave ESC/VP.net unresponsive indefinitely (see "ESC/VP.net hang after power-off") |

Because the projector accepts several sessions, the broker isn't needed to protect a
single connection. It's still worth building for these reasons:

- **One poller and one state owner.** A single broker holds one session open, takes
  `IMEVENT` pushes for power, polls the other settings, and pushes *changes* over
  WebSocket.
- **Transition handling and link health.** The broker has to cope with ESC/VP.net going
  silent during warm-up and shutdown. That includes discarding late replies to commands
  that already timed out; the probe script got knocked one reply out of step by exactly
  that. It also has to fall back to PJLink for power state when ESC/VP.net hangs.
- **Consistent API.** The same `/api/state`, `/api/command` and `/ws` shape as the
  McIntosh broker, so the HA integration, the web panel and Docker/UNRAID deployment
  can all be copied over.

### Alternatives considered

- **Home Assistant's built-in `epson` integration** (the `epson-projector` library)
  already speaks this protocol. It polls from HA, offers only a `media_player`, has no
  REST API for other clients, and is known to lose track of state across
  warm-up/cool-down. It's fine if HA is the only consumer. It doesn't meet the "REST
  API too" requirement.
- **PJLink only** (port 4352, no auth). It's simpler and standard, and it covers power,
  input, mute, errors and hours. It can't reach Epson-specific settings such as color
  mode, laser output, lens memory or HDR. After the power-cycle test, PJLink becomes the
  **power-state source of truth**, with ESC/VP.net used only for settings (see below).
- **Web Control HTTP** sits behind digest auth and isn't a documented API. Skip it.

## Proposed design

Copy the McIntosh skeleton and swap in the transport and driver:

```
epsonprojectorbroker/
  broker/src/
    escvpTransport.js   TCP 3629 + ESC/VP.net handshake, ':'-prompt framing,
                        reconnect with backoff (shape of itachTransport.js)
    epsonDriver.js      serial command queue (one in flight, wait for ':'),
                        adaptive PWR? poller, transition handling, auto power-on
    commands.js         ESC/VP21 vocabulary + value maps (SOURCE, CMODE, …)
    state.js            power (off|warming|on|cooling|standby_av|error|unreachable),
                        source, colorMode, luminance, aspect, mute/freeze,
                        laserHours, errorCode, link{connected,serial,model}
    httpServer.js       same REST + /ws as McIntosh (/healthz, /api/state,
                        /api/command, /api/raw, /api/config)
    web/                small control panel
  custom_components/epson_ls11000/
    media_player (power + source), select (color mode, aspect, laser output),
    switch (A/V mute, freeze), sensor (power state, laser hours, error),
    binary_sensor (link). iot_class local_push over the broker WebSocket.
  docker/                Dockerfile / compose / UNRAID template (bridge networking is fine,
                        there's no Roon/UDP discovery here)
```

Polling and link strategy (revised after the power-cycle test):

- **Power state comes from PJLink** `%1POWR ?` every 5 s in every state, plus
  `IMEVENT` pushes whenever an ESC/VP.net session is up.
- **ESC/VP.net is opened only while the projector is on or warming.** While on, the
  broker polls `SOURCE?`/`CMODE?`/`MUTE?`/`ASPECT?`/`SIGNAL?` in a ~5 s rotation, so
  remote-control changes show up within a few seconds.
- **Per-command timeout ~3 s.** After a timeout, discard the next reply that arrives,
  because it belongs to the timed-out command. Re-handshake after two consecutive
  timeouts.
- Only *changes* go into the state store, so WebSocket clients get diffs, not one
  message per poll.

## Power-cycle results (2026-10-21)

Raw logs: `powercycle-run1.log`, `powercycle-run2.log`. In run 1 the replies are
shifted by one line after the early timeout: each reply printed belongs to the command
on the line above.

### Warm-up

- `PWR ON` is acknowledged immediately (`:`).
- The first `PWR?` after it got **no reply for ~10 s**. After that it reported `PWR=02`.
- `PWR=01` (on) arrived **~48 s** after `PWR ON`, in both runs.

### `IMEVENT` push frames

Format: `IMEVENT=0001 SS WWWWWWWW AAAAAAAA T1 F1`. `SS` tracked power state in a
different numbering from `PWR?`:

| `SS` | Seen when |
|------|-----------|
| `01` | Standby (seen ~1 s after `04` in run 1) |
| `02` | Warming up |
| `03` | On |
| `04` | Shutting down (right after `PWR OFF`) |

The second hex field changed from `00000000` to `00000002` partway through warm-up.
Its meaning is unknown, likely a status bitmask.

### Settings read while on

| Query | Reply | Notes |
|-------|-------|-------|
| `SOURCE?` | `30` | |
| `SOURCELIST?` | `30 HDMI1 A0 HDMI2` | The projector names its own inputs, so the source list can be read rather than hard-coded |
| `SIGNAL?` | `00` | No signal present |
| `CMODE?` | `23` | Color mode code; the name map is still needed |
| `ASPECT?` | `30 30` | Two values |
| `MUTE?` | `OFF` | A/V mute |
| `HDRPQ?` | `08` | |
| `DYNRANGE?` | `00` | |
| `GAMMA?` | `22` | |
| `BRIGHT?` / `CONTRAST?` / `DENSITY?` / `TINT?` | `126` each | |
| `SHARP?` | `60` | |
| `CTEMP?` | `219` | |
| `MCFI?` | `02` | Frame interpolation |
| `IMGPRESET?` | `03` | |
| `LENS?` / `ZOOM?` / `FOCUS?` | `459` / `466` / `556` | |
| `HREVERSE?` / `VREVERSE?` | `OFF` / `OFF` | |
| `LAMP?` / `ONTIME?` | `599` / `599` | Laser hours |
| `VER?` | firmware list incl. `5X011564J6WWV302` | |
| `SNO?` | `XATB3800017` | |

Returned `ERR` (not supported on this model, or not under this name): `LUMINANCE?`,
`LIGHT?`, `LASER?`, `FREEZE?`, `HDRANGE?`, `4KENHANCE?`, `POPLP?`, `PRODUCT?`,
`MSEL?`, `AUDIO?`, `VOL?`, `ERR?`.

I sent no setting changes, only power. Mapping set values (color mode names, laser
output, lens memory) is still to do.

### Power-off behaviour

- **Run 1:** `PWR OFF`, then `PWR ON` one second later. The session stayed alive and
  delivered `IMEVENT 04` then `01` (standby). The `PWR ON` was **accepted**, and the
  projector warmed straight back up. So there's no long lock-out after power-off, and
  a quick off/on really does turn it back on. The broker shouldn't treat `PWR ON`
  during shutdown as something that will fail.
- **Run 2:** `PWR OFF` was acknowledged. From then on ESC/VP.net **stopped answering
  completely**, on the open session and on new connections. TCP connects, but the
  handshake never gets a reply. At the time of writing that has lasted **more than 25
  minutes** (watched until 21:55). Meanwhile:
  - PJLink on 4352 answers instantly: `POWR=0` (standby), `ERST=000000` (no faults).
  - The web UI on port 80 still returns 200.
  - Ping is fine.

### ESC/VP.net hang after power-off

This is the most important finding for the design. Since the projector cannot be
trusted to keep ESC/VP.net up in standby, the broker must:

1. **Use PJLink (port 4352) as the power-state source of truth**, at least in standby.
   It's simple (`%1POWR ?` → `0` off / `1` on / `2` cooling / `3` warming), needs no
   auth on this unit, and kept working while ESC/VP.net was dead.
2. **Send power-on through PJLink (`%1POWR 1`)** if ESC/VP.net isn't answering. Whether
   PJLink power-on works, and whether it brings ESC/VP.net back, is the next thing to
   test.
3. Use ESC/VP.net only for settings while the projector is on. Treat handshake
   timeouts as "ESC/VP.net unavailable", not as "projector unreachable".

### PJLink power test (22:00–22:10)

Raw log: `pjlink-test.log`. Run while ESC/VP.net was still hung from run 2.

- **`%1POWR 1` works.** It replied `OK` immediately. PJLink showed `3` (warming) at
  ~14 s and `1` (on) at ~51 s.
- **`%1POWR 0` works.** It replied `OK`, showed `2` (cooling), then `0` (standby)
  **~8 s** later. The laser has almost no cool-down.
- **PJLink replies `ERR3` ("unavailable time") on and off during transitions**, and
  every ~20–30 s even while on. The broker must treat `ERR3` as "busy, keep the last
  known value", not as a state change or a link failure.
- **Powering on did not bring ESC/VP.net back. It got worse.** It went from accepting
  TCP and ignoring the handshake, to resetting connections (~20 s after power-on), to
  **refusing connections on port 3629 entirely** (from ~26 s on). It was still refused
  at 22:10, after the projector was back in standby. PJLink (4352) and the web UI (80)
  stayed up throughout.

### What this means

ESC/VP.net on this unit can stop working and stay down across power cycles, while
PJLink keeps working. A rebuilt design:

1. **PJLink is the primary transport** for power on/off and power state, polled every
   ~5 s. Its states map to broker states: `0` off, `1` on, `2` cooling, `3` warming,
   with `ERR3` meaning "hold the last value". PJLink also covers input (`INPT`, `31` =
   HDMI1, `32` = HDMI2 per `INST`), A/V mute (`AVMT`), errors (`ERST`) and hours
   (`LAMP`).
2. **ESC/VP.net is optional and best-effort.** It's used for Epson-only settings
   (color mode, lens, HDR, …) and `IMEVENT` push when it's available. Its failure
   shows up as a degraded-feature flag in state, never as "projector unavailable" in
   Home Assistant.

Still open:

- **How to get ESC/VP.net back.** A mains power cycle (unplug for ~30 s), or a Network
  menu setting being off (check **Network → Network Settings → Control & Notifications**
  / **Command Communication**), are the likely candidates. Once it's back, the
  shutdown sequence that broke it can be re-tested. Run 2's `SOURCE?` straight after
  `PWR OFF` is a suspect.
- Whether PJLink's `ERR3` flicker while on was caused by my simultaneous ESC/VP.net
  connection attempts or happens anyway.

## After firmware update (22:30)

The user updated firmware (main version `…V302` → `…V305`). That brought ESC/VP.net back,
along with these Projector Control menu settings: Basic Control **on**, PJLink **on**,
Notified IP Address **192.168.20.120** (the UNRAID broker host, for PJLink Class 2 UDP
push), AMX and Control4 SDDP **off**. PJLink reports `CLSS=2`. Raw log:
`firmware-retest.log`.

- **While on with the menu closed, every query answered**, including `SOURCE=30`,
  `SOURCELIST=30 HDMI1 A0 HDMI2`, `CMODE=23`, `ASPECT=00 30`, `MUTE=OFF`, `SNO`,
  `VER`, `LAMP`.
- **With the on-screen menu open, most queries return `ERR`** (ESC/VP.net) or `ERR3`
  (PJLink `INPT`/`AVMT`). Only `PWR?`/`LAMP?` and PJLink `POWR` answered. The broker
  must treat these as "busy, keep the last value", not as real values.
- **PJLink input codes differ from ESC/VP.net:** PJLink `INPT=32` was reported while
  ESC/VP.net said `SOURCE=30` (HDMI1). So PJLink `32` = HDMI1 and `33` = HDMI2,
  matching `INST=32 33`.
- **The run 2 hang reproduced on the new firmware.** `PWR OFF` was followed by
  `SOURCE?` on the same session. The session went silent, PJLink showed standby at
  ~18 s, and 5 minutes later a fresh ESC/VP.net connection still accepted TCP but never
  answered the handshake. The firmware update didn't fix this.

So far ESC/VP.net has been seen working in standby only in the original state, before
any network power-off. After every network-initiated power-off it has hung. It's not
yet known whether the query sent straight after `PWR OFF` matters, or whether a
power-off from the IR remote or PJLink behaves differently.

## Gentle PJLink power-on (22:44)

Raw log: `pjlink-gentle-on.log`. Background: the user found reports, on an older Epson
model, of ESC/VP.net crashing under frequent polling or when both protocols are polled
at once.

This run started from the hung state. It powered on with `%1POWR 1` and polled only
PJLink, every 5 s:

- `OK` immediately, then `ERR3`, one PJLink timeout at ~17 s while network services
  restarted, `3` (warming) at ~40 s, and `1` (on) at ~50 s.
- Ten seconds after the projector came on, with PJLink polling stopped, **one
  ESC/VP.net attempt succeeded straight away**: handshake OK, `PWR=01`.

So ESC/VP.net comes back after a PJLink power-on when it isn't hit during warm-up. In
the pre-firmware test it was probed every 5 s in parallel with PJLink every 2 s, and it
ended up refusing connections. That's consistent with the "don't poll hard, don't poll
both at once" reports.

## Gentle PJLink power-off (22:48)

Raw log: `pjlink-gentle-off.log`. This run powered off with `%1POWR 0` and polled only
PJLink: `OK`, then `ERR3`, then `0` (standby) by ~17 s. Fifteen seconds after that,
with PJLink polling stopped, **one ESC/VP.net attempt succeeded** (`PWR=04`).

So a PJLink power-off with no ESC/VP.net traffic leaves ESC/VP.net healthy in standby.
Every hang seen so far followed ESC/VP.net being used during shutdown (runs 2 and 3) or
being probed hard alongside PJLink during warm-up. The broker design follows from that.

## End-to-end through the broker (23:02)

The Docker image ran against the projector (ESC/VP.net disabled) and power-cycled it
over REST:

- `POST /api/power/on` returned `accepted`. The broker reported `warming` at ~21 s and
  `on` at ~54 s, then cleared `pendingPower` automatically.
- `POST /api/power/off` returned `accepted`. The broker reported `off` at ~18 s and
  cleared `pendingPower`.
- **After an accepted command, PJLink keeps reporting the old state, or `ERR3`, for
  ~15–20 s** before showing warming/cooling. The first broker build re-sent the power
  command after 10 s because of this. It now waits a 45 s grace period after an
  accepted command (`powerAcceptGraceSec`) and retries quickly only for deferred or
  undelivered requests.
- `cooling` was never observed through PJLink. On this laser model the shutdown is short
  enough to fall between polls or behind `ERR3`.

## Recommendation

The user's requirement is power on/off and power state; there's one input and settings
rarely change. So:

- **PJLink only, by default.** `%1POWR 1`/`0` for control and `%1POWR ?` for state.
  Gentle polling: every 15 s when stable, every 5 s for up to ~90 s after a command or
  a transition. **PJLink Class 2 UDP notifications** to 192.168.20.120 give near-instant
  updates when the IR remote is used, with polling as the safety net. `ERR3` and the odd
  timeout during transitions keep the last known value.
- **ESC/VP.net off by default.** It's an opt-in setting for occasional reads (color mode
  etc.) or on-demand raw commands. When enabled, it only connects while the projector
  is on and settled. It's never used during warm-up or shutdown and never at the same
  time as PJLink, and it's rate-limited.
- Same broker shape as McIntosh: REST + WebSocket, HA integration (`switch`/`media_player`
  for power, plus a power-state sensor), and a Docker/UNRAID deployment.

## Idle session behaviour

One ESC/VP.net session sat idle in standby (before the power cycle) and answered
`PWR?` at 30 s, 60 s, 120 s and 240 s without being dropped. A persistent connection
works when ESC/VP.net is healthy.

## PJLink notifications on UNRAID (03:26 UTC, 2026-10-22)

The broker was deployed on 192.168.20.120 with the projector's Notified IP Address set
to that host. An IR-remote power-on produced, in the broker log:

```
03:26:14.699 notification %2POWR=1
03:26:18.398 notification %2INPT=32
03:26:23.406 power warming        <- from the confirming poll
```

So `%2POWR=1` arrives as soon as power-on **starts**, ~50 s before the projector is
actually on. The first build applied it literally and briefly reported on → warming → on.
Power notifications are now treated as the start of a transition (`1` → warming,
`0` → cooling), and polling confirms the final state.
