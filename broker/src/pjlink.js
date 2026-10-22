"use strict";

const net = require("net");
const crypto = require("crypto");
const EventEmitter = require("events");

const DEFAULT_TIMEOUT_MS = 5000;

const ERROR_CODES = {
  ERR1: "undefined_command",
  ERR2: "out_of_parameter",
  ERR3: "unavailable_time",
  ERR4: "projector_failure"
};

// "%1POWR=1" -> { cls: "1", cmd: "POWR", value: "1", error: null }. Also used for class 2
// UDP notifications ("%2POWR=0"), which share the same shape. Exported standalone so the
// parsing can be unit-tested without a socket.
function parseReply(line) {
  const m = String(line).trim().match(/^%([12])([A-Z0-9]{4})=(.*)$/);
  if (!m) return null;
  const value = m[3].trim();
  return { cls: m[1], cmd: m[2], value, error: ERROR_CODES[value] || null };
}

// The greeting is "PJLINK 0" with authentication off, or "PJLINK 1 <random>" with it on;
// the latter requires every session's first command to be prefixed with
// md5(random + password).
function authPrefix(greeting, password) {
  const m = String(greeting).trim().match(/^PJLINK ([01])(?: (\S+))?$/);
  if (!m) throw new Error(`Unexpected PJLink greeting: ${greeting}`);
  if (m[1] === "0") return "";
  if (!password) throw new Error("Projector requires a PJLink password (pjlink.password)");
  return crypto.createHash("md5").update(m[2] + password).digest("hex");
}

// Opens one TCP session, runs each command in order, and closes. PJLink projectors drop
// idle sessions after ~30s anyway, so a short session per batch is the normal pattern and
// avoids holding a socket on a device with a fragile network stack.
function runSession({ host, port, password, commands, timeoutMs, onSent, onLine }) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const replies = [];
    let buffer = "";
    let greeted = false;
    let prefix = "";
    let index = 0;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(replies);
    };

    // One deadline for the whole batch, re-armed per reply, so a projector that stops
    // answering mid-session (seen during warm-up) can't hang the shared bus.
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("PJLink timeout")), timeoutMs);
    };

    const sendNext = () => {
      if (index >= commands.length) return finish(null);
      const cmd = commands[index];
      const line = (index === 0 ? prefix : "") + cmd;
      if (onSent) onSent(cmd);
      sock.write(line + "\r", "ascii");
      arm();
    };

    const handleLine = (line) => {
      if (onLine) onLine(line);
      if (!greeted) {
        greeted = true;
        try {
          prefix = authPrefix(line, password);
        } catch (err) {
          return finish(err);
        }
        return sendNext();
      }
      if (/^PJLINK ERRA$/.test(line)) return finish(new Error("PJLink authentication failed"));
      const parsed = parseReply(line);
      replies.push(parsed || { cls: null, cmd: null, value: line, error: "unparseable" });
      index += 1;
      sendNext();
    };

    sock.setNoDelay(true);
    sock.on("data", (data) => {
      buffer += data.toString("ascii");
      let i;
      while ((i = buffer.indexOf("\r")) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish(new Error("PJLink connection closed early")));

    arm();
    sock.connect(port, host);
  });
}

// Emits "sent" and "line" for the protocol log; "error" always has a listener.
class PjlinkClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port || 4352;
    this.password = opts.password || "";
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.bus = opts.bus;
    this.on("error", () => {});
  }

  // Resolves to one parsed reply per command; rejects on a transport failure.
  exec(commands) {
    return this.bus.run(() =>
      runSession({
        host: this.host,
        port: this.port,
        password: this.password,
        commands,
        timeoutMs: this.timeoutMs,
        onSent: (cmd) => this.emit("sent", `[pjlink] ${cmd}`),
        onLine: (line) => this.emit("line", `[pjlink] ${line}`)
      })
    );
  }
}

module.exports = { PjlinkClient, parseReply, authPrefix, runSession, ERROR_CODES };
