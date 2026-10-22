"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const { ProjectorDriver, parseErst } = require("../src/projector");
const { StateStore } = require("../src/state");
const { FakePjlink } = require("./fakes");

// A scripted projector: `power` is the PJLink POWR value it reports; `onPower` decides how
// it answers a power command. The driver is never start()ed, so no real timers run --
// tests advance the injected clock and call pollOnce() directly.
function rig({ power = "0", onPower, fail = false, escvp } = {}) {
  const sim = { power, fail, clock: 1_000_000 };
  const pjlink = new FakePjlink((cmd) => {
    if (sim.fail) throw new Error("ECONNREFUSED");
    if (cmd === "%1POWR ?") return `%1POWR=${sim.power}`;
    if (cmd.startsWith("%1POWR ")) return onPower ? onPower(cmd, sim) : "%1POWR=OK";
    const canned = {
      "%1INF1 ?": "%1INF1=EPSON",
      "%1INF2 ?": "%1INF2=EPSON LS11000W",
      "%1NAME ?": "%1NAME=EB7EA9D1",
      "%1CLSS ?": "%1CLSS=2",
      "%1INST ?": "%1INST=32 33",
      "%1INPT ?": sim.power === "1" ? "%1INPT=32" : "%1INPT=ERR3",
      "%1LAMP ?": "%1LAMP=599 0",
      "%1ERST ?": "%1ERST=000000"
    };
    return canned[cmd] || "%1XXXX=ERR1";
  });
  // FakePjlink.exec is sync-in-async; make transport failures reject like the real one.
  const exec = pjlink.exec.bind(pjlink);
  pjlink.exec = async (cmds) => exec(cmds);

  const driver = new ProjectorDriver({
    pjlink,
    escvp: escvp || null,
    escvpEnabled: !!escvp,
    now: () => sim.clock,
    failThreshold: 2,
    powerRetryMs: 10_000,
    powerDeadlineMs: 180_000,
    escvpSettleMs: 15_000
  });
  const state = new StateStore({ 32: { name: "HDMI1" }, 33: { name: "HDMI2" } });
  state.attach(driver);
  const advance = (ms) => (sim.clock += ms);
  return { sim, pjlink, driver, state, advance };
}

test("first poll identifies the projector and reads power, input list, hours and errors", async () => {
  const { driver, state } = rig({ power: "0" });
  await driver.pollOnce();
  const s = state.toJSON();
  assert.equal(s.power, "off");
  assert.equal(s.link.connected, true);
  assert.equal(s.link.model, "EPSON LS11000W");
  assert.deepEqual(s.sourceList, [
    { id: "32", name: "HDMI1" },
    { id: "33", name: "HDMI2" }
  ]);
  assert.equal(s.lampHours, 599);
  assert.equal(s.problem, false);
});

test("later polls are light: identity once, input/hours/errors only every Nth poll", async () => {
  const { driver, pjlink } = rig();
  await driver.pollOnce();
  pjlink.sent = [];
  await driver.pollOnce();
  assert.deepEqual(pjlink.sent, ["%1POWR ?"]);
});

test("ERR3 keeps the last known value instead of clobbering it", async () => {
  const { driver, state, sim } = rig({ power: "1" });
  await driver.pollOnce();
  assert.equal(state.state.input, "32");
  sim.power = "ERR3";
  await driver.refresh(); // full poll; POWR and INPT both come back ERR3
  assert.equal(state.state.power, "on");
  assert.equal(state.state.input, "32");
});

test("power on: accepted, tracked through warm-up, then confirmed and cleared", async () => {
  const { driver, state, sim, advance, pjlink } = rig({ power: "0" });
  await driver.pollOnce();
  assert.equal(await driver.setPower(true), "accepted");
  assert.equal(state.state.pendingPower, "on");

  sim.power = "3"; // warming
  advance(5000);
  await driver.pollOnce();
  assert.equal(state.state.power, "warming");
  assert.equal(state.state.pendingPower, "on");

  sim.power = "1";
  advance(45000);
  await driver.pollOnce();
  assert.equal(state.state.power, "on");
  assert.equal(state.state.pendingPower, null);
  assert.equal(pjlink.sent.filter((c) => c === "%1POWR 1").length, 1, "no redundant resend while warming");
});

test("an accepted request isn't resent while the projector still reports its old state", async () => {
  const { driver, state, sim, advance, pjlink } = rig({ power: "0" });
  await driver.pollOnce();
  await driver.setPower(true);
  const sends = () => pjlink.sent.filter((c) => c === "%1POWR 1").length;

  // Measured live: ~20s of POWR=0/ERR3 after an accepted power-on before "warming".
  for (let i = 0; i < 4; i++) {
    advance(5000);
    await driver.pollOnce();
  }
  assert.equal(sends(), 1);

  // If nothing has happened after the grace period, it is resent once.
  advance(30_000);
  await driver.pollOnce();
  assert.equal(sends(), 2);

  sim.power = "1";
  advance(5000);
  await driver.pollOnce();
  assert.equal(state.state.pendingPower, null);
});

test("a deferred power request (ERR3, e.g. still cooling) is retried until it takes", async () => {
  let accept = false;
  const { driver, state, sim, advance, pjlink } = rig({
    power: "2", // cooling
    onPower: () => (accept ? "%1POWR=OK" : "%1POWR=ERR3")
  });
  await driver.pollOnce();
  assert.equal(await driver.setPower(true), "deferred");

  advance(5000);
  await driver.pollOnce(); // still cooling, retry interval not yet elapsed
  assert.equal(pjlink.sent.filter((c) => c === "%1POWR 1").length, 1);

  sim.power = "0";
  accept = true;
  advance(6000);
  await driver.pollOnce(); // standby now, 11s since last send -> resend, accepted
  assert.equal(pjlink.sent.filter((c) => c === "%1POWR 1").length, 2);
  assert.equal(state.state.pendingPower, "on");

  sim.power = "1";
  advance(50000);
  await driver.pollOnce();
  assert.equal(state.state.pendingPower, null);
});

test("a power request that never takes effect gives up at the deadline", async () => {
  const { driver, state, advance } = rig({ power: "0", onPower: () => "%1POWR=ERR3" });
  await driver.pollOnce();
  await driver.setPower(true);
  advance(181_000);
  await driver.pollOnce();
  assert.equal(state.state.pendingPower, null);
  assert.equal(state.state.power, "off");
});

test("asking for the state it's already in sends nothing", async () => {
  const { driver, pjlink } = rig({ power: "1" });
  await driver.pollOnce();
  assert.equal(await driver.setPower(true), "already");
  assert.ok(!pjlink.sent.includes("%1POWR 1"));
});

test("ERR4 (projector failure) is surfaced, not retried", async () => {
  const { driver, state } = rig({ power: "0", onPower: () => "%1POWR=ERR4" });
  await driver.pollOnce();
  await assert.rejects(driver.setPower(true), /failure/);
  assert.equal(state.state.pendingPower, null);
});

test("a single failed poll is tolerated; consecutive failures mark the link down", async () => {
  const { driver, state, sim } = rig({ power: "1" });
  await driver.pollOnce();
  sim.fail = true;
  await driver.pollOnce();
  assert.equal(state.state.link.connected, true, "one miss (seen during warm-up) is not an outage");
  await driver.pollOnce();
  assert.equal(state.state.link.connected, false);
  assert.equal(state.state.power, "on", "last known power is kept, just flagged by link.connected");
  sim.fail = false;
  await driver.pollOnce();
  assert.equal(state.state.link.connected, true);
});

test("a class 2 notification updates power immediately", async () => {
  const { driver, state } = rig({ power: "0" });
  await driver.pollOnce();
  driver._onNotify({ cmd: "POWR", value: "1", raw: "%2POWR=1" });
  assert.equal(state.state.power, "on");
});

test("parseErst maps the six status digits", () => {
  assert.deepEqual(parseErst("000000"), { fan: "ok", lamp: "ok", temperature: "ok", cover: "ok", filter: "ok", other: "ok" });
  assert.equal(parseErst("002000").temperature, "error");
  assert.equal(parseErst("ERR3"), null);
});

// ---------- ESC/VP.net guard rails ----------

function fakeEscvp() {
  const e = new EventEmitter();
  e.calls = [];
  e.exec = async (cmds) => {
    e.calls.push(cmds);
    return cmds.map((cmd) => ({ cmd, reply: { "SOURCE?": "SOURCE=30", "CMODE?": "CMODE=23", "SIGNAL?": "SIGNAL=01" }[cmd] || "ERR" }));
  };
  return e;
}

test("ESC/VP.net is not touched while off, warming, or before the settle time", async () => {
  const escvp = fakeEscvp();
  const { driver, sim, advance } = rig({ power: "0", escvp });
  await driver.pollOnce();
  sim.power = "3";
  advance(5000);
  await driver.pollOnce();
  sim.power = "1";
  advance(5000);
  await driver.pollOnce(); // just turned on
  advance(10_000);
  await driver.pollOnce(); // on for 10s < 15s settle
  assert.equal(escvp.calls.length, 0);
  await assert.rejects(driver.escvpRaw("PWR?"), /settled/);
});

test("once on and settled, ESC/VP.net reads picture info once, then only at the refresh interval", async () => {
  const escvp = fakeEscvp();
  const { driver, state, sim, advance } = rig({ power: "1", escvp });
  await driver.pollOnce();
  advance(16_000);
  await driver.pollOnce();
  assert.equal(escvp.calls.length, 1);
  assert.deepEqual(state.state.picture, { source: "30", colorMode: "23", signal: "01" });
  advance(60_000);
  await driver.pollOnce();
  assert.equal(escvp.calls.length, 1, "no re-read before refreshSec");

  // A power command in flight blocks ESC/VP.net even while still on.
  await driver.setPower(false);
  sim.power = "1";
  await assert.rejects(driver.escvpRaw("PWR?"), /settled/);
});

test("ESC/VP.net raw is refused when disabled", async () => {
  const { driver } = rig({ power: "1" });
  await assert.rejects(driver.escvpRaw("PWR?"), /disabled/);
});
