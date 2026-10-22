"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function defaultConfig() {
  return {
    projector: { host: "192.168.20.159" },
    pjlink: {
      port: 4352,
      password: "", // only if PJLink authentication is turned on in the projector menu
      pollIdleSec: 15, // steady state
      pollActiveSec: 5, // during transitions, and for activeWindowSec after any change
      activeWindowSec: 90,
      infoEveryPolls: 4, // input/laser hours/errors ride along on every Nth poll
      timeoutSec: 5,
      failThreshold: 3, // consecutive failed polls before the link is reported down
      powerRetrySec: 10, // re-send a power request the projector deferred (ERR3)
      powerAcceptGraceSec: 45, // re-send an *accepted* one only if nothing changed by then
      powerDeadlineSec: 180 // give up on a power request that never takes effect
    },
    // PJLink class 2 notifications: the projector's "Notified IP Address" must be set to
    // this broker's host. UDP, so with bridge networking publish <port>/udp.
    notify: { enabled: true, port: 4352 },
    // Off by default: on this projector ESC/VP.net has been seen to hang (and stay hung
    // across power cycles) after being used during shutdown. When enabled it is only
    // used for brief reads once the projector has been on for settleSec, never during a
    // power transition, never concurrently with PJLink, and at most every minIntervalSec.
    escvp: { enabled: false, port: 3629, settleSec: 15, refreshSec: 300, minIntervalSec: 30, timeoutSec: 5 },
    http: { port: 8096, authToken: "" },
    // Keyed by PJLink INPT code; the LS11000 reports INST=32 33.
    inputs: {
      32: { name: "HDMI1", enabled: true },
      33: { name: "HDMI2", enabled: true }
    }
  };
}

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base) || base === null) return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

class Config {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = defaultConfig();
    this.load();
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = yaml.load(raw) || {};
        this.data = deepMerge(defaultConfig(), parsed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[config] Failed to parse ${this.filePath}: ${err.message} — using defaults`);
        this.data = defaultConfig();
      }
    } else {
      this.save();
    }
    return this.data;
  }

  save() {
    // Best-effort: an unwritable /config (e.g. a UID mismatch on a mounted volume) must
    // not crash the broker; the in-memory change already took effect regardless.
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, yaml.dump(this.data, { sortKeys: false }), "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[config] Failed to save ${this.filePath}: ${err.message} — change kept in memory only`);
    }
  }

  update(partial) {
    this.data = deepMerge(this.data, partial);
    this.save();
    return this.data;
  }

  // What GET /api/config returns: everything except secrets.
  redacted() {
    const copy = JSON.parse(JSON.stringify(this.data));
    if (copy.pjlink.password) copy.pjlink.password = "********";
    if (copy.http.authToken) copy.http.authToken = "********";
    return copy;
  }
}

module.exports = { Config, defaultConfig, deepMerge };
