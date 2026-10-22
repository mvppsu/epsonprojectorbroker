"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const WebSocket = require("ws");
const { createHttpServer } = require("../src/httpServer");
const { StateStore } = require("../src/state");
const { LogRing } = require("../src/logRing");

function fakeDriver() {
  const d = new EventEmitter();
  d.calls = [];
  d.escvpEnabled = false;
  d.setPower = async (on) => {
    d.calls.push(["power", on]);
    d.emit("pendingPower", on ? "on" : "off");
    return "accepted";
  };
  d.setInput = async (code) => {
    d.calls.push(["input", code]);
    return "accepted";
  };
  d.refresh = async () => d.calls.push(["refresh"]);
  d.pjlinkRaw = async (line) => ({ cmd: line.slice(2, 6), value: "0" });
  d.escvpRaw = async () => {
    throw new Error("ESC/VP.net is disabled (escvp.enabled)");
  };
  return d;
}

async function start({ token = "" } = {}) {
  const driver = fakeDriver();
  const state = new StateStore({ 32: { name: "HDMI1" }, 33: { name: "HDMI2" } });
  state.attach(driver);
  const config = {
    data: { http: { authToken: token } },
    redacted() {
      return { http: { authToken: token ? "********" : "" } };
    },
    update() {}
  };
  const server = createHttpServer({ driver, state, config, logRingBuffer: new LogRing(10) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, driver, state, base, port: server.address().port };
}

// fetch() keeps connections alive, which would hold server.close() open indefinitely.
function stop(server) {
  server.closeAllConnections();
  server.close();
}

// Queued reader: ws emits back-to-back frames synchronously, so a fresh once("message")
// per await would drop any frame that lands in the same chunk as the previous one.
function reader(ws) {
  const queue = [];
  const waiters = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });

test("REST power routes drive the driver and report pending state", async (t) => {
  const { server, driver, base } = await start();
  t.after(() => stop(server));

  let res = await post(`${base}/api/power/on`);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.result, "accepted");
  assert.equal(body.pendingPower, "on");

  res = await post(`${base}/api/power`, { on: false });
  assert.equal(res.status, 202);
  assert.deepEqual(driver.calls, [
    ["power", true],
    ["power", false]
  ]);

  res = await post(`${base}/api/power`, {});
  assert.equal(res.status, 400);
});

test("toggle powers off when on and on when off", async (t) => {
  const { server, driver, base } = await start();
  t.after(() => stop(server));
  driver.emit("power", "on");
  await post(`${base}/api/power/toggle`);
  driver.emit("power", "off");
  await post(`${base}/api/power/toggle`);
  assert.deepEqual(driver.calls, [
    ["power", false],
    ["power", true]
  ]);
});

test("input accepts a name or a PJLink code; unknown inputs are rejected", async (t) => {
  const { server, driver, base } = await start();
  t.after(() => stop(server));
  await post(`${base}/api/command`, { cmd: "input", value: "HDMI2" });
  await post(`${base}/api/command`, { cmd: "input", value: "32" });
  const res = await post(`${base}/api/command`, { cmd: "input", value: "HDMI9" });
  assert.equal(res.status, 400);
  assert.deepEqual(driver.calls, [
    ["input", "33"],
    ["input", "32"]
  ]);
});

test("POSTs need the token when one is set; GETs and healthz don't", async (t) => {
  const { server, base } = await start({ token: "s3cret" });
  t.after(() => stop(server));
  assert.equal((await post(`${base}/api/power/on`)).status, 401);
  assert.equal((await post(`${base}/api/power/on`, null, { authorization: "Bearer s3cret" })).status, 202);
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.projector, "unreachable");
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.http.authToken, "********");
});

test("raw PJLink lines are validated", async (t) => {
  const { server, base } = await start();
  t.after(() => stop(server));
  assert.equal((await post(`${base}/api/raw`, { line: "%1POWR ?" })).status, 200);
  assert.equal((await post(`${base}/api/raw`, { line: "POWR ?" })).status, 400);
  const res = await post(`${base}/api/raw`, { protocol: "escvp", line: "PWR?" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /disabled/);
});

test("WebSocket sends a snapshot, then patches with derived fields, and accepts commands", async (t) => {
  const { server, driver, port } = await start();
  t.after(() => stop(server));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const next = reader(ws);

  const snapshot = await next();
  assert.equal(snapshot.type, "state");
  assert.equal(snapshot.state.power, "unknown");

  driver.emit("input", "33");
  const patch = await next();
  assert.equal(patch.changed.input, "33");
  assert.equal(patch.changed.inputName, "HDMI2");

  ws.send(JSON.stringify({ type: "command", cmd: "power", value: true }));
  for (;;) {
    const m = await next();
    messages.push(m);
    if (m.type === "result") break;
  }
  assert.ok(messages.some((m) => m.type === "patch" && m.changed.pendingPower === "on"));
  assert.deepEqual(driver.calls, [["power", true]]);
  ws.close();
});

test("WebSocket commands are refused without the token when one is set", async (t) => {
  const { server, driver, port } = await start({ token: "s3cret" });
  t.after(() => stop(server));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const next = reader(ws);
  await next(); // snapshot is still readable
  ws.send(JSON.stringify({ type: "command", cmd: "power", value: true }));
  const reply = await next();
  assert.equal(reply.type, "error");
  assert.equal(driver.calls.length, 0);
  ws.close();
});
