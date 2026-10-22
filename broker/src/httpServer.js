"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const WEB_ROOT = path.join(__dirname, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function truthy(value) {
  if (typeof value === "string") return ["1", "true", "on", "yes"].includes(value.toLowerCase());
  return !!value;
}

// Maps the REST/WS command vocabulary onto ProjectorDriver. Shared by /api/command, the
// convenience /api/power routes and the WebSocket so they behave identically.
function buildCommandHandler(driver, state) {
  return async function handle(cmd, value) {
    switch (cmd) {
      case "power":
        return driver.setPower(truthy(value));
      case "powerToggle": {
        const p = state.state.power;
        return driver.setPower(!(p === "on" || p === "warming"));
      }
      case "input": {
        // Accept either the PJLink code ("32") or a configured name ("HDMI1").
        const match = state.sourceList().find((s) => s.id === String(value) || s.name === value);
        if (!match) throw new Error(`Unknown input: ${value}`);
        return driver.setInput(match.id);
      }
      case "refresh":
        return driver.refresh();
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  };
}

function checkAuth(req, config) {
  const token = config.data.http.authToken;
  if (!token) return true;
  return (req.headers["authorization"] || "") === `Bearer ${token}`;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(WEB_ROOT, rel));
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function createHttpServer({ driver, state, config, logRingBuffer }) {
  const handleCommand = buildCommandHandler(driver, state);

  const powerView = () => ({
    power: state.state.power,
    pendingPower: state.state.pendingPower,
    powerSince: state.state.powerSince,
    connected: state.state.link.connected
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    // Any POST changes something, so all of them sit behind the optional token.
    if (req.method === "POST" && !checkAuth(req, config)) {
      res.writeHead(401);
      res.end();
      return;
    }

    try {
      if (p === "/healthz") {
        // Always 200 while the broker process is healthy: a projector that's unplugged
        // or briefly unreachable is reported in the body, not by failing the container
        // health check (which would get it restarted for no reason).
        return sendJson(res, 200, { ok: true, projector: state.state.link.connected ? "reachable" : "unreachable", power: state.state.power });
      }

      if (p === "/api/state" && req.method === "GET") return sendJson(res, 200, state.toJSON());

      if (p === "/api/power" && req.method === "GET") return sendJson(res, 200, powerView());

      if ((p === "/api/power/on" || p === "/api/power/off" || p === "/api/power/toggle") && req.method === "POST") {
        const action = p.split("/").pop();
        const result =
          action === "toggle" ? await handleCommand("powerToggle") : await handleCommand("power", action === "on");
        return sendJson(res, 202, { ok: true, result, ...powerView() });
      }

      if (p === "/api/power" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (body.on === undefined) throw new Error('Body must be {"on": true|false}');
        const result = await handleCommand("power", body.on);
        return sendJson(res, 202, { ok: true, result, ...powerView() });
      }

      if (p === "/api/command" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = await handleCommand(body.cmd, body.value);
        return sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
      }

      if (p === "/api/raw" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const line = String(body.line || "").trim();
        if (body.protocol === "escvp") {
          if (!/^[A-Z0-9]+(\?| .+)?$/.test(line)) throw new Error("ESC/VP21 line must look like CMD? or CMD PARAM");
          return sendJson(res, 200, { ok: true, reply: await driver.escvpRaw(line) });
        }
        if (!/^%[12][A-Z0-9]{4} .+$/.test(line)) throw new Error("PJLink line must look like %1POWR ?");
        return sendJson(res, 200, { ok: true, reply: await driver.pjlinkRaw(line) });
      }

      if (p === "/api/log" && req.method === "GET") return sendJson(res, 200, logRingBuffer.entries());

      if (p === "/api/config" && req.method === "GET") return sendJson(res, 200, config.redacted());

      if (p === "/api/config" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        config.update(body);
        return sendJson(res, 200, config.redacted());
      }
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message, code: err.code });
    }

    if (req.method === "GET") return serveStatic(req, res, p);
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const authorized = checkAuth(req, config);
    ws.send(JSON.stringify({ type: "state", state: state.toJSON() }));

    const onChange = (changed) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: "patch", changed: { ...changed, ...state.derived() } }));
    };
    state.on("change", onChange);

    const onLog = (entry) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "line", line: entry.line }));
    };
    logRingBuffer.on && logRingBuffer.on("push", onLog);

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "command") {
        if (!authorized) {
          ws.send(JSON.stringify({ type: "error", cmd: msg.cmd, message: "unauthorized" }));
          return;
        }
        try {
          const result = await handleCommand(msg.cmd, msg.value);
          ws.send(JSON.stringify({ type: "result", cmd: msg.cmd, result: result === undefined ? null : result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", cmd: msg.cmd, message: err.message }));
        }
      }
    });

    ws.on("close", () => {
      state.off("change", onChange);
      logRingBuffer.off && logRingBuffer.off("push", onLog);
    });
  });

  return server;
}

module.exports = { createHttpServer, buildCommandHandler };
