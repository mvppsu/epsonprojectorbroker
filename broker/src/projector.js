"use strict";

const EventEmitter = require("events");
const { valueOf } = require("./escvp");

// PJLink POWR values. PJLink calls 2 "cooling" and 3 "warm-up".
const POWER_STATES = { 0: "off", 1: "on", 2: "cooling", 3: "warming" };

// PJLink ERST is six digits: fan, lamp (laser), temperature, cover, filter, other.
// Each is 0 = ok, 1 = warning, 2 = error.
const ERST_FIELDS = ["fan", "lamp", "temperature", "cover", "filter", "other"];
const ERST_LEVELS = { 0: "ok", 1: "warning", 2: "error" };

const ESCVP_READS = ["SOURCE?", "CMODE?", "SIGNAL?"];

function parseErst(value) {
  if (!/^[0-2]{6}$/.test(value)) return null;
  const out = {};
  ERST_FIELDS.forEach((field, i) => (out[field] = ERST_LEVELS[value[i]]));
  return out;
}

// Owns the projector's power state over PJLink: gentle adaptive polling, class 2 UDP
// notifications as a fast path, and a "desired power" request that is retried until the
// projector confirms it (power-on sent while it is still cooling down, or any command
// answered ERR3 "unavailable time", is retried rather than dropped). ESC/VP.net is an
// optional extra used only for occasional reads while the projector is on and settled.
//
// Emits: "connected", "disconnected", "power" (state), "pendingPower" ("on"|"off"|null),
// "input" (PJLink code), "inputs" (list of codes), "lampHours", "errors" (ERST object),
// "info" (field, value), "escvp" (status patch), "picture" (patch), "log" (message).
class ProjectorDriver extends EventEmitter {
  constructor(opts) {
    super();
    this.pjlink = opts.pjlink;
    this.escvp = opts.escvp || null;
    this.notifier = opts.notifier || null;
    this.now = opts.now || (() => Date.now());

    this.pollIdleMs = opts.pollIdleMs ?? 15000;
    this.pollActiveMs = opts.pollActiveMs ?? 5000;
    this.activeWindowMs = opts.activeWindowMs ?? 90000;
    this.infoEveryPolls = opts.infoEveryPolls ?? 4;
    this.failThreshold = opts.failThreshold ?? 3;
    this.powerRetryMs = opts.powerRetryMs ?? 10000;
    this.powerAcceptGraceMs = opts.powerAcceptGraceMs ?? 45000;
    this.powerDeadlineMs = opts.powerDeadlineMs ?? 180000;
    this.notifyConfirmMs = opts.notifyConfirmMs ?? 1000;

    this.escvpEnabled = !!(opts.escvpEnabled && this.escvp);
    this.escvpSettleMs = opts.escvpSettleMs ?? 15000;
    this.escvpRefreshMs = opts.escvpRefreshMs ?? 300000;
    this.escvpMinIntervalMs = opts.escvpMinIntervalMs ?? 30000;

    this.connected = false;
    this.identified = false;
    this.failures = 0;
    this.power = "unknown";
    this.powerSince = null;
    this.desired = null; // { on, deadline, lastSentAt, accepted }
    this.activeUntil = 0;
    this.pollCount = 0;
    this.pollTimer = null;
    this.polling = false;
    this.stopped = true;
    this.escvpLastAt = 0;
    this.escvpLastReadAt = 0;

    this.on("error", () => {});
  }

  start() {
    this.stopped = false;
    if (this.notifier) {
      this.notifier.on("notify", (n) => this._onNotify(n));
      this.notifier.start();
    }
    this._schedulePoll(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.notifier) this.notifier.stop();
  }

  // ---------- polling ----------

  _isActive() {
    return (
      this.now() < this.activeUntil ||
      this.desired !== null ||
      this.power === "warming" ||
      this.power === "cooling"
    );
  }

  _bumpActive() {
    this.activeUntil = this.now() + this.activeWindowMs;
  }

  _schedulePoll(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.pollTimer);
    const delay = delayMs ?? (this._isActive() ? this.pollActiveMs : this.pollIdleMs);
    this.pollTimer = setTimeout(() => this._poll(), delay);
  }

  async _poll() {
    if (this.stopped) return;
    if (this.polling) return this._schedulePoll();
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
      this._schedulePoll();
    }
  }

  // One poll cycle. Public so tests (and the "refresh" command) can drive it directly.
  async pollOnce() {
    const full = !this.identified || this.pollCount % this.infoEveryPolls === 0;
    this.pollCount += 1;

    const cmds = ["%1POWR ?"];
    if (!this.identified) cmds.push("%1INF1 ?", "%1INF2 ?", "%1NAME ?", "%1CLSS ?", "%1INST ?");
    if (full) cmds.push("%1INPT ?", "%1LAMP ?", "%1ERST ?");

    let replies;
    try {
      replies = await this.pjlink.exec(cmds);
    } catch (err) {
      this._onPollFailure(err);
      return;
    }
    this._onPollSuccess();
    for (const r of replies) this._applyReply(r);
    if (!this.identified && replies.some((r) => r && r.cmd === "INF2" && !r.error)) this.identified = true;

    await this._driveDesiredPower();
    await this._maybeEscvpRead();
  }

  _onPollFailure(err) {
    this.failures += 1;
    this.emit("log", `PJLink poll failed (${this.failures}): ${err.message}`);
    if (this.connected && this.failures >= this.failThreshold) {
      this.connected = false;
      this.emit("disconnected");
    }
  }

  _onPollSuccess() {
    this.failures = 0;
    if (!this.connected) {
      this.connected = true;
      this.emit("connected");
    }
  }

  _applyReply(r) {
    if (!r || !r.cmd) return;
    // ERR3 "unavailable time" shows up routinely around power transitions and while the
    // on-screen menu is open, and intermittently even when idle. It says nothing about
    // the projector's actual state, so the last known value stands.
    if (r.error) return;
    switch (r.cmd) {
      case "POWR":
        if (POWER_STATES[r.value]) this._setPower(POWER_STATES[r.value]);
        break;
      case "INPT":
        this.emit("input", r.value);
        break;
      case "INST":
        this.emit("inputs", r.value.split(/\s+/).filter(Boolean));
        break;
      case "LAMP": {
        const hours = parseInt(r.value.split(/\s+/)[0], 10);
        if (!Number.isNaN(hours)) this.emit("lampHours", hours);
        break;
      }
      case "ERST": {
        const errors = parseErst(r.value);
        if (errors) this.emit("errors", errors);
        break;
      }
      case "INF1":
        this.emit("info", "manufacturer", r.value);
        break;
      case "INF2":
        this.emit("info", "model", r.value);
        break;
      case "NAME":
        this.emit("info", "name", r.value);
        break;
      case "CLSS":
        this.emit("info", "pjlinkClass", r.value);
        break;
      default:
        break;
    }
  }

  _setPower(state) {
    if (state === this.power) return;
    this.power = state;
    this.powerSince = this.now();
    this.emit("power", state);
  }

  // ---------- notifications ----------

  _onNotify({ cmd, value, raw }) {
    this.emit("log", `notification ${raw}`);
    if (cmd === "POWR" && POWER_STATES[value]) this._setPower(POWER_STATES[value]);
    if (cmd === "INPT") this.emit("input", value);
    if (cmd === "ERST") {
      const errors = parseErst(value);
      if (errors) this.emit("errors", errors);
    }
    // LKUP is sent when the projector's network comes up; re-read its identity.
    if (cmd === "LKUP") {
      this.identified = false;
      this.emit("info", "mac", value);
    }
    // A notification is a hint: confirm with a real poll shortly, and poll actively for
    // a while since a change (most likely an IR-remote power press) is under way.
    this._bumpActive();
    this._schedulePoll(this.notifyConfirmMs);
  }

  // ---------- power control ----------

  async setPower(on) {
    this.desired = { on: !!on, deadline: this.now() + this.powerDeadlineMs, lastSentAt: 0, accepted: false };
    this.emit("pendingPower", on ? "on" : "off");
    this._bumpActive();
    let result;
    if (this._reached(on)) {
      result = "already";
      this._clearDesired();
    } else {
      result = await this._sendPower();
    }
    this._schedulePoll(this.pollActiveMs);
    return result;
  }

  _reached(on) {
    return on ? this.power === "on" : this.power === "off";
  }

  _movingToward(on) {
    return on ? this.power === "warming" : this.power === "cooling";
  }

  _clearDesired() {
    this.desired = null;
    this.emit("pendingPower", null);
  }

  // Returns "accepted" | "deferred" (projector busy; will retry) | "unreachable".
  async _sendPower() {
    const d = this.desired;
    d.lastSentAt = this.now();
    let reply;
    try {
      [reply] = await this.pjlink.exec([`%1POWR ${d.on ? 1 : 0}`]);
    } catch (err) {
      this.emit("log", `power ${d.on ? "on" : "off"} not delivered: ${err.message}; will retry`);
      return "unreachable";
    }
    d.accepted = !!(reply && reply.value === "OK");
    if (d.accepted) {
      this.emit("log", `power ${d.on ? "on" : "off"} accepted`);
      return "accepted";
    }
    if (reply && reply.value === "ERR4") {
      this.emit("log", "power command refused: projector failure (ERR4)");
      this._clearDesired();
      const err = new Error("Projector reports a failure (ERR4)");
      err.code = "projector_failure";
      throw err;
    }
    this.emit("log", `power ${d.on ? "on" : "off"} deferred (${reply ? reply.value : "no reply"}); will retry`);
    return "deferred";
  }

  async _driveDesiredPower() {
    const d = this.desired;
    if (!d) return;
    if (this._reached(d.on)) {
      this.emit("log", `power ${d.on ? "on" : "off"} confirmed`);
      return this._clearDesired();
    }
    if (this.now() > d.deadline) {
      this.emit("log", `power ${d.on ? "on" : "off"} request gave up after ${this.powerDeadlineMs / 1000}s`);
      return this._clearDesired();
    }
    if (this._movingToward(d.on)) return;
    // After an accepted command the projector keeps reporting its old state (or ERR3)
    // for ~20s before PJLink shows warming/cooling (measured on the LS11000), so an
    // accepted request gets a long grace period; only a deferred or undelivered one is
    // retried quickly. Keeps traffic to a minimum on a fragile network stack.
    const wait = d.accepted ? this.powerAcceptGraceMs : this.powerRetryMs;
    if (this.now() - d.lastSentAt >= wait) {
      try {
        await this._sendPower();
      } catch {
        // ERR4 already logged and cleared in _sendPower.
      }
    }
  }

  // ---------- optional ESC/VP.net ----------

  _escvpAllowed() {
    return (
      this.escvpEnabled &&
      this.power === "on" &&
      this.desired === null &&
      this.powerSince !== null &&
      this.now() - this.powerSince >= this.escvpSettleMs &&
      this.now() - this.escvpLastAt >= this.escvpMinIntervalMs
    );
  }

  async _maybeEscvpRead() {
    if (!this._escvpAllowed()) return;
    const due = this.escvpLastReadAt < this.powerSince || this.now() - this.escvpLastReadAt >= this.escvpRefreshMs;
    if (!due) return;
    try {
      const replies = await this._escvpExec(ESCVP_READS);
      this.escvpLastReadAt = this.now();
      const byCmd = Object.fromEntries(replies.map((r) => [r.cmd, r.reply]));
      const picture = {};
      const source = valueOf(byCmd["SOURCE?"], "SOURCE");
      const colorMode = valueOf(byCmd["CMODE?"], "CMODE");
      const signal = valueOf(byCmd["SIGNAL?"], "SIGNAL");
      if (source !== null) picture.source = source;
      if (colorMode !== null) picture.colorMode = colorMode;
      if (signal !== null) picture.signal = signal;
      if (Object.keys(picture).length) this.emit("picture", picture);
    } catch {
      // Already reported via the escvp status patch.
    }
  }

  async _escvpExec(commands) {
    this.escvpLastAt = this.now();
    try {
      const replies = await this.escvp.exec(commands);
      this.emit("escvp", { available: true, lastError: null, lastOkAt: new Date(this.now()).toISOString() });
      return replies;
    } catch (err) {
      this.emit("escvp", { available: false, lastError: err.message });
      throw err;
    }
  }

  // Raw ESC/VP.net command from the API, subject to the same guard rails as the
  // automatic reads: enabled, projector on and settled, nothing else in flight.
  async escvpRaw(command) {
    if (!this.escvpEnabled) throw Object.assign(new Error("ESC/VP.net is disabled (escvp.enabled)"), { code: "disabled" });
    if (this.power !== "on" || this.powerSince === null || this.now() - this.powerSince < this.escvpSettleMs || this.desired) {
      throw Object.assign(new Error("ESC/VP.net is only used while the projector is on and settled"), { code: "not_ready" });
    }
    const [r] = await this._escvpExec([command]);
    return r.reply;
  }

  async pjlinkRaw(command) {
    const [r] = await this.pjlink.exec([command]);
    if (r) this._applyReply(r);
    return r;
  }

  async setInput(code) {
    const [r] = await this.pjlink.exec([`%1INPT ${code}`]);
    if (!r || r.value !== "OK") {
      throw Object.assign(new Error(`Input change refused (${r ? r.value : "no reply"})`), { code: r && r.error });
    }
    // "OK" means accepted, not applied; the next (full) poll confirms the new input.
    this.pollCount = 0;
    this._bumpActive();
    this._schedulePoll(this.notifyConfirmMs);
    return "accepted";
  }

  async refresh() {
    this.pollCount = 0; // next poll is a full one
    await this.pollOnce();
  }
}

module.exports = { ProjectorDriver, POWER_STATES, parseErst };
