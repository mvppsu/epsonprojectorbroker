(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const MAX_LOG_LINES = 200;

  let state = {};
  let ws = null;
  let wsBackoff = 1000;

  const POWER_LABELS = {
    on: "On",
    off: "Standby",
    warming: "Warming up",
    cooling: "Cooling down",
    unknown: "Unknown"
  };

  function render() {
    const link = state.link || {};
    el("model").textContent = link.model || "Epson projector";

    const pill = el("link");
    const wsUp = ws && ws.readyState === WebSocket.OPEN;
    pill.textContent = !wsUp ? "broker offline" : link.connected ? "projector reachable" : "projector unreachable";
    pill.className = "pill " + (wsUp && link.connected ? "ok" : "bad");

    const power = state.power || "unknown";
    el("power-label").textContent = POWER_LABELS[power] || power;
    el("power-dot").className = "dot " + power;
    el("pending").textContent = state.pendingPower ? `Requested: power ${state.pendingPower}…` : "";
    el("btn-on").disabled = !wsUp || power === "on" || state.pendingPower === "on";
    el("btn-off").disabled = !wsUp || power === "off" || state.pendingPower === "off";

    const select = el("input");
    const list = state.sourceList || [];
    if (select.options.length !== list.length) {
      select.innerHTML = "";
      for (const s of list) select.add(new Option(s.name, s.id));
    }
    select.value = state.input || "";
    select.disabled = !wsUp || power !== "on";

    el("hours").textContent = state.lampHours != null ? state.lampHours : "—";
    if (state.errors) {
      const bad = Object.entries(state.errors).filter(([, v]) => v !== "ok");
      el("errors").textContent = bad.length ? bad.map(([k, v]) => `${k}: ${v}`).join(", ") : "No faults";
    }
    const e = state.escvp || {};
    el("escvp").textContent = !e.enabled ? "Disabled" : e.available === false ? `Unavailable (${e.lastError})` : e.available ? "OK" : "Not used yet";
  }

  function appendLog(line) {
    const pre = el("log");
    const lines = (pre.textContent ? pre.textContent.split("\n") : []).concat(line);
    pre.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
    pre.scrollTop = pre.scrollHeight;
  }

  function send(cmd, value) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "command", cmd, value }));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsBackoff = 1000;
      render();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") state = msg.state;
      else if (msg.type === "patch") state = { ...state, ...msg.changed };
      else if (msg.type === "line") return appendLog(msg.line);
      else if (msg.type === "error") return appendLog(`!! ${msg.cmd}: ${msg.message}`);
      render();
    };
    ws.onclose = () => {
      render();
      setTimeout(connect, wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 30000);
    };
  }

  el("btn-on").addEventListener("click", () => send("power", true));
  el("btn-off").addEventListener("click", () => send("power", false));
  el("input").addEventListener("change", (ev) => send("input", ev.target.value));

  fetch("api/log")
    .then((r) => r.json())
    .then((entries) => entries.forEach((e) => appendLog(e.line)))
    .catch(() => {});
  connect();
})();
