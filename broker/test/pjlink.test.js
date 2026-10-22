"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { parseReply, authPrefix, runSession } = require("../src/pjlink");
const { SerialBus } = require("../src/serialBus");
const { PjlinkClient } = require("../src/pjlink");
const { startPjlinkServer } = require("./fakes");

test("parseReply handles values, OK and error codes for class 1 and 2", () => {
  assert.deepEqual(parseReply("%1POWR=1"), { cls: "1", cmd: "POWR", value: "1", error: null });
  assert.equal(parseReply("%1POWR=OK").value, "OK");
  assert.equal(parseReply("%1INPT=ERR3").error, "unavailable_time");
  assert.equal(parseReply("%2POWR=0\r").value, "0");
  assert.equal(parseReply("%1LAMP=599 0").value, "599 0");
  assert.equal(parseReply("garbage"), null);
});

test("authPrefix is empty without auth and md5(random+password) with it", () => {
  assert.equal(authPrefix("PJLINK 0", ""), "");
  const expected = crypto.createHash("md5").update("498e4a67secret").digest("hex");
  assert.equal(authPrefix("PJLINK 1 498e4a67", "secret"), expected);
  assert.throws(() => authPrefix("PJLINK 1 498e4a67", ""), /password/);
});

test("runSession runs a batch over one connection, matching the real LS11000 replies", async (t) => {
  const replies = { "%1POWR ?": "%1POWR=0", "%1LAMP ?": "%1LAMP=599 0", "%1INST ?": "%1INST=32 33" };
  const { server, port, received } = await startPjlinkServer({ respond: (l) => replies[l] });
  t.after(() => server.close());

  const out = await runSession({ host: "127.0.0.1", port, commands: Object.keys(replies), timeoutMs: 1000 });
  assert.deepEqual(out.map((r) => r.value), ["0", "599 0", "32 33"]);
  assert.deepEqual(received, Object.keys(replies));
});

test("runSession prefixes only the first command with the auth digest", async (t) => {
  const { server, port, received } = await startPjlinkServer({
    greeting: "PJLINK 1 abcd1234",
    respond: (l) => (l.endsWith("POWR ?") ? "%1POWR=1" : "%1INPT=32")
  });
  t.after(() => server.close());

  await runSession({ host: "127.0.0.1", port, password: "pw", commands: ["%1POWR ?", "%1INPT ?"], timeoutMs: 1000 });
  const digest = crypto.createHash("md5").update("abcd1234pw").digest("hex");
  assert.deepEqual(received, [`${digest}%1POWR ?`, "%1INPT ?"]);
});

test("runSession rejects on a silent projector instead of hanging", async (t) => {
  const { server, port } = await startPjlinkServer({ respond: () => null });
  t.after(() => server.close());
  await assert.rejects(runSession({ host: "127.0.0.1", port, commands: ["%1POWR ?"], timeoutMs: 150 }), /timeout/);
});

test("runSession surfaces an authentication failure", async (t) => {
  const { server, port } = await startPjlinkServer({ greeting: "PJLINK 1 abcd", respond: () => "PJLINK ERRA" });
  t.after(() => server.close());
  await assert.rejects(
    runSession({ host: "127.0.0.1", port, password: "wrong", commands: ["%1POWR ?"], timeoutMs: 1000 }),
    /authentication failed/
  );
});

test("the shared bus never runs two tasks at once, and a failure doesn't jam it", async () => {
  const bus = new SerialBus();
  let open = 0;
  let maxOpen = 0;
  const task = (fail) => async () => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 10));
    open -= 1;
    if (fail) throw new Error("boom");
    return "ok";
  };
  const results = await Promise.allSettled([bus.run(task()), bus.run(task(true)), bus.run(task()), bus.run(task())]);
  assert.equal(maxOpen, 1);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
});

test("PjlinkClient routes through the bus and returns parsed replies", async (t) => {
  const { server, port } = await startPjlinkServer({ respond: () => "%1POWR=0" });
  t.after(() => server.close());
  const client = new PjlinkClient({ host: "127.0.0.1", port, timeoutMs: 1000, bus: new SerialBus() });
  const all = await Promise.all([1, 2, 3].map(() => client.exec(["%1POWR ?"])));
  assert.deepEqual(all.map(([r]) => r.value), ["0", "0", "0"]);
});
