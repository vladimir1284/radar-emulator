// Sin build step: JS plano servido tal cual (stack.md#eleccion). La
// interfaz supervisa, no concluye: nunca calcula duraciones ni decide
// aserciones, solo muestra lo que manda el simulador (docs/ui/operacion.md).

const actorInput = document.getElementById("actor-input");
actorInput.value = localStorage.getItem("rd100s-actor") ?? "";
actorInput.addEventListener("change", () => {
  localStorage.setItem("rd100s-actor", actorInput.value);
});

function actor() {
  return actorInput.value.trim() || "anonimo";
}

let signalDefs = [];
let latestState = { signals: {} };
let lastSessionId = null;
let ws;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.addEventListener("message", (ev) => handleMessage(JSON.parse(ev.data)));
  ws.addEventListener("close", () => {
    document.getElementById("session-info").textContent = "desconectado, reintentando…";
    setTimeout(connect, 1000);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case "session":
      document.getElementById("session-info").textContent =
        `sesion ${msg.id.slice(0, 8)} · hash ${msg.config_hash.slice(0, 10)} · tick ${msg.tick_ms}ms · ${msg.connected} operador(es) conectado(s)`;
      // Sesion nueva (reconexion tras una recarga): la lista de señales
      // puede haber cambiado entera, y el registro de eventos es de otra
      // sesion (docs/ui/editor.md#la-recarga-arranca-sesion-nueva).
      if (msg.id !== lastSessionId) {
        lastSessionId = msg.id;
        document.getElementById("event-log").innerHTML = "";
        loadSignalDefs();
      }
      break;
    case "state":
      latestState = msg;
      renderSignalValues();
      break;
    case "event":
      appendEvent(msg);
      break;
    case "metrics":
      document.getElementById("link-metrics").textContent =
        `${msg.modbus_tx_per_s} transacciones Modbus/s · desviacion de tick ${msg.tick_deviation_ms} ms`;
      break;
  }
}

async function loadSignalDefs() {
  const res = await fetch("/api/config");
  const config = await res.json();
  signalDefs = config.signals;
  renderSignalList();
}

function groupBySubsystem(defs) {
  const groups = new Map();
  for (const def of defs) {
    if (!groups.has(def.subsystem)) groups.set(def.subsystem, []);
    groups.get(def.subsystem).push(def);
  }
  return groups;
}

function renderSignalList() {
  const filter = document.getElementById("filter-input").value.toLowerCase();
  const filtered = signalDefs.filter(
    (d) => !filter || d.id.toLowerCase().includes(filter) || d.label.toLowerCase().includes(filter),
  );
  const groups = groupBySubsystem(filtered);
  const container = document.getElementById("signal-list");
  container.innerHTML = "";

  for (const [subsystem, defs] of groups) {
    const group = document.createElement("div");
    group.className = "subsystem-group";
    const h3 = document.createElement("h3");
    h3.textContent = subsystem;
    group.appendChild(h3);
    for (const def of defs) {
      group.appendChild(renderSignalRow(def));
    }
    container.appendChild(group);
  }
  renderSignalValues();
}

function renderSignalRow(def) {
  const row = document.createElement("div");
  row.className = "signal-row";
  row.dataset.signalId = def.id;

  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = `<span>${def.label}</span><span class="id">${def.id}</span>`;
  row.appendChild(label);

  const value = document.createElement("div");
  value.className = "value-cell";
  row.appendChild(value);

  const mode = document.createElement("div");
  mode.className = "mode-cell";
  row.appendChild(mode);

  const quality = document.createElement("div");
  quality.className = "quality-cell";
  row.appendChild(quality);

  const controls = document.createElement("div");
  controls.className = "force-controls";
  if (def.type === "bool") {
    const btn = document.createElement("button");
    btn.textContent = "alternar";
    btn.onclick = () => {
      const current = latestState.signals[def.id];
      send({ type: "force", actor: actor(), signal: def.id, value: !(current && current.v) });
    };
    controls.appendChild(btn);
  } else {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    if (def.range) {
      input.title = `rango declarado: ${def.range[0]}..${def.range[1]}`;
    }
    const btn = document.createElement("button");
    btn.textContent = "forzar";
    btn.onclick = () => {
      const v = Number(input.value);
      if (Number.isNaN(v)) return;
      send({ type: "force", actor: actor(), signal: def.id, value: v });
    };
    controls.append(input, btn);
  }
  const releaseBtn = document.createElement("button");
  releaseBtn.textContent = "liberar";
  releaseBtn.onclick = () => send({ type: "release", actor: actor(), signal: def.id });
  controls.appendChild(releaseBtn);
  row.appendChild(controls);

  return row;
}

function renderSignalValues() {
  let forcedCount = 0;
  let anomalousCount = 0;
  for (const [id, reading] of Object.entries(latestState.signals ?? {})) {
    const row = document.querySelector(`.signal-row[data-signal-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    row.classList.toggle("forced", reading.m === "forced");
    if (reading.m === "forced") forcedCount += 1;
    if (reading.q !== "ok") anomalousCount += 1;

    row.querySelector(".value-cell").textContent =
      typeof reading.v === "number" ? reading.v.toFixed(3) : String(reading.v);

    const modeCell = row.querySelector(".mode-cell");
    modeCell.innerHTML = "";
    const modeBadge = document.createElement("span");
    modeBadge.className = `badge ${reading.m}`;
    modeBadge.textContent = reading.m;
    modeCell.appendChild(modeBadge);

    const qualityCell = row.querySelector(".quality-cell");
    qualityCell.innerHTML = "";
    if (reading.q !== "ok") {
      const qBadge = document.createElement("span");
      qBadge.className = `badge ${reading.q}`;
      qBadge.textContent = reading.q;
      qualityCell.appendChild(qBadge);
    }
  }
  document.getElementById("counters").textContent =
    `${forcedCount} señal(es) forzada(s) · ${anomalousCount} con calidad anómala`;
}

function appendEvent(evt) {
  const log = document.getElementById("event-log");
  const row = document.createElement("div");
  row.className = "event-row";
  row.innerHTML =
    `<span class="n">#${evt.n}</span> ` +
    `<span class="kind">${evt.kind}</span> ` +
    `${evt.signal ?? ""} — ${evt.actor ?? ""} ` +
    `<span class="t">t=${evt.t_us}us</span>`;
  log.prepend(row);
}

document.getElementById("filter-input").addEventListener("input", renderSignalList);

document.getElementById("release-all-btn").addEventListener("click", () => {
  for (const [id, reading] of Object.entries(latestState.signals ?? {})) {
    if (reading.m === "forced") send({ type: "release", actor: actor(), signal: id });
  }
});

document.getElementById("download-btn").addEventListener("click", () => {
  window.location.href = "/api/session/export";
});

document.getElementById("reload-btn").addEventListener("click", async () => {
  if (!confirm("Recargar arranca una sesion nueva: los eventos de la sesion actual quedan cerrados. Continuar?")) {
    return;
  }
  const res = await fetch("/api/config/reload", { method: "POST" });
  const body = await res.json();
  if (!body.ok) {
    alert(`Recarga rechazada: ${body.error}`);
    return;
  }
  // El servidor reconstruyo store/servidor Modbus/WebSocket con la
  // configuracion nueva: la conexion actual se cierra desde el otro lado.
  // El listener de "close" ya maneja la reconexion y vuelve a pedir
  // /api/config.
});

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

loadSignalDefs();
connect();
