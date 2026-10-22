"use strict";

const EventEmitter = require("events");

// Single authoritative snapshot of the projector, updated only from what the projector
// itself reports (PJLink replies and notifications, optional ESC/VP.net reads) -- never
// optimistically from a command being sent. The one exception is pendingPower, which
// records what was *asked for* and is cleared once the projector confirms it.
// Emits "change" with a shallow diff of top-level keys on every update.
class StateStore extends EventEmitter {
  constructor(inputConfig) {
    super();
    this.inputConfig = inputConfig || {};
    this.state = {
      link: {
        connected: false,
        lastOkAt: null,
        manufacturer: null,
        model: null,
        name: null,
        pjlinkClass: null,
        mac: null
      },
      power: "unknown", // "off" | "warming" | "on" | "cooling" | "unknown"
      powerSince: null,
      pendingPower: null, // "on" | "off" | null
      input: null, // PJLink INPT code, e.g. "32"
      inputs: [], // PJLink INST codes the projector reports
      lampHours: null,
      errors: null, // { fan, lamp, temperature, cover, filter, other }: ok|warning|error
      escvp: { enabled: false, available: null, lastError: null, lastOkAt: null },
      picture: { source: null, colorMode: null, signal: null }
    };
  }

  attach(driver) {
    this.state.escvp = { ...this.state.escvp, enabled: !!driver.escvpEnabled };
    driver.on("connected", () => this._patch("link", { connected: true, lastOkAt: new Date().toISOString() }));
    driver.on("disconnected", () => this._patch("link", { connected: false }));
    driver.on("info", (field, value) => {
      if (this.state.link[field] !== value) this._patch("link", { [field]: value });
    });
    driver.on("power", (power) => {
      this.set("power", power);
      this.set("powerSince", new Date().toISOString());
    });
    driver.on("pendingPower", (p) => this.set("pendingPower", p));
    driver.on("input", (code) => this.set("input", code));
    driver.on("inputs", (codes) => {
      if (codes.join(",") !== this.state.inputs.join(",")) this.set("inputs", codes);
    });
    driver.on("lampHours", (h) => this.set("lampHours", h));
    driver.on("errors", (e) => {
      if (JSON.stringify(e) !== JSON.stringify(this.state.errors)) this.set("errors", e);
    });
    driver.on("escvp", (patch) => this._patch("escvp", patch));
    driver.on("picture", (patch) => this._patch("picture", patch));
  }

  set(key, value) {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.emit("change", { [key]: value });
  }

  _patch(key, partial) {
    this.state[key] = { ...this.state[key], ...partial };
    this.emit("change", { [key]: this.state[key] });
  }

  inputName(code) {
    const override = this.inputConfig[code];
    if (override && override.name) return override.name;
    return `Input ${code}`;
  }

  sourceList() {
    const codes = this.state.inputs.length ? this.state.inputs : Object.keys(this.inputConfig);
    return codes
      .filter((code) => !(this.inputConfig[code] && this.inputConfig[code].enabled === false))
      .map((code) => ({ id: code, name: this.inputName(code) }));
  }

  // Derived fields every consumer wants and that change whenever their inputs do;
  // recomputed for both the full snapshot and each patch (see httpServer.js).
  derived() {
    const errors = this.state.errors;
    return {
      inputName: this.state.input != null ? this.inputName(this.state.input) : null,
      sourceList: this.sourceList(),
      problem: errors ? Object.values(errors).some((v) => v !== "ok") : null
    };
  }

  toJSON() {
    return { ...this.state, ...this.derived() };
  }
}

module.exports = { StateStore };
