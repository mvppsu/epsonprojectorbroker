"use strict";

const net = require("net");
const EventEmitter = require("events");

const HANDSHAKE = Buffer.from([
  ...Buffer.from("ESC/VP.net", "ascii"),
  0x10, // protocol version 1.0
  0x03, // type: CONNECT
  0x00, 0x00, // reserved
  0x00, // status (request)
  0x00 // header count
]);
const STATUS_OK = 0x20;
const DEFAULT_TIMEOUT_MS = 5000;

// Splits ESC/VP21 output into frames on the ':' prompt. Unsolicited "IMEVENT=..." status
// frames can arrive before or after a reply in the same read, so they are separated out
// rather than mistaken for the answer to the command in flight. Exported for tests.
function splitFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let i;
  while ((i = rest.indexOf(":")) !== -1) {
    const frame = rest.slice(0, i).replace(/\r/g, " ").trim();
    rest = rest.slice(i + 1);
    frames.push(frame);
  }
  return { frames, remainder: rest };
}

// One short ESC/VP.net session: handshake, run each command, close. Deliberately not a
// persistent connection -- see serialBus.js and docs/INVESTIGATION.md for why this
// protocol is only ever touched briefly, while the projector is on and settled.
function runSession({ host, port, commands, timeoutMs, onSent, onLine, onEvent }) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const replies = [];
    let handshaken = false;
    let header = Buffer.alloc(0);
    let text = "";
    let index = 0;
    let settled = false;
    let timer = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(replies);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("ESC/VP.net timeout")), timeoutMs);
    };
    const sendNext = () => {
      if (index >= commands.length) return finish(null);
      if (onSent) onSent(commands[index]);
      sock.write(commands[index] + "\r", "ascii");
      arm();
    };

    sock.on("data", (data) => {
      if (!handshaken) {
        header = Buffer.concat([header, data]);
        if (header.length < 16) return;
        if (header.slice(0, 10).toString("ascii") !== "ESC/VP.net" || header[14] !== STATUS_OK) {
          return finish(new Error(`ESC/VP.net handshake rejected (status 0x${header[14].toString(16)})`));
        }
        handshaken = true;
        text = header.slice(16).toString("ascii");
        sendNext();
      } else {
        text += data.toString("ascii");
      }
      const { frames, remainder } = splitFrames(text);
      text = remainder;
      for (const frame of frames) {
        if (onLine) onLine(frame);
        if (frame.startsWith("IMEVENT")) {
          if (onEvent) onEvent(frame);
          continue;
        }
        if (index >= commands.length) continue;
        replies.push({ cmd: commands[index], reply: frame, error: frame === "ERR" });
        index += 1;
        sendNext();
      }
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish(new Error("ESC/VP.net connection closed early")));

    arm();
    sock.connect(port, host, () => sock.write(HANDSHAKE));
  });
}

class EscvpClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port || 3629;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.bus = opts.bus;
    this.on("error", () => {});
  }

  exec(commands) {
    return this.bus.run(() =>
      runSession({
        host: this.host,
        port: this.port,
        commands,
        timeoutMs: this.timeoutMs,
        onSent: (cmd) => this.emit("sent", `[escvp] ${cmd}`),
        onLine: (line) => this.emit("line", `[escvp] ${line}`),
        onEvent: (frame) => this.emit("imevent", frame)
      })
    );
  }
}

// "SOURCE=30" -> "30"; "ERR" or anything else -> null.
function valueOf(reply, cmd) {
  const m = String(reply || "").match(new RegExp(`^${cmd}=(.*)$`));
  return m ? m[1].trim() : null;
}

module.exports = { EscvpClient, splitFrames, runSession, valueOf, HANDSHAKE };
