"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { splitFrames, runSession, valueOf, HANDSHAKE } = require("../src/escvp");

test("splitFrames separates IMEVENT pushes from replies, in either order", () => {
  // Both orderings were captured from the real projector during warm-up.
  const a = splitFrames("IMEVENT=0001 02 00000000 00000000 T1 F1\r:PWR=02\r:");
  assert.deepEqual(a.frames, ["IMEVENT=0001 02 00000000 00000000 T1 F1", "PWR=02"]);
  const b = splitFrames("PWR=02\r:IMEVENT=0001 02 00000002 00000000 T1 F1\r:PWR");
  assert.deepEqual(b.frames, ["PWR=02", "IMEVENT=0001 02 00000002 00000000 T1 F1"]);
  assert.equal(b.remainder, "PWR");
  assert.deepEqual(splitFrames(":").frames, [""]); // bare ack for a set command
});

test("valueOf extracts a value and ignores ERR", () => {
  assert.equal(valueOf("SOURCE=30", "SOURCE"), "30");
  assert.equal(valueOf("ERR", "SOURCE"), null);
});

test("runSession handshakes, skips IMEVENT frames and returns one reply per command", async (t) => {
  const server = net.createServer((sock) => {
    let gotHandshake = false;
    sock.on("data", (d) => {
      if (!gotHandshake) {
        assert.deepEqual(d.slice(0, 16), HANDSHAKE);
        gotHandshake = true;
        sock.write(Buffer.from([...Buffer.from("ESC/VP.net"), 0x10, 0x03, 0, 0, 0x20, 0]));
        return;
      }
      const cmd = d.toString().trim();
      if (cmd === "SOURCE?") sock.write("IMEVENT=0001 03 00000002 00000000 T1 F1\r:SOURCE=30\r:");
      else sock.write("ERR\r:");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());

  const events = [];
  const out = await runSession({
    host: "127.0.0.1",
    port: server.address().port,
    commands: ["SOURCE?", "LUMINANCE?"],
    timeoutMs: 1000,
    onEvent: (e) => events.push(e)
  });
  assert.deepEqual(out, [
    { cmd: "SOURCE?", reply: "SOURCE=30", error: false },
    { cmd: "LUMINANCE?", reply: "ERR", error: true }
  ]);
  assert.equal(events.length, 1);
});

test("runSession times out when the handshake is never answered (the observed hang)", async (t) => {
  const server = net.createServer(() => {}); // accepts TCP, says nothing
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  await assert.rejects(
    runSession({ host: "127.0.0.1", port: server.address().port, commands: ["PWR?"], timeoutMs: 150 }),
    /timeout/
  );
});
