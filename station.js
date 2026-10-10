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
function looseObject(raw) {
  if (raw && typeof raw === "object") return raw;
  if (!present(raw)) return null;
  try { return JSON.parse(String(raw)); } catch (err) { return null; }
}
function boundsFromText(raw) {
  const parsed = looseObject(raw);
  if (parsed && parsed.bounds && typeof parsed.bounds === "object" && !Array.isArray(parsed.bounds)) return parsed.bounds;
  const match = /"bounds"\s*:\s*\{([^}]*)\}/.exec(String(raw || ""));
  if (!match) return null;
  const bounds = {};
  const re = /"([^"]+)"\s*:\s*\[([^\]]*)\]/g;
  let found = re.exec(match[1]);
  while (found) {
    bounds[found[1]] = "[" + found[2].trim() + "]";
    found = re.exec(match[1]);
  }
  return bounds;
}
function ideasFromText(raw) {
  const parsed = looseObject(raw);
  const list = parsed && (parsed.signal_ideas || parsed.idea_directions || parsed.directions || parsed.suggestions);
  if (Array.isArray(list)) {
    return list.map(item => ({
      name: item && (item.name || item.id) || "",
      direction: item && (item.direction || item.action) || "",
      note: item && (item.note || item.text || item.summary) || ""
    }));
  }
  const ideas = [];
  const re = /"name"\s*:\s*"([^"]+)"\s*,\s*"direction"\s*:\s*"([^"]+)"(?:\s*,\s*"note"\s*:\s*"([^"]*))?/g;
  const text = String(raw || "");
  let found = re.exec(text);
  while (found) {
    ideas.push({ name: found[1], direction: found[2], note: found[3] || "" });
    found = re.exec(text);
  }
  return ideas;
}
function rejectList(raw) {
  if (Array.isArray(raw)) return raw.map(item => String(item)).filter(Boolean);
  if (!present(raw)) return [];
  const parsed = looseObject(raw);
  if (Array.isArray(parsed)) return parsed.map(item => String(item)).filter(Boolean);
  const text = String(raw).trim();
  if (!text || text === "[]") return [];
  return [text];
}
function reviewCalls(llm) {
  const calls = (llm && Array.isArray(llm.calls)) ? llm.calls.slice() : [];
  const tagged = calls.filter(call => present(call.kind) || present(call.role) || present(call.type));
  if (!tagged.length) return { calls: calls, source: "llm.calls" };
  const reviews = calls.filter(call => /review|supervisor/i.test(String(call.kind || call.role || call.type || "")));
  if (reviews.length) return { calls: reviews, source: "llm.calls review" };
  return { calls: calls, source: "llm.calls" };
}
function newestCall(calls) {
  if (!calls.length) return null;
  return calls.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
}
function flightStatus(call) {
  if (!call) return null;
  if (call.in_flight === true || call.reviewing === true) return true;
  if (call.in_flight === false || call.reviewing === false) return false;
  const status = String(call.status || "").toLowerCase();
  if (!status) return null;
  if (/^(running|in_progress|in-progress|pending|started|queued|working)$/.test(status)) return true;
  return false;
}
function appliedBounds(call, bounds) {
  if (!call) return null;
  if (typeof call.applied === "boolean") return call.applied;
  if (typeof call.applied_changes === "boolean") return call.applied_changes;
  const status = String(call.status || call.decision || "").toLowerCase();
  if (!status) return null;
  const count = bounds && typeof bounds === "object" ? Object.keys(bounds).length : 0;
  if (status === "accepted") return count > 0;
  if (/reject|fail|error|denied/.test(status)) return false;
  return null;
}
function writerPause(health, scoreboard, llm) {
  const bags = [
    ["health", health],
    ["health.llm", health && health.llm],
    ["ai_scoreboard", scoreboard],
    ["llm", llm]
  ];
  const keys = ["writer_paused", "memory_guard", "review_hold", "writer_hold", "paused"];
  for (let i = 0; i < bags.length; i++) {
    const bag = bags[i][1];
    if (!bag || typeof bag !== "object") continue;
    for (let k = 0; k < keys.length; k++) {
      const value = bag[keys[k]];
      if (value === true) return "yes · " + bags[i][0] + "." + keys[k];
      if (value === false) return "no · " + bags[i][0] + "." + keys[k];
      if (present(value) && typeof value !== "object") return String(value) + " · " + bags[i][0] + "." + keys[k];
    }
  }
  return null;
}
function promptVariant(scoreboard, health, call) {
  if (scoreboard && present(scoreboard.prompt_id)) return { id: String(scoreboard.prompt_id), key: "ai_scoreboard.prompt_id" };
  if (health && present(health.prompt_id)) return { id: String(health.prompt_id), key: "health.prompt_id" };
  if (call && present(call.prompt_id)) return { id: String(call.prompt_id), key: "llm.calls.prompt_id" };
  if (call && present(call.prompt_variant)) return { id: String(call.prompt_variant), key: "llm.calls.prompt_variant" };
  return null;
}
function readReview(health, llm, scoreboard) {
  let call = null;
  let source = "llm.calls";
  const pocket = health && health.llm;
  if (pocket && typeof pocket === "object" && !Array.isArray(pocket)) {
    if (pocket.review && typeof pocket.review === "object") {
      call = pocket.review;
      source = "health.llm.review";
    } else if (present(pocket.created_at) || present(pocket.status) || present(pocket.decision) || present(pocket.reasoning)) {
      call = pocket;
      source = "health.llm";
    }
  }
  if (!call) {
    const pool = reviewCalls(llm);
    call = newestCall(pool.calls);
    source = pool.source;
  }
  if (!call) {
    return {
      source: "—",
      time: null,
      decision: null,
      reasoning: null,
      bounds: null,
      ideas: [],
      rejected: [],
      applied: null,
      inFlight: null,
      paused: writerPause(health, scoreboard, llm),
      prompt: promptVariant(scoreboard, health, null),
      model: null,
      provider: null
    };
  }
  const bounds = boundsFromText(call.accepted != null ? call.accepted : call);
  const ideas = ideasFromText(call.accepted != null ? call.accepted : call);
  const reasoning = ideaFromAccepted(call.accepted != null ? call.accepted : (call.reasoning || call.summary || ""));
  const decision = present(call.decision) ? String(call.decision) : (present(call.status) ? String(call.status) : null);
  return {
    source: source,
    time: present(call.created_at) ? String(call.created_at) : (present(call.time) ? String(call.time) : null),
    decision: decision,
    reasoning: reasoning || null,
    bounds: bounds,
    ideas: ideas,
    rejected: rejectList(call.reject_reasons),
    applied: appliedBounds(call, bounds),
    inFlight: flightStatus(call),
    paused: writerPause(health, scoreboard, llm),
    prompt: promptVariant(scoreboard, health, call),
    model: present(call.model) ? String(call.model) : null,
    provider: present(call.provider) ? String(call.provider) : null
  };
}
function recordGroup(item) {
  if (!item || typeof item !== "object") return null;
  const keys = ["group_id", "group", "source_group"];
  for (let i = 0; i < keys.length; i++) {
    if (present(item[keys[i]]) || item[keys[i]] === 0) return String(item[keys[i]]);
  }
  return null;
}
function codeSeatList(agents, archive, scoreboard) {
  const fromBoard = [];
  (agents || []).forEach(agent => {
    const strategy = readCodeStrategy(agent);
    if (!strategy) return;
    fromBoard.push({
      id: agent.agent_id || "code",
      name: agent.agent_id || "—",
      source: "leaderboard",
      groupId: present(agent.group_id) || agent.group_id === 0 ? String(agent.group_id) : null,
      description: strategy.description,
      windows: null,
      unseen: agent.oos_net
    });
  });
  if (fromBoard.length) return { source: "leaderboard.code", seats: fromBoard };
  const top = archive && Array.isArray(archive.top) ? archive.top : null;
  if (top && top.length) {
    return {
      source: "idea_archive.top",
      seats: top.map((item, index) => ({
        id: "archive-" + index,
        name: item.name || item.hypothesis || "—",
        source: "idea_archive",
        groupId: recordGroup(item),
        description: item.hypothesis || item.name || "—",
        windows: item.windows,
        unseen: item.unseen_net,
        mode: item.mode || ""
      }))
    };
  }
  const nets = scoreboard && Array.isArray(scoreboard.window_nets) ? scoreboard.window_nets : null;
  if (nets && nets.length) {
    return {
      source: "ai_scoreboard.window_nets",
      seats: nets.map((item, index) => ({
        id: "scoreboard-" + index,
        name: item.name || "—",
        source: "ai_scoreboard",
        groupId: recordGroup(item),
        description: item.name || "—",
        windows: Array.isArray(item.nets) ? item.nets.length : null,
        unseen: null
      }))
    };
  }
  return { source: "—", seats: [] };
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
  rooms.push({ id: "bridge", kind: "bridge", c: 8, r: 8, w: 8, h: 3 });
  rooms.push({ id: "exchange", kind: "exchange", c: 0, r: 13, w: 8, h: 4 });
  rooms.push({ id: "lab", kind: "lab", c: 8, r: 13, w: 8, h: 4 });
  rooms.push({ id: "vault", kind: "vault", c: 16, r: 13, w: 8, h: 4 });
  cols.forEach((c, index) => rooms.push({ id: "g" + (index + 10), kind: "team", groupId: String(index + 10), c: c, r: 19, w: 4, h: 3 }));
  cols.forEach((c, index) => rooms.push({ id: "g" + (index + 15), kind: "team", groupId: String(index + 15), c: c, r: 24, w: 4, h: 3 }));
  return rooms;
}
function hallFor(room) {
  const tiles = [];
  const mid = room.c + Math.floor(room.w / 2);
  if (room.r < 8) {
    tiles.push({ c: mid, r: room.r + room.h, ids: [room.groupId] });
    tiles.push({ c: mid, r: room.r + room.h + 1, ids: [room.groupId] });
  } else if (room.r >= 19) {
    tiles.push({ c: mid, r: room.r - 1, ids: [room.groupId] });
    tiles.push({ c: mid, r: room.r - 2, ids: [room.groupId] });
  }
  if (room.c < 20) {
    tiles.push({ c: room.c + room.w, r: room.r + 1, ids: [room.groupId, String(Number(room.groupId) + 1)] });
  }
  return tiles;
}
function tileInsideRoom(rooms, c, r) {
  return rooms.some(room => c >= room.c && r >= room.r && c < room.c + room.w && r < room.r + room.h);
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
  if (kind === "bridge") return { floor: "#2a2148", edge: "#e2c56a" };
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
  if (hex === "#2a2148") return "#231c3c";
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
function pixelLine(ctx, x0, y0, x1, y1, color) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xEnd = Math.round(x1);
  const yEnd = Math.round(y1);
  const dx = Math.abs(xEnd - x);
  const dy = Math.abs(yEnd - y);
  const sx = x < xEnd ? 1 : -1;
  const sy = y < yEnd ? 1 : -1;
  let err = dx - dy;
  ctx.fillStyle = color;
  for (let n = 0; n < 900; n++) {
    ctx.fillRect(x, y, 1, 1);
    if (x === xEnd && y === yEnd) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
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
function drawCaptain(ctx, x, y, pose) {
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x - 8, y, 16, 3);
  ctx.fillStyle = "#c8b48a";
  ctx.fillRect(x - 5, y - 8, 4, 8);
  ctx.fillRect(x + 1, y - 8, 4, 8);
  if (!pose.work && pose.step) ctx.fillRect(x - 8, y - 4, 3, 3);
  else if (!pose.work && !pose.idle) ctx.fillRect(x + 5, y - 4, 3, 3);
  ctx.fillStyle = "#1e2a3c";
  ctx.fillRect(x - 8, y - 20, 16, 12);
  ctx.fillStyle = "#f0c14a";
  ctx.fillRect(x - 8, y - 20, 16, 2);
  ctx.fillRect(x - 1, y - 18, 2, 8);
  ctx.fillStyle = "#8aa0aa";
  if (pose.work) {
    ctx.fillRect(x - 14, y - 18, 6, 3);
    ctx.fillRect(x + 8, y - 18, 6, 3);
  } else {
    ctx.fillRect(x - 12, y - 18, 4, 6);
    ctx.fillRect(x + 8, y - 18, 4, 6);
  }
  ctx.fillStyle = "#f4fbff";
  ctx.fillRect(x - 5, y - 28, 10, 8);
  ctx.fillStyle = "#7ef6e4";
  ctx.fillRect(x - 5, y - 26, 10, 3);
  ctx.fillStyle = "#f0c14a";
  ctx.fillRect(x - 6, y - 31, 12, 3);
  ctx.fillRect(x - 9, y - 29, 4, 2);
}
function captainPose(now, reduced, inFlight) {
  if (reduced) return { step: 0, work: inFlight ? 1 : 0, shift: 0, idle: inFlight ? 0 : 1 };
  if (inFlight) return { step: 0, work: 1, shift: 0, idle: 0 };
  const t = now / 1000;
  const walking = (t % 8) < 4;
  return {
    step: walking ? (Math.floor(t * 6) % 2) : 0,
    work: 0,
    shift: walking ? Math.sin(t * 2.2) * 12 : 0,
    idle: walking ? 0 : 1
  };
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
    if (room.kind === "bridge") drawConsole(ctx, room.c + 3, room.r + 1, "#e2c56a");
    if (room.kind === "lab") drawConsole(ctx, room.c + 3, room.r + 1, "#7ef6e4");
    if (room.kind === "exchange") {
      STATION_COINS.forEach((coin, index) => drawConsole(ctx, room.c + 1 + index, room.r + 1, "#e2b15a"));
    }
    if (room.kind === "vault") drawConsole(ctx, room.c + 3, room.r + 1, "#8fd4ff");
  });
  if (state.review && state.review.applied === true) {
    const bridgeRoom = state.rooms.find(room => room.kind === "bridge");
    if (bridgeRoom) {
      const from = isoOf(bridgeRoom.c + bridgeRoom.w / 2, bridgeRoom.r + bridgeRoom.h - 0.15);
      const color = reduced ? "#7ef6e4" : (pulse > 0.55 ? "#d8fff6" : "#3ecfb8");
      state.rooms.forEach(room => {
        if (room.kind !== "lab" && room.kind !== "team") return;
        const to = isoOf(room.c + room.w / 2, room.r + 0.25);
        pixelLine(ctx, from.x, from.y, to.x, to.y, color);
      });
    }
  }
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
  const bridge = state.rooms.find(room => room.kind === "bridge");
  const lab = state.rooms.find(room => room.kind === "lab");
  const exchange = state.rooms.find(room => room.kind === "exchange");
  const vault = state.rooms.find(room => room.kind === "vault");
  if (bridge && state.review) {
    const pose = captainPose(now, reduced, state.review.inFlight === true);
    const foot = pose.work
      ? isoOf(bridge.c + 3.7, bridge.r + 1.85)
      : isoOf(bridge.c + bridge.w / 2, bridge.r + 1.7);
    drawCaptain(ctx, foot.x + pose.shift, foot.y, pose);
    stationHits.push({ x: foot.x + pose.shift, y: foot.y - 14, r: 18, robot: null, captain: true, room: bridge });
    const plate = isoOf(bridge.c + bridge.w / 2, bridge.r + bridge.h - 0.2);
    plateText(ctx, "BRIDGE", plate.x, plate.y + 14, "#e2c56a");
  }
  const mappedSeats = state.codeSource === "leaderboard.code" ? [] : (state.codeSeats || []);
  const looseSeats = mappedSeats.filter(seat => seat.groupId == null).slice(0, 5);
  const groupedSeats = mappedSeats.filter(seat => seat.groupId != null);
  if (lab) {
    looseSeats.forEach((seat, index) => {
      const pose = crewPose(seat.id, now, reduced);
      const p = isoOf(lab.c + 1.2 + index, lab.r + lab.h - 1.15);
      drawCrew(ctx, p.x + pose.shift, p.y, pose, { codeStrategy: seat, leader: false, hasFills: false });
      stationHits.push({ x: p.x + pose.shift, y: p.y - 6, r: 10, robot: null, codeSeat: seat, room: lab });
    });
  }
  groupedSeats.forEach(seat => {
    const room = state.rooms.find(item => item.kind === "team" && item.groupId === seat.groupId);
    if (!room) return;
    const pose = crewPose(seat.id, now, reduced);
    const p = isoOf(room.c + room.w - 1.2, room.r + 1.4);
    drawCrew(ctx, p.x + pose.shift, p.y, pose, { codeStrategy: seat, leader: false, hasFills: false });
    stationHits.push({ x: p.x + pose.shift, y: p.y - 6, r: 10, robot: null, codeSeat: seat, room: room });
  });
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
    if (room.kind !== "team") return;
    hallFor(room).forEach(tile => {
      if (!tileInsideRoom(rooms, tile.c, tile.r)) halls.push(tile);
    });
  });
  const bridgeRoom = rooms.find(room => room.kind === "bridge");
  if (bridgeRoom) {
    const mid = bridgeRoom.c + Math.floor(bridgeRoom.w / 2);
    halls.push({ c: mid, r: bridgeRoom.r + bridgeRoom.h, ids: [] });
    halls.push({ c: mid, r: bridgeRoom.r + bridgeRoom.h + 1, ids: [] });
  }
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
  const codeMap = codeSeatList(agents, archive, scoreboard);
  const review = readReview(health, bundle.llm, scoreboard);
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

  let codeBody = "<p>leaderboard code rows: " + (installed.length ? String(installed.length) : "none") + "</p>";
  codeBody += "<p>seats " + escapeHtml(codeMap.source) + "</p>";
  codeBody += "<p>generation n_code " + escapeHtml(present(summary.n_code) ? String(summary.n_code) : "—") + "</p>";
  if (!codeMap.seats.length) codeBody += "<p>code seats —</p>";
  codeMap.seats.slice(0, 5).forEach(seat => {
    const windows = present(seat.windows) ? seat.windows + "/" + gate : "—";
    const net = present(seat.unseen) ? netText(seat.unseen) : "—";
    const group = seat.groupId == null ? "group —" : "G" + seat.groupId;
    codeBody += "<p>" + escapeHtml(seat.name) + " · " + escapeHtml(windows) + " · " + escapeHtml(net) + " · " + escapeHtml(group) + "</p>";
  });

  let yesBody = "<p>health.side_bias —</p>";
  if (split) {
    const noShare = split.share == null ? null : 1 - split.share;
    yesBody = "<p>health.side_bias</p><p>YES " + escapeHtml(stationPct(split.share)) + " · NO " + escapeHtml(stationPct(noShare)) + "</p><p>max " + escapeHtml(present(split.max) ? split.max : "—") + "</p>";
  }
  const groupDiversity = Array.isArray(summary.group_diversity) ? summary.group_diversity.length + " groups" : "—";
  const diversityBody = [
    "<p>health.diversity " + escapeHtml(stationNum(health.diversity, 4)) + "</p>",
    "<p>health.n_behavior_clusters " + escapeHtml(present(health.n_behavior_clusters) ? String(health.n_behavior_clusters) : "—") + "</p>",
    "<p>health.largest_cluster_share " + escapeHtml(stationPct(health.largest_cluster_share)) + "</p>",
    "<p>summary.diversity " + escapeHtml(stationNum(summary.diversity, 4)) + "</p>",
    "<p>summary.next_diversity " + escapeHtml(stationNum(summary.next_diversity, 4)) + "</p>",
    "<p>summary.largest_cluster_share " + escapeHtml(stationPct(summary.largest_cluster_share)) + "</p>",
    "<p>summary.next_largest_cluster_share " + escapeHtml(stationPct(summary.next_largest_cluster_share)) + "</p>",
    "<p>summary.n_behavior_clusters " + escapeHtml(present(summary.n_behavior_clusters) ? String(summary.n_behavior_clusters) : "—") + "</p>",
    "<p>summary.group_diversity " + escapeHtml(groupDiversity) + "</p>"
  ].join("");
  const publish = (bundle.manifest && present(bundle.manifest.published_at)) ? bundle.manifest.published_at : "—";
  const healthBody = "<p>RSS " + escapeHtml(stationNum(health.mem_rss_mb, 0)) + " / free " + escapeHtml(stationNum(health.mem_available_mb, 0)) + " MB</p>"
    + "<p>spot lag " + escapeHtml(stationNum(health.spot_lag_s, 1) === "—" ? "—" : stationNum(health.spot_lag_s, 1) + "s") + " · " + escapeHtml(present(health.spot_source) ? health.spot_source : "—") + "</p>"
    + "<p>published " + escapeHtml(publish) + "</p>";

  const rightHtml = [
    hudCard("Code strategies", present(summary.n_code) ? escapeHtml(summary.n_code) : (installed.length ? String(installed.length) : "—"), codeBody),
    hudCard("YES / NO", split ? escapeHtml(stationPct(split.share)) : "—", yesBody),
    hudCard("Diversity", escapeHtml(stationNum(health.diversity, 4)), diversityBody),
    hudCard("Health", escapeHtml(stationNum(health.mem_rss_mb, 0)), healthBody)
  ].join("");

  const appliedText = review.applied === true ? "yes" : (review.applied === false ? "no" : "—");
  const flightText = review.inFlight === true ? "yes" : (review.inFlight === false ? "no" : "—");
  let bridgeHtml = "<div class='room-card'><div class='label'>Command bridge</div><div class='metric'>" + escapeHtml(review.decision || "—") + "</div>";
  bridgeHtml += "<p>" + escapeHtml(review.time || "—") + "</p>";
  bridgeHtml += "<p>model " + escapeHtml(review.model || "—") + (review.provider ? " · " + escapeHtml(review.provider) : "") + "</p>";
  bridgeHtml += "<p>prompt " + escapeHtml(review.prompt ? review.prompt.key + " " + review.prompt.id : "—") + "</p>";
  bridgeHtml += "<p>writer paused " + escapeHtml(review.paused || "—") + "</p>";
  bridgeHtml += "<p>in flight " + flightText + " · applied " + appliedText + "</p>";
  bridgeHtml += "<p>" + escapeHtml(review.source) + "</p>";
  bridgeHtml += "<p>" + escapeHtml(review.reasoning ? stationClip(review.reasoning, 180) : "reasoning —") + "</p>";
  const suggestionLines = [];
  if (review.bounds && Object.keys(review.bounds).length) {
    Object.keys(review.bounds).forEach(name => {
      const value = review.bounds[name];
      const text = Array.isArray(value) ? "[" + value.join(", ") + "]" : String(value);
      suggestionLines.push("applied " + name + " " + text);
    });
  }
  review.ideas.forEach(item => {
    const note = item.note ? " · " + item.note : "";
    suggestionLines.push("queued " + (item.name || "—") + " " + (item.direction || "—") + note);
  });
  review.rejected.forEach(reason => suggestionLines.push("rejected · " + reason));
  if (!suggestionLines.length) bridgeHtml += "<p>suggestions —</p>";
  suggestionLines.slice(0, 4).forEach(line => {
    bridgeHtml += "<p>" + escapeHtml(stationClip(line, 140)) + "</p>";
  });
  bridgeHtml += "</div>";

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
    + " · " + escapeHtml(present(health.spot_source) ? health.spot_source : "—") + "</p>";
  exHtml += "<p>per-coin Kraken spot —</p></div>";

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
    roomHtml: bridgeHtml + labHtml + exHtml + vaultHtml,
    legend: "The command bridge is the latest llm.calls review. The captain stands at the console only while that review is in flight, and walks or idles otherwise. Cyan lines light only when its status is accepted and bounds are non-empty. Purple crew are code strategies from leaderboard code, or from idea_archive.top when no leaderboard row sets code. Archive seats have no group id. Amber halls are group notes. Gray halls are the floor. Walking is decoration, not a trade.",
    unseen: unseen,
    labMark: labMark,
    vaultMark: vaultMark,
    review: review,
    codeSeats: codeMap.seats,
    codeSource: codeMap.source,
    groupDiversity: Array.isArray(summary.group_diversity) ? summary.group_diversity : null,
    labTip: "AI lab. Drafts per hour " + drafts + ". Pass rate " + pass + ". " + (ideaText || "Current idea —"),
    exchangeTip: "Exchange. Kalshi yes bid/ask and strike from health.markets. Per-coin Kraken spot is — until a market has kraken_spot or spot, or health.kraken has the coin.",
    vaultTip: "Vault. Graduates " + (grads == null ? "—" : grads) + ". Gate " + gate + " windows.",
    bridgeTip: "Command bridge. " + (review.decision || "decision —") + ". " + (review.time || "time —") + ". model " + (review.model || "—") + ". in flight " + flightText + ". applied " + appliedText + "."
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
    if (dx * dx + dy * dy <= hit.r * hit.r) return { robot: hit.robot, room: hit.room, captain: hit.captain, codeSeat: hit.codeSeat };
  }
  const tile = stationTileAt(point.x, point.y);
  const room = stationState.rooms.find(item => tile.c >= item.c && tile.c < item.c + item.w && tile.r >= item.r && tile.r < item.r + item.h);
  if (!room) return null;
  return { robot: null, room: room };
}
function stationTipText(hit) {
  if (!hit) return "";
  if (hit.robot) return robotTitle(hit.robot);
  if (hit.captain) return stationState.bridgeTip;
  if (hit.codeSeat) {
    const seat = hit.codeSeat;
    const group = seat.groupId == null ? "group —" : "group " + seat.groupId;
    return seat.source + " · " + seat.name + " · " + group + " · " + (present(seat.description) ? seat.description : "—");
  }
  const room = hit.room;
  if (room.kind === "bridge") return stationState.bridgeTip;
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
  const diversityRows = stationState.groupDiversity;
  if (!Array.isArray(diversityRows)) bits.push("summary.group_diversity —");
  else {
    const row = diversityRows.find(item => String(item.group) === String(room.groupId));
    if (!row) bits.push("summary.group_diversity —");
    else {
      bits.push("diversity " + stationNum(row.diversity, 4));
      bits.push("largest " + stationPct(row.largest_cluster_share));
      bits.push("clusters " + (present(row.n_clusters) ? row.n_clusters : "—"));
    }
  }
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
