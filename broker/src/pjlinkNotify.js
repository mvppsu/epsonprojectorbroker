"use strict";

const dgram = require("dgram");
const EventEmitter = require("events");
const { parseReply } = require("./pjlink");

// Listens for PJLink class 2 status notifications. The projector sends these as UDP
// datagrams to its configured "Notified IP Address" (the broker host) on port 4352 when
// power, input, errors or its network link change. They are a fast path only: polling
// still runs, and every notification also triggers a confirming poll.
// Emits "notify" ({ cmd, value }), "listening", "error" (always has a listener).
class PjlinkNotifier extends EventEmitter {
  constructor(opts) {
    super();
    this.port = opts.port || 4352;
    this.projectorHost = opts.projectorHost;
    this.socket = null;
    this.on("error", () => {});
  }

  start() {
    if (this.socket) return;
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = sock;
    sock.on("error", (err) => {
      this.emit("error", err);
      // A bind failure (port already in use) must not take the broker down; polling
      // alone still keeps state correct, just less promptly.
      sock.close();
      if (this.socket === sock) this.socket = null;
    });
    sock.on("message", (msg, rinfo) => this._onMessage(msg, rinfo));
    sock.on("listening", () => this.emit("listening", this.port));
    sock.bind(this.port);
  }

  _onMessage(msg, rinfo) {
    // Anything on the LAN can send UDP here; only trust the projector's own address.
    if (this.projectorHost && rinfo.address !== this.projectorHost) return;
    for (const line of msg.toString("ascii").split("\r")) {
      const parsed = parseReply(line);
      if (parsed) this.emit("notify", { cmd: parsed.cmd, value: parsed.value, raw: line.trim() });
    }
  }

  stop() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

module.exports = { PjlinkNotifier };
