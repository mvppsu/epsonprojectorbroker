"use strict";

const EventEmitter = require("events");

// Small fixed-size ring buffer of recent protocol lines and broker events, for /api/log
// and the web panel. Emits "push" with each new entry so WebSocket clients can stream it.
class LogRing extends EventEmitter {
  constructor(capacity = 500) {
    super();
    this.capacity = capacity;
    this.buf = [];
  }

  push(line) {
    const entry = { t: new Date().toISOString(), line };
    this.buf.push(entry);
    if (this.buf.length > this.capacity) this.buf.shift();
    this.emit("push", entry);
  }

  entries() {
    return this.buf;
  }
}

module.exports = { LogRing };
