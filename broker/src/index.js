"use strict";

const path = require("path");
const { Config } = require("./config");
const { SerialBus } = require("./serialBus");
const { PjlinkClient } = require("./pjlink");
const { PjlinkNotifier } = require("./pjlinkNotify");
const { EscvpClient } = require("./escvp");
const { ProjectorDriver } = require("./projector");
const { StateStore } = require("./state");
const { LogRing } = require("./logRing");
const { createHttpServer } = require("./httpServer");

const CONFIG_PATH = process.env.BROKER_CONFIG || path.join(__dirname, "..", "..", "config", "broker.yaml");

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(new Date().toISOString(), ...args);
}

function main() {
  // A control daemon should not go down because one handler hit an edge case; log it
  // and keep polling and the API up.
  process.on("uncaughtException", (err) => log("[fatal-caught] uncaughtException:", err.stack || err.message));
  process.on("unhandledRejection", (err) => log("[fatal-caught] unhandledRejection:", (err && err.stack) || err));

  const config = new Config(CONFIG_PATH);
  log(`[config] loaded from ${CONFIG_PATH}`);
  const c = config.data;

  const bus = new SerialBus();
  const pjlink = new PjlinkClient({
    host: c.projector.host,
    port: c.pjlink.port,
    password: c.pjlink.password,
    timeoutMs: c.pjlink.timeoutSec * 1000,
    bus
  });
  const escvp = new EscvpClient({ host: c.projector.host, port: c.escvp.port, timeoutMs: c.escvp.timeoutSec * 1000, bus });
  const notifier = c.notify.enabled ? new PjlinkNotifier({ port: c.notify.port, projectorHost: c.projector.host }) : null;

  const driver = new ProjectorDriver({
    pjlink,
    escvp,
    notifier,
    pollIdleMs: c.pjlink.pollIdleSec * 1000,
    pollActiveMs: c.pjlink.pollActiveSec * 1000,
    activeWindowMs: c.pjlink.activeWindowSec * 1000,
    infoEveryPolls: c.pjlink.infoEveryPolls,
    failThreshold: c.pjlink.failThreshold,
    powerRetryMs: c.pjlink.powerRetrySec * 1000,
    powerAcceptGraceMs: c.pjlink.powerAcceptGraceSec * 1000,
    powerDeadlineMs: c.pjlink.powerDeadlineSec * 1000,
    escvpEnabled: c.escvp.enabled,
    escvpSettleMs: c.escvp.settleSec * 1000,
    escvpRefreshMs: c.escvp.refreshSec * 1000,
    escvpMinIntervalMs: c.escvp.minIntervalSec * 1000
  });

  const state = new StateStore(c.inputs);
  state.attach(driver);

  const logRing = new LogRing(500);
  for (const client of [pjlink, escvp]) {
    client.on("sent", (line) => logRing.push(`-> ${line}`));
    client.on("line", (line) => logRing.push(`<- ${line}`));
  }
  driver.on("log", (msg) => {
    logRing.push(`-- ${msg}`);
    log(`[projector] ${msg}`);
  });
  driver.on("connected", () => log("[projector] PJLink reachable"));
  driver.on("disconnected", () => log("[projector] PJLink unreachable"));
  driver.on("power", (p) => log(`[projector] power ${p}`));
  if (notifier) {
    notifier.on("listening", (port) => log(`[notify] listening for PJLink notifications on udp/${port}`));
    notifier.on("error", (err) => log(`[notify] disabled: ${err.message} (polling continues)`));
  }
  log(`[escvp] ${c.escvp.enabled ? "enabled (reads only while on and settled)" : "disabled"}`);

  const server = createHttpServer({ driver, state, config, logRingBuffer: logRing });
  // Without the API the broker is useless, and the catch-all handler above would otherwise
  // keep a headless process alive; exit so Docker's restart policy can retry.
  server.on("error", (err) => {
    log(`[http] cannot listen on :${c.http.port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(c.http.port, () => log(`[http] listening on :${c.http.port}`));

  driver.start();

  const shutdown = () => {
    log("[main] shutting down");
    server.close();
    driver.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
