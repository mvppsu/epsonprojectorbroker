"use strict";

const net = require("net");
const EventEmitter = require("events");
const { parseReply } = require("../src/pjlink");

// Stands in for PjlinkClient: answers from a scripted handler and records every command,
// so driver tests run without a socket. The handler gets (cmd) and returns the raw
// reply line ("%1POWR=1"), or throws to simulate a transport failure.
class FakePjlink extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.sent = [];
    this.on("error", () => {});
  }

  async exec(commands) {
    return commands.map((cmd) => {
      this.sent.push(cmd);
      return parseReply(this.handler(cmd));
    });
  }
}

// A minimal PJLink projector on a real TCP port, for exercising the client's framing,
// greeting and auth handling end to end.
function startPjlinkServer({ greeting = "PJLINK 0", respond }) {
  const received = [];
  const server = net.createServer((sock) => {
    sock.write(greeting + "\r");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("ascii");
      let i;
      while ((i = buf.indexOf("\r")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        received.push(line);
        const reply = respond(line);
        if (reply !== null && reply !== undefined) sock.write(reply + "\r");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, received }))
  );
}

module.exports = { FakePjlink, startPjlinkServer };
