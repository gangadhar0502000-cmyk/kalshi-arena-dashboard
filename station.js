// Original pixel-art station. Rooms, crew, and numbers come from the gist.
// Art, names, and sprites are not taken from any other project.
const STATION_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];
const STATION_TW = 34;
const STATION_TH = 17;
let stationState = null;
let stationHits = [];
let stationOrigin = { x: 80, y: 28 };
let stationSize = { width: 940, height: 540 };
let stationRunning = false;
let stationToken = 0;
let stationPointerBound = false;
let stationStars = null;

function stationDash(value) {
  return present(value) ? value : "—";
}
function stationNum(value, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}
function stationPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return (number * 100).toFixed(1) + "%";
}
function stationClip(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}
function gateTarget(health, summary) {
  const sources = [health, health && health.ai_scoreboard, summary];
  const keys = ["graduation_windows", "gate_windows", "graduate_windows"];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!src || typeof src !== "object") continue;
    for (let k = 0; k < keys.length; k++) {
      const value = Number(src[keys[k]]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 48;
}
function graduateCount(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
function graduateNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") return item.agent_id || item.name || item.id || "";
    return "";
  }).filter(Boolean);
}
function spotPrice(market, health, coin) {
  const keys = ["kraken_spot", "spot", "spot_px", "spot_price", "kraken_px", "kraken"];
  if (market) {
    for (let i = 0; i < keys.length; i++) {
      const value = market[keys[i]];
      if (present(value) && typeof value !== "object") return value;
    }
  }
  const bags = [];
  if (health) {
    ["spot", "spots", "kraken", "kraken_spot", "spot_px"].forEach(name => {
      if (health[name] && typeof health[name] === "object") bags.push(health[name]);
    });
  }
  for (let b = 0; b < bags.length; b++) {
    const row = bags[b][coin];
    if (present(row) && typeof row !== "object") return row;
    if (row && typeof row === "object") {
      for (let i = 0; i < keys.length; i++) {
        if (present(row[keys[i]]) && typeof row[keys[i]] !== "object") return row[keys[i]];
      }
      if (present(row.price)) return row.price;
      if (present(row.last)) return row.last;
    }
  }
  return null;
}
function marketsByCoin(markets) {
  const out = {};
  (markets || []).forEach(market => {
    const match = /^KX([A-Z0-9]+)15M/.exec(String(market && market.ticker || ""));
    if (match) out[match[1]] = market;
  });
  return out;
}
function yesNoSplit(side) {
  if (!side || !side.coins || typeof side.coins !== "object") return null;
  let yes = 0;
  let no = 0;
  let any = false;
  Object.keys(side.coins).forEach(coin => {
    const row = side.coins[coin] || {};
    if (typeof row.yes_qty === "number") { yes += row.yes_qty; any = true; }
    if (typeof row.no_qty === "number") { no += row.no_qty; any = true; }
  });
  if (!any) return null;
  const total = yes + no;
  return { yes: yes, no: no, share: total ? yes / total : null, max: side.max_side };
}
function ideaFromAccepted(raw) {
  if (raw && typeof raw === "object") {
    if (present(raw.reasoning)) return String(raw.reasoning);
    if (present(raw.text)) return String(raw.text);
    return "";
  }
  if (!present(raw)) return "";
  const text = String(raw);
  const match = /"reasoning"\s*:\s*"([\s\S]*)/.exec(text);
  if (match) {
    let body = match[1];
    const end = body.search(/"/);
    if (end >= 0) body = body.slice(0, end);
    return body.replace(/\\n/g, " ").replace(/\\"/g, "\"").replace(/\\t/g, " ");
  }
  if (text.trim().charAt(0) === "{") return "";
  return text;
}
function newestIdea(llm) {
  const calls = (llm && Array.isArray(llm.calls)) ? llm.calls : [];
  if (!calls.length) return null;
  const sorted = calls.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const call = sorted[0];
  return { text: ideaFromAccepted(call.accepted), status: present(call.status) ? String(call.status) : "" };
}
function sharedNoteList(health, leaderboard) {
  if (health && Array.isArray(health.memory)) return { notes: health.memory, where: "health.memory" };
  if (leaderboard && Array.isArray(leaderboard.memory)) return { notes: leaderboard.memory, where: "leaderboard.memory" };
  return { notes: null, where: "missing" };
}
function notesForGroup(health, id) {
  if (!health || !health.groups || typeof health.groups !== "object" || Array.isArray(health.groups)) {
    return { missing: true, notes: [] };
  }
  const notes = health.groups[String(id)];
  if (!Array.isArray(notes)) return { missing: false, notes: [] };
  return { missing: false, notes: notes };
}
function unseenSeries(generations) {
  return (generations || []).map(row => ({
    id: row && row.id,
    value: chartValue(row, "median_oos_net")
  }));
}
function bestByUnseen(agents) {
  let best = null;
  (agents || []).forEach(agent => {
    const net = Number(agent.oos_net);
    if (!Number.isFinite(net)) return;
    if (!best || net > Number(best.oos_net)) best = agent;
  });
  return best;
}
function stationMap() {
  const rooms = [];
  const cols = [0, 5, 10, 15, 20];
  cols.forEach((c, index) => rooms.push({ id: "g" + index, kind: "team", groupId: String(index), c: c, r: 0, w: 4, h: 3 }));
  cols.forEach((c, index) => rooms.push({ id: "g" + (index + 5), kind: "team", groupId: String(index + 5), c: c, r: 5, w: 4, h: 3 }));
  rooms.push({ id: "exchange", kind: "exchange", c: 0, r: 10, w: 8, h: 4 });
  rooms.push({ id: "lab", kind: "lab", c: 8, r: 10, w: 8, h: 4 });
  rooms.push({ id: "vault", kind: "vault", c: 16, r: 10, w: 8, h: 4 });
  cols.forEach((c, index) => rooms.push({ id: "g" + (index + 10), kind: "team", groupId: String(index + 10), c: c, r: 16, w: 4, h: 3 }));
  cols.forEach((c, index) => rooms.push({ id: "g" + (index + 15), kind: "team", groupId: String(index + 15), c: c, r: 21, w: 4, h: 3 }));
  return rooms;
}
function hallFor(room) {
  const tiles = [];
  const mid = room.c + Math.floor(room.w / 2);
  if (room.r + room.h <= 10) {
    tiles.push({ c: mid, r: room.r + room.h, ids: [room.groupId] });
    tiles.push({ c: mid, r: room.r + room.h + 1, ids: [room.groupId] });
  } else if (room.r >= 16) {
    tiles.push({ c: mid, r: room.r - 1, ids: [room.groupId] });
    tiles.push({ c: mid, r: room.r - 2, ids: [room.groupId] });
  }
  if (room.c < 20) {
    tiles.push({ c: room.c + room.w, r: room.r + 1, ids: [room.groupId, String(Number(room.groupId) + 1)] });
  }
  return tiles;
}
function isoOf(c, r) {
  return {
    x: stationOrigin.x + (c - r) * STATION_TW / 2,
    y: stationOrigin.y + (c + r) * STATION_TH / 2
  };
}
function diamond(ctx, x, y, tw, th) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + tw / 2, y + th / 2);
  ctx.lineTo(x, y + th);
  ctx.lineTo(x - tw / 2, y + th / 2);
  ctx.closePath();
}
function tileColors(kind, lit, pulse) {
  if (lit) {
    return pulse > 0.5
      ? { floor: "#a86b22", edge: "#f0c14a" }
      : { floor: "#6e4818", edge: "#d7a24a" };
  }
  if (kind === "lab") return { floor: "#1a3c4a", edge: "#7ef6e4" };
  if (kind === "exchange") return { floor: "#3a301c", edge: "#e2b15a" };
  if (kind === "vault") return { floor: "#243044", edge: "#8fd4ff" };
  if (kind === "hall") return { floor: "#1a2834", edge: "#314556" };
  const pair = (kind === "team-b")
    ? { floor: "#24384c", edge: "#3d5368" }
    : { floor: "#1c3144", edge: "#314556" };
  return pair;
}
function drawTile(ctx, c, r, colors, checker) {
  const p = isoOf(c, r);
  diamond(ctx, p.x, p.y, STATION_TW, STATION_TH);
  ctx.fillStyle = checker ? colors.floor : shade(colors.floor);
  ctx.fill();
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.stroke();
}
function shade(hex) {
  if (hex === "#1c3144") return "#182838";
  if (hex === "#24384c") return "#1e3142";
  if (hex === "#1a3c4a") return "#163440";
  if (hex === "#3a301c") return "#312816";
  if (hex === "#243044") return "#1e2838";
  if (hex === "#a86b22") return "#8f5a1c";
  if (hex === "#6e4818") return "#5c3c14";
  if (hex === "#1a2834") return "#15222c";
  return hex;
}
function drawBackWall(ctx, c, r) {
  const p = isoOf(c, r);
  const h = 8;
  ctx.fillStyle = "#40566a";
  ctx.beginPath();
  ctx.moveTo(p.x - STATION_TW / 2, p.y + STATION_TH / 2);
  ctx.lineTo(p.x, p.y);
  ctx.lineTo(p.x, p.y - h);
  ctx.lineTo(p.x - STATION_TW / 2, p.y + STATION_TH / 2 - h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#2c3e4e";
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + STATION_TW / 2, p.y + STATION_TH / 2);
  ctx.lineTo(p.x + STATION_TW / 2, p.y + STATION_TH / 2 - h);
  ctx.lineTo(p.x, p.y - h);
  ctx.closePath();
  ctx.fill();
}
function drawConsole(ctx, c, r, screen) {
  const p = isoOf(c + 0.35, r + 0.35);
  ctx.fillStyle = "#101820";
  ctx.fillRect(p.x - 5, p.y - 8, 10, 7);
  ctx.fillStyle = screen;
  ctx.fillRect(p.x - 4, p.y - 7, 8, 4);
}
function drawCrew(ctx, x, y, pose, robot) {
  const code = !!(robot && robot.codeStrategy);
  const body = code ? "#b06ad8" : "#d5e2ea";
  const head = code ? "#d7a6f0" : "#f4fbff";
  const visor = code ? "#ff8af0" : "#7ef6e4";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x - 3, y, 7, 2);
  ctx.fillStyle = "#8aa0aa";
  ctx.fillRect(x - 2, y - 4, 2, 4);
  ctx.fillRect(x + 1, y - 4, 2, 4);
  if (!pose.work && pose.step) ctx.fillRect(x - 3, y - 2, 1, 2);
  else if (!pose.work) ctx.fillRect(x + 3, y - 2, 1, 2);
  ctx.fillStyle = body;
  ctx.fillRect(x - 3, y - 9, 7, 5);
  ctx.fillStyle = code ? "#7a4a98" : "#9eb4be";
  ctx.fillRect(x - 2, y - 8, 3, 3);
  ctx.fillStyle = "#8aa0aa";
  if (pose.work) ctx.fillRect(x + 4, y - 8, 3, 2);
  else ctx.fillRect(x - 5, y - 8, 2, 3);
  ctx.fillStyle = head;
  ctx.fillRect(x - 2, y - 13, 5, 4);
  ctx.fillStyle = visor;
  ctx.fillRect(x - 2, y - 12, 5, 2);
  if (robot && robot.leader) {
    ctx.fillStyle = "#f0c14a";
    ctx.fillRect(x - 2, y - 14, 5, 1);
  }
  if (robot && robot.hasFills) {
    ctx.fillStyle = "#f0c14a";
    ctx.fillRect(x + 2, y - 6, 2, 2);
  }
}
function plateText(ctx, text, x, y, color) {
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const width = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(7, 16, 24, 0.82)";
  ctx.fillRect(x - width / 2 - 3, y - 11, width + 6, 14);
  ctx.fillStyle = color || "#e8fff8";
  ctx.fillText(text, x, y);
}
function crewPose(id, now, reduced) {
  if (reduced) return { step: 0, work: 1, shift: 0 };
  const t = now / 1000 + hashPhase(id || "crew");
  const work = (t % 5) < 2.8;
  return {
    step: work ? 0 : (Math.floor(t * 6) % 2),
    work: work ? 1 : 0,
    shift: work ? 0 : Math.sin(t * 3) * 4
  };
}
function stars() {
  if (stationStars) return stationStars;
  const list = [];
  let n = 17;
  for (let i = 0; i < 80; i++) {
    n = (n * 1103515245 + 12345) >>> 0;
    const x = (n % 1000) / 1000;
    n = (n * 1103515245 + 12345) >>> 0;
    const y = (n % 1000) / 1000;
    list.push({ x: x, y: y, s: (n % 3) + 1 });
  }
  stationStars = list;
  return list;
}
function layoutStationCanvas(rooms, halls) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  stationOrigin = { x: 0, y: 0 };
  function touch(c, r) {
    const p = isoOf(c, r);
    minX = Math.min(minX, p.x - STATION_TW / 2);
    maxX = Math.max(maxX, p.x + STATION_TW / 2);
    minY = Math.min(minY, p.y - 12);
    maxY = Math.max(maxY, p.y + STATION_TH + 16);
  }
  rooms.forEach(room => {
    for (let dc = 0; dc < room.w; dc++) {
      for (let dr = 0; dr < room.h; dr++) touch(room.c + dc, room.r + dr);
    }
  });
  halls.forEach(tile => touch(tile.c, tile.r));
  const pad = 18;
  stationOrigin = { x: pad - minX, y: pad - minY };
  stationSize = {
    width: Math.ceil(maxX - minX + pad * 2),
    height: Math.ceil(maxY - minY + pad * 2)
  };
  const canvas = document.getElementById("station-canvas");
  if (!canvas) return;
  canvas.width = stationSize.width;
  canvas.height = stationSize.height;
}
function roomHasNotes(state, id) {
  const info = state.groupNotes.get(String(id));
  return !!(info && info.notes && info.notes.length);
}
function drawStation(now) {
  const canvas = document.getElementById("station-canvas");
  const state = stationState;
  if (!canvas || !state) return;
  const ctx = canvas.getContext("2d");
  const reduced = prefersReducedMotion();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#071018";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  stars().forEach(star => {
    ctx.fillStyle = star.s === 1 ? "#1c3040" : "#9ad0dc";
    ctx.fillRect(star.x * canvas.width, star.y * canvas.height, star.s === 3 ? 2 : 1, star.s === 3 ? 2 : 1);
  });
  const pulse = reduced ? 1 : (0.5 + 0.5 * Math.sin(now / 280));
  const tiles = [];
  state.halls.forEach(tile => {
    const lit = tile.ids.some(id => roomHasNotes(state, id));
    tiles.push({ c: tile.c, r: tile.r, kind: "hall", lit: lit, sort: tile.c + tile.r });
  });
  state.rooms.forEach(room => {
    for (let dc = 0; dc < room.w; dc++) {
      for (let dr = 0; dr < room.h; dr++) {
        tiles.push({
          c: room.c + dc,
          r: room.r + dr,
          kind: room.kind === "team" && ((room.c + room.r) % 2) ? "team-b" : room.kind,
          lit: false,
          back: dr === 0,
          sort: room.c + dc + room.r + dr + 0.1
        });
      }
    }
  });
  tiles.sort((a, b) => a.sort - b.sort);
  tiles.forEach(tile => {
    const checker = (tile.c + tile.r) % 2 === 0;
    const colors = tileColors(tile.kind, tile.lit, pulse);
    if (tile.back) drawBackWall(ctx, tile.c, tile.r);
    drawTile(ctx, tile.c, tile.r, colors, checker);
  });
  state.rooms.forEach(room => {
    if (room.kind === "team") drawConsole(ctx, room.c + 1, room.r, "#7ef6e4");
    if (room.kind === "lab") drawConsole(ctx, room.c + 3, room.r + 1, "#7ef6e4");
    if (room.kind === "exchange") {
      STATION_COINS.forEach((coin, index) => drawConsole(ctx, room.c + 1 + index, room.r + 1, "#e2b15a"));
    }
    if (room.kind === "vault") drawConsole(ctx, room.c + 3, room.r + 1, "#8fd4ff");
  });
  stationHits = [];
  state.rooms.forEach(room => {
    if (room.kind !== "team") return;
    const group = state.byId.get(room.groupId);
    const robots = group ? group.robots : [];
    const shown = robots.slice(0, 4);
    shown.forEach((robot, index) => {
      const pose = crewPose(robot.id, now, reduced);
      const col = 1 + (index % 2);
      const row = 1 + Math.floor(index / 2);
      const p = isoOf(room.c + col + 0.2, room.r + Math.min(room.h - 1, row) + 0.2);
      drawCrew(ctx, p.x + pose.shift, p.y, pose, robot);
      stationHits.push({ x: p.x + pose.shift, y: p.y - 6, r: 10, robot: robot, room: room });
    });
    const unnamed = room.unnamed || 0;
    const marks = Math.min(8, unnamed);
    for (let i = 0; i < marks; i++) {
      const p = isoOf(room.c + 0.6 + i * 0.35, room.r + room.h - 0.55);
      ctx.fillStyle = "#6a7c88";
      ctx.fillRect(p.x, p.y, 2, 2);
    }
    const front = isoOf(room.c + room.w / 2, room.r + room.h - 0.2);
    const note = roomHasNotes(state, room.groupId);
    plateText(ctx, "G" + room.groupId, front.x, front.y + 14, note ? "#f0c14a" : "#d5e8e4");
  });
  const lab = state.rooms.find(room => room.kind === "lab");
  const exchange = state.rooms.find(room => room.kind === "exchange");
  const vault = state.rooms.find(room => room.kind === "vault");
  if (lab) {
    const p = isoOf(lab.c + lab.w / 2, lab.r + 2);
    plateText(ctx, state.labMark, p.x, p.y, "#7ef6e4");
  }
  if (exchange) {
    const p = isoOf(exchange.c + exchange.w / 2, exchange.r + 2.2);
    plateText(ctx, "EXCHANGE", p.x, p.y, "#e2b15a");
  }
  if (vault) {
    const p = isoOf(vault.c + vault.w / 2, vault.r + 2.2);
    plateText(ctx, state.vaultMark, p.x, p.y, "#8fd4ff");
  }
}
function hudCard(label, metric, body) {
  return `<div class="hud-card"><div class="label">${escapeHtml(label)}</div><div class="metric">${metric}</div>${body || ""}</div>`;
}
function drawUnseenChart(points) {
  const canvas = document.getElementById("unseen-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width = 200;
  const h = canvas.height = 46;
  ctx.clearRect(0, 0, w, h);
  const vals = points.map(point => point.value).filter(value => value !== null && value !== undefined);
  if (!vals.length) {
    ctx.fillStyle = "#93c4ba";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText("—", 6, 26);
    return;
  }
  const lo = Math.min.apply(null, vals);
  const hi = Math.max.apply(null, vals);
  const span = (hi - lo) || 1;
  ctx.beginPath();
  ctx.strokeStyle = "#f0c14a";
  ctx.lineWidth = 1.5;
  let started = false;
  points.forEach((point, index) => {
    if (point.value === null || point.value === undefined) {
      started = false;
      return;
    }
    const x = 2 + (points.length === 1 ? 0 : index * (w - 4) / (points.length - 1));
    const y = 4 + (1 - (point.value - lo) / span) * (h - 8);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
function renderStationHud(state) {
  const left = document.getElementById("station-hud-left");
  const right = document.getElementById("station-hud-right");
  const rooms = document.getElementById("station-rooms");
  const legend = document.getElementById("station-legend");
  if (left) left.innerHTML = state.leftHtml;
  if (right) right.innerHTML = state.rightHtml;
  if (rooms) rooms.innerHTML = state.roomHtml;
  if (legend) legend.textContent = state.legend;
  drawUnseenChart(state.unseen);
}
function buildStationState(bundle) {
  const health = bundle.health || {};
  const leaderboard = bundle.leaderboard || {};
  const generations = (bundle.generations && bundle.generations.generations) || [];
  const summary = generations.length ? (generations[generations.length - 1].summary || {}) : {};
  const agents = leaderboard.agents || [];
  const trades = (bundle.trades && bundle.trades.trades) || [];
  const leaderInfo = readLeaderMap(health, summary);
  const noteInfo = readSharedNotes(health, leaderboard, summary);
  const model = buildArenaModel(agents, trades, leaderInfo, noteInfo.notes || []);
  const byId = new Map(model.map(group => [String(group.id), group]));
  const roster = model.filter(group => group.id !== "missing");
  const each = perGroupSize(typeof health.population === "number" ? health.population : null, roster.length);
  const rooms = stationMap();
  rooms.forEach(room => {
    if (room.kind !== "team") return;
    const group = byId.get(room.groupId);
    const named = group ? group.robots.length : 0;
    room.unnamed = typeof each === "number" ? Math.max(0, each - named) : 0;
  });
  const halls = [];
  rooms.forEach(room => {
    if (room.kind === "team") hallFor(room).forEach(tile => halls.push(tile));
  });
  const groupNotes = new Map();
  for (let i = 0; i < 20; i++) groupNotes.set(String(i), notesForGroup(health, i));
  const notes = sharedNoteList(health, leaderboard);
  const scoreboard = (health.ai_scoreboard && typeof health.ai_scoreboard === "object") ? health.ai_scoreboard : null;
  const idea = newestIdea(bundle.llm);
  const archive = (health.idea_archive && typeof health.idea_archive === "object") ? health.idea_archive : null;
  const top = archive && Array.isArray(archive.top) ? archive.top : null;
  const gate = gateTarget(health, summary);
  const grads = graduateCount(health.graduates);
  const best = bestByUnseen(agents);
  const split = yesNoSplit(health.side_bias);
  const coins = marketsByCoin(health.markets);
  const installed = agents.filter(agent => readCodeStrategy(agent));
  const unseen = unseenSeries(generations);
  const lastUnseen = unseen.filter(point => point.value !== null && point.value !== undefined).slice(-1)[0];

  const genMetric = present(health.generation) ? escapeHtml(health.generation) : "—";
  const unseenMetric = lastUnseen ? "$" + Number(lastUnseen.value).toFixed(2) : "—";
  const bestMetric = best ? escapeHtml(best.agent_id) : "—";
  let bestBody = "<p>unseen net —</p>";
  if (best) bestBody = "<p>unseen net " + escapeHtml(netText(best.oos_net)) + "</p>";
  else if (present(summary.best_oos_net)) bestBody = "<p>best holdout " + escapeHtml(netText(summary.best_oos_net)) + " · agent id —</p>";
  const paperMetric = health.paper === true ? "paper" : (present(health.paper) ? escapeHtml(health.paper) : "—");
  const paperBody = "<p>" + escapeHtml(present(health.live_trading) ? "live trading " + health.live_trading : "live trading —") + "</p>";

  const leftHtml = [
    hudCard("Generation", genMetric, "<p>" + escapeHtml(present(health.feed) ? "feed " + health.feed : "feed —") + "</p>"),
    hudCard("Unseen median", unseenMetric, "<canvas id='unseen-chart' width='200' height='46'></canvas><p>median_oos_net</p>"),
    hudCard("Best agent", bestMetric, bestBody),
    hudCard("Paper", paperMetric, paperBody)
  ].join("");

  let codeBody = "";
  if (!installed.length) codeBody += "<p>leaderboard code rows: none</p>";
  installed.slice(0, 3).forEach(agent => {
    const strategy = readCodeStrategy(agent);
    codeBody += "<p>" + escapeHtml(agent.agent_id) + " · " + escapeHtml(strategy.description) + "</p>";
  });
  codeBody += "<p>generation n_code " + escapeHtml(stationNum(summary.n_code, 0) === "—" && !present(summary.n_code) ? "—" : (present(summary.n_code) ? String(summary.n_code) : "—")) + "</p>";
  if (!top) codeBody += "<p>idea archive —</p>";
  else if (!top.length) codeBody += "<p>idea archive empty</p>";
  else top.slice(0, 3).forEach(item => {
    const name = item.name || item.hypothesis || "—";
    const windows = present(item.windows) ? item.windows + "/" + gate : "—";
    const net = present(item.unseen_net) ? netText(item.unseen_net) : "—";
    codeBody += "<p>" + escapeHtml(name) + " · " + escapeHtml(windows) + " · " + escapeHtml(net) + "</p>";
  });

  let yesBody = "<p>—</p>";
  if (split) {
    yesBody = "<p>YES " + escapeHtml(stationPct(split.share)) + "</p><p>max " + escapeHtml(present(split.max) ? split.max : "—") + "</p>";
  }
  const diversityBody = "<p>" + escapeHtml(stationNum(health.n_behavior_clusters, 0)) + " clusters · largest " + escapeHtml(stationPct(health.largest_cluster_share)) + "</p>";
  const publish = (bundle.manifest && present(bundle.manifest.published_at)) ? bundle.manifest.published_at : "—";
  const healthBody = "<p>RSS " + escapeHtml(stationNum(health.mem_rss_mb, 0)) + " / free " + escapeHtml(stationNum(health.mem_available_mb, 0)) + " MB</p>"
    + "<p>spot lag " + escapeHtml(stationNum(health.spot_lag_s, 1) === "—" ? "—" : stationNum(health.spot_lag_s, 1) + "s") + " · " + escapeHtml(present(health.spot_source) ? health.spot_source : "—") + "</p>"
    + "<p>published " + escapeHtml(publish) + "</p>";

  const rightHtml = [
    hudCard("Code strategies", present(summary.n_code) ? escapeHtml(summary.n_code) : (installed.length ? String(installed.length) : "—"), codeBody),
    hudCard("YES / NO", split ? escapeHtml(stationPct(split.share)) : "—", yesBody),
    hudCard("Diversity", escapeHtml(stationNum(health.diversity, 3)), diversityBody),
    hudCard("Health", escapeHtml(stationNum(health.mem_rss_mb, 0)), healthBody)
  ].join("");

  const drafts = scoreboard && present(scoreboard.drafts_per_hour) ? String(scoreboard.drafts_per_hour) : "—";
  const pass = scoreboard ? stationPct(scoreboard.pass_rate) : "—";
  const ideaText = idea && idea.text ? stationClip(idea.text, 220) : "";
  let labHtml = "<div class='room-card'><div class='label'>AI lab</div><div class='metric'>" + escapeHtml(drafts) + "/h</div>";
  labHtml += "<p>pass rate " + escapeHtml(pass) + "</p>";
  labHtml += "<p>trend " + escapeHtml(scoreboard && present(scoreboard.trend) ? scoreboard.trend : "—") + "</p>";
  labHtml += "<p>" + (ideaText ? escapeHtml(ideaText) : "current idea —") + "</p>";
  const features = Array.isArray(health.accepted_features) ? health.accepted_features : null;
  if (!features) labHtml += "<p>accepted features —</p>";
  else if (!features.length) labHtml += "<p>accepted features: none</p>";
  else features.slice(0, 4).forEach(feature => {
    labHtml += "<p>" + escapeHtml(feature.name || "—") + (present(feature.reason) ? " · " + escapeHtml(stationClip(feature.reason, 120)) : "") + "</p>";
  });
  if (notes.notes == null) labHtml += "<p>shared notes —</p>";
  else labHtml += "<p>" + notes.notes.length + " shared notes from " + escapeHtml(notes.where) + "</p>";
  labHtml += "</div>";

  let exHtml = "<div class='room-card'><div class='label'>Exchange</div><div class='metric'>" + (health.markets ? health.markets.length : "—") + "</div>";
  if (!health.markets) exHtml += "<p>—</p>";
  else STATION_COINS.forEach(coin => {
    const market = coins[coin];
    if (!market) {
      exHtml += "<p>" + coin + " —</p>";
      return;
    }
    const spot = spotPrice(market, health, coin);
    exHtml += "<p>" + coin + " Kalshi " + escapeHtml(stationDash(market.yes_bid)) + "/" + escapeHtml(stationDash(market.yes_ask))
      + " strike " + escapeHtml(stationDash(market.floor_strike))
      + " Kraken " + escapeHtml(spot == null ? "—" : spot) + "</p>";
  });
  exHtml += "<p>spot lag " + escapeHtml(present(health.spot_lag_s) ? stationNum(health.spot_lag_s, 1) + "s" : "—")
    + " · " + escapeHtml(present(health.spot_source) ? health.spot_source : "—") + "</p></div>";

  let vaultHtml = "<div class='room-card'><div class='label'>Vault</div><div class='metric'>" + (grads == null ? "—" : String(grads)) + "</div>";
  vaultHtml += "<p>graduates" + (grads === 0 ? ": 0" : "") + "</p>";
  const names = graduateNames(health.graduates);
  if (names.length) vaultHtml += "<p>" + escapeHtml(names.slice(0, 4).join(", ")) + "</p>";
  vaultHtml += "<p>" + gate + "-window gate</p>";
  if (!top) vaultHtml += "<p>strategy windows —</p>";
  else if (!top.length) vaultHtml += "<p>no archived strategies</p>";
  else top.slice(0, 4).forEach(item => {
    const windows = Number(item.windows);
    const known = Number.isFinite(windows);
    const ratio = known ? Math.max(0, Math.min(1, windows / gate)) : 0;
    vaultHtml += "<p>" + escapeHtml(item.name || item.hypothesis || "—") + " · " + (known ? windows : "—") + "/" + gate + "</p>";
    if (known) vaultHtml += "<div class='gate'><span style='width:" + (ratio * 100).toFixed(1) + "%'></span></div>";
  });
  vaultHtml += "</div>";

  const labMark = "LAB " + (scoreboard && present(scoreboard.drafts_per_hour) ? scoreboard.drafts_per_hour + "/h" : "—");
  const vaultMark = "VAULT " + (grads == null ? "—" : grads);

  return {
    rooms: rooms,
    halls: halls,
    byId: byId,
    groupNotes: groupNotes,
    each: each,
    leftHtml: leftHtml,
    rightHtml: rightHtml,
    roomHtml: labHtml + exHtml + vaultHtml,
    legend: "Rooms are the 20 groups. Moving crew are agents named in this snapshot. Still pixels are seats the snapshot does not name, and only when the population divides evenly. Purple crew appear only when a leaderboard row sets code. Amber halls are groups with notes in this snapshot. Gray halls are the station floor. Walking is decoration, not a trade.",
    unseen: unseen,
    labMark: labMark,
    vaultMark: vaultMark,
    labTip: "AI lab. Drafts per hour " + drafts + ". Pass rate " + pass + ". " + (ideaText || "Current idea —"),
    exchangeTip: "Exchange. Kalshi yes bid/ask and strike from health.markets. Kraken spot is — when the gist has no spot price.",
    vaultTip: "Vault. Graduates " + (grads == null ? "—" : grads) + ". Gate " + gate + " windows."
  };
}
function ensureStationLoop() {
  if (stationRunning || prefersReducedMotion()) return;
  stationRunning = true;
  const token = ++stationToken;
  const step = now => {
    const panel = document.getElementById("station");
    if (token !== stationToken || prefersReducedMotion() || !panel || panel.hidden) {
      stationRunning = false;
      return;
    }
    drawStation(now);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function stationTileAt(px, py) {
  const x = (px - stationOrigin.x) / (STATION_TW / 2);
  const y = (py - stationOrigin.y) / (STATION_TH / 2);
  return { c: Math.floor((x + y) / 2), r: Math.floor((y - x) / 2) };
}
function stationEventPoint(event) {
  const canvas = document.getElementById("station-canvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  };
}
function stationHit(event) {
  if (!stationState) return null;
  const point = stationEventPoint(event);
  for (let i = stationHits.length - 1; i >= 0; i--) {
    const hit = stationHits[i];
    const dx = hit.x - point.x;
    const dy = hit.y - point.y;
    if (dx * dx + dy * dy <= hit.r * hit.r) return { robot: hit.robot, room: hit.room };
  }
  const tile = stationTileAt(point.x, point.y);
  const room = stationState.rooms.find(item => tile.c >= item.c && tile.c < item.c + item.w && tile.r >= item.r && tile.r < item.r + item.h);
  if (!room) return null;
  return { robot: null, room: room };
}
function stationTipText(hit) {
  if (!hit) return "";
  if (hit.robot) return robotTitle(hit.robot);
  const room = hit.room;
  if (room.kind === "lab") return stationState.labTip;
  if (room.kind === "exchange") return stationState.exchangeTip;
  if (room.kind === "vault") return stationState.vaultTip;
  const group = stationState.byId.get(room.groupId);
  const notes = stationState.groupNotes.get(room.groupId);
  const bits = ["Group " + room.groupId];
  if (!group) bits.push("no roster in this snapshot");
  else {
    bits.push("leader " + clusterLeaderLabel(group));
    bits.push(group.robots.length + " named");
    if (room.unnamed) bits.push(room.unnamed + " not named");
  }
  if (!notes || notes.missing) bits.push("group notes —");
  else if (!notes.notes.length) bits.push("no group notes");
  else bits.push(notes.notes.length + " notes · " + formatNote(notes.notes[0]));
  return bits.join(" · ");
}
function onStationPointer(event) {
  const tip = document.getElementById("station-tip");
  const canvas = document.getElementById("station-canvas");
  const hit = stationHit(event);
  if (canvas) canvas.style.cursor = hit && hit.robot ? "pointer" : "default";
  if (!tip) return;
  if (!hit) {
    tip.hidden = true;
    return;
  }
  tip.hidden = false;
  tip.textContent = stationTipText(hit);
  const stage = document.getElementById("station-stage");
  const rect = stage.getBoundingClientRect();
  tip.style.left = Math.min(event.clientX - rect.left + 12, Math.max(8, rect.width - 240)) + "px";
  tip.style.top = Math.min(event.clientY - rect.top + 12, Math.max(8, rect.height - 36)) + "px";
}
function bindStationPointer() {
  if (stationPointerBound) return;
  const canvas = document.getElementById("station-canvas");
  if (!canvas) return;
  stationPointerBound = true;
  canvas.addEventListener("pointermove", onStationPointer);
  canvas.addEventListener("pointerleave", () => {
    const tip = document.getElementById("station-tip");
    if (tip) tip.hidden = true;
  });
  canvas.addEventListener("click", event => {
    const hit = stationHit(event);
    if (hit && hit.robot) openRobot(hit.robot);
  });
}
function showView(name) {
  const stationOn = name !== "network";
  const station = document.getElementById("station");
  const groups = document.getElementById("groups");
  const tabStation = document.getElementById("tab-station");
  const tabNetwork = document.getElementById("tab-network");
  if (station) station.hidden = !stationOn;
  if (groups) groups.hidden = stationOn;
  if (tabStation) {
    tabStation.classList.toggle("on", stationOn);
    tabStation.setAttribute("aria-selected", stationOn ? "true" : "false");
  }
  if (tabNetwork) {
    tabNetwork.classList.toggle("on", !stationOn);
    tabNetwork.setAttribute("aria-selected", stationOn ? "false" : "true");
  }
  if (stationOn) {
    if (stationState) {
      drawStation(performance.now());
      ensureStationLoop();
    }
    return;
  }
  if (typeof layoutOrbs === "function") layoutOrbs();
  if (prefersReducedMotion()) drawFrame(performance.now());
  else if (typeof ensureLoop === "function") ensureLoop();
}
function bindStationTabs() {
  const station = document.getElementById("tab-station");
  const network = document.getElementById("tab-network");
  if (station) station.addEventListener("click", () => showView("station"));
  if (network) network.addEventListener("click", () => showView("network"));
}
function renderStation(bundle) {
  const panel = document.getElementById("station");
  if (!panel) return;
  stationState = buildStationState(bundle);
  layoutStationCanvas(stationState.rooms, stationState.halls);
  renderStationHud(stationState);
  bindStationPointer();
  drawStation(performance.now());
  if (!panel.hidden) ensureStationLoop();
}
bindStationTabs();
