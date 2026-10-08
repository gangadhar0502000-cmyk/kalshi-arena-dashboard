const cfg = window.ARENA_CONFIG || {};
const FILES = ["manifest.json", "health.json", "generations.json", "leaderboard.json", "trades.json", "llm.json"];
let publishedUnix = 0;
let selectedId = "";
let latestTrades = [];
let latestAgents = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
function num(value, digits) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits === undefined ? 3 : digits);
}
function scoreText(value) {
  if (value === null || value === undefined || value === "") return "missing";
  const number = Number(value);
  if (!Number.isFinite(number) || number <= -1000) return "—";
  return number.toFixed(4);
}
function present(value) {
  return value !== null && value !== undefined && value !== "";
}
function scrubMetrics(metrics) {
  const copy = Object.assign({}, metrics || {});
  ["score", "display_score"].forEach(key => {
    if (typeof copy[key] === "number" && Number.isFinite(copy[key]) && copy[key] <= -1000) copy[key] = "hidden";
  });
  return copy;
}
function chartValue(row, key) {
  const value = row.summary && row.summary[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= -1000 && !String(key).includes("net")) return null;
  return value;
}
function statusLabel(agent, metrics) {
  const label = (agent && agent.status) || (metrics && metrics.status) || "";
  if (label) return label;
  if (metrics && metrics.eligible) return "eligible";
  const windows = metrics && Array.isArray(metrics.window_returns) ? metrics.window_returns.length : 0;
  const trades = metrics && metrics.n_round_trips != null ? metrics.n_round_trips : 0;
  return `warming up (${windows}/4 windows, ${trades}/30 trades)`;
}
function card(label, value) {
  return `<div class="panel"><div class="label">${escapeHtml(label)}</div><div class="metric">${value}</div></div>`;
}
function setMessage(text) {
  document.getElementById("message").textContent = text;
}

async function loadSnapshot() {
  const ownerName = cfg.gistOwner;
  if (!ownerName || String(ownerName).startsWith("REPLACE")) {
    throw new Error("Set gistOwner in config.js to the GitHub user that owns the gist. The page does not call api.github.com.");
  }
  const stamp = Date.now();
  const parsed = {};
  await Promise.all(FILES.map(async name => {
    const raw = `https://gist.githubusercontent.com/${encodeURIComponent(ownerName)}/${encodeURIComponent(cfg.gistId)}/raw/${encodeURIComponent(name)}?t=${stamp}`;
    const response = await fetch(raw, { cache: "no-store" });
    if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
    parsed[name] = await response.json();
  }));
  return parsed;
}

function renderMarkets(markets) {
  const host = document.getElementById("markets");
  if (!markets || !markets.length) {
    host.innerHTML = "<p class='sub'>No open market snapshot yet.</p>";
    return;
  }
  const now = Date.now() / 1000;
  host.innerHTML = markets.map(market => {
    const left = market.close_ts ? Math.max(0, Math.round(market.close_ts - now)) : null;
    const clock = left == null ? "—" : Math.floor(left / 60) + "m " + (left % 60) + "s";
    const bids = (market.yes_bids || []).map(level => escapeHtml(level[0]) + " × " + escapeHtml(level[1])).join("<br>") || "—";
    const asks = (market.yes_asks || []).map(level => escapeHtml(level[0]) + " × " + escapeHtml(level[1])).join("<br>") || "—";
    return `<div class="panel"><div class="label">${escapeHtml(market.ticker)}</div>
      <div class="metric">${clock}</div>
      <p class="sub">to expiry · strike ${escapeHtml(market.floor_strike ?? "—")} · ${escapeHtml(market.status || "")}</p>
      <p>YES bid ${escapeHtml(market.yes_bid ?? "—")} · YES ask ${escapeHtml(market.yes_ask ?? "—")}</p>
      <p class="sub">Bid depth<br>${bids}</p>
      <p class="sub">Ask depth (from NO bids)<br>${asks}</p></div>`;
  }).join("");
}

function drawChart(rows) {
  const canvas = document.getElementById("chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!rows.length) {
    ctx.fillStyle = "#a3b39a";
    ctx.fillText("No generations yet", 16, 28);
    return;
  }
  const dollars = rows.some(row => row.summary && row.summary.median_is_net !== undefined && row.summary.median_is_net !== null);
  const series = dollars ? [
    { key: "best_is_net", color: "#8fbf7a", dash: [] },
    { key: "median_is_net", color: "#e2b15a", dash: [] },
    { key: "best_oos_net", color: "#8eb6c9", dash: [6, 4] },
    { key: "median_oos_net", color: "#d7d3c2", dash: [6, 4] }
  ] : [
    { key: "best_is", color: "#8fbf7a", dash: [] },
    { key: "median_is", color: "#e2b15a", dash: [] },
    { key: "worst_is", color: "#d4674c", dash: [] },
    { key: "best_oos", color: "#8eb6c9", dash: [6, 4] },
    { key: "median_oos", color: "#d7d3c2", dash: [6, 4] }
  ];
  const vals = [];
  rows.forEach(row => series.forEach(item => {
    const value = chartValue(row, item.key);
    if (value !== null) vals.push(value);
  }));
  if (!vals.length) {
    ctx.fillStyle = "#a3b39a";
    ctx.fillText("No scores yet", 16, 28);
    return;
  }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = (hi - lo) || 1;
  series.forEach(item => {
    ctx.beginPath();
    ctx.strokeStyle = item.color;
    ctx.setLineDash(item.dash);
    rows.forEach((row, index) => {
      const value = chartValue(row, item.key);
      if (value === null) return;
      const x = 30 + (rows.length === 1 ? 0 : index * (w - 50) / (rows.length - 1));
      const y = 20 + (1 - (value - lo) / span) * (h - 40);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.fillStyle = "#a3b39a";
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillText(dollars
    ? "dollars: green best selection  amber median selection  blue that agent's holdout  gray median holdout"
    : "green best IS  amber median IS  red worst IS  blue best OOS", 16, h - 8);
}

function drawEquity(points) {
  const canvas = document.getElementById("equity");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!points || !points.length) return;
  const ys = points.map(point => point[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = (hi - lo) || 1;
  ctx.beginPath();
  ctx.strokeStyle = "#e2b15a";
  points.forEach((point, index) => {
    const x = 10 + index * (canvas.width - 20) / Math.max(1, points.length - 1);
    const y = 10 + (1 - (point[1] - lo) / span) * (canvas.height - 20);
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function showAgent(agent) {
  selectedId = agent.agent_id;
  const ism = agent.is_metrics || {};
  document.getElementById("agent-title").textContent =
    agent.agent_id + " · " + (agent.origin || "") + " · " + statusLabel(agent, ism);
  document.getElementById("genome").textContent =
    statusLabel(agent, ism) + "\n\n" +
    JSON.stringify(agent.genome || {}, null, 2) +
    "\n\nselection metrics\n" + JSON.stringify(scrubMetrics(ism), null, 2) +
    "\n\nholdout metrics\n" + JSON.stringify(scrubMetrics(agent.oos_metrics || {}), null, 2);
  drawEquity(agent.equity || []);
  renderTrades(latestTrades.filter(trade => trade.agent_id === agent.agent_id));
  document.querySelectorAll("#board tbody tr").forEach(row => {
    row.classList.toggle("on", row.dataset.id === agent.agent_id);
  });
}

function renderTrades(trades) {
  const body = document.querySelector("#trades tbody");
  body.innerHTML = "";
  if (!trades.length) {
    body.innerHTML = "<tr><td colspan='10'>No simulated fills in this snapshot.</td></tr>";
    return;
  }
  trades.forEach(trade => {
    const tr = document.createElement("tr");
    const when = trade.ts ? new Date(trade.ts * 1000).toISOString().slice(11, 19) : "";
    const outcome = trade.market_result ? `${trade.market_result} @ ${trade.settlement_value}` : "open";
    tr.innerHTML = `<td>${escapeHtml(when)}</td><td>${escapeHtml(trade.agent_id)}</td><td>${escapeHtml(trade.ticker)}</td><td>${escapeHtml(trade.action)} ${escapeHtml(trade.side)}</td><td>${escapeHtml(trade.liquidity)}</td><td>${escapeHtml(trade.qty)}</td><td>${escapeHtml(trade.fill_price)}</td><td>${escapeHtml(trade.fee)}</td><td>${num(trade.latency_s, 3)}s</td><td>${escapeHtml(outcome)}</td>`;
    body.appendChild(tr);
  });
}

const ORIGIN_LETTERS = { c: "crossover", m: "migrant", l: "llm", i: "immigrant", e: "elite" };
const KNOWN_ORIGINS = new Set(Object.values(ORIGIN_LETTERS));
let arenaSignature = "";
let noteFlights = [];
let flightToken = 0;
let noteEpoch = 0;

function parseAgentId(id) {
  const match = /^g(\d+)-g(\d+)-([a-z]+)(\d+)$/.exec(String(id || ""));
  if (!match) return null;
  return { generation: match[1], group: match[2], origin: ORIGIN_LETTERS[match[3]] || null };
}
function fieldText(record, key) {
  if (typeof record === "string") return key === "text" ? record : "missing";
  if (!record || typeof record !== "object" || !present(record[key])) return "missing";
  return String(record[key]);
}
function groupIdOf(agent) {
  const metrics = (agent && agent.is_metrics) || {};
  if (present(metrics.group_id)) return String(metrics.group_id);
  if (agent && present(agent.group_id)) return String(agent.group_id);
  return null;
}
function leaderFlag(agent) {
  const metrics = (agent && agent.is_metrics) || {};
  const raw = present(metrics.leader) ? metrics.leader : (agent && present(agent.leader) ? agent.leader : undefined);
  if (raw === true || raw === "yes" || raw === 1 || raw === "true") return true;
  if (raw === false || raw === "no" || raw === 0 || raw === "false") return false;
  return null;
}
function groupCell(agent) {
  const id = groupIdOf(agent);
  return id == null ? "missing" : id;
}
function leaderCell(agent) {
  const flag = leaderFlag(agent);
  return flag === null ? "missing" : (flag ? "yes" : "no");
}
function noteSourceGroup(note) {
  if (!note || typeof note !== "object") return null;
  const keys = ["group_id", "group", "source_group", "from_group", "publisher_group", "leader_group"];
  for (let i = 0; i < keys.length; i++) {
    if (present(note[keys[i]])) return String(note[keys[i]]);
  }
  return null;
}
function readSharedNotes(health, leaderboard, summary) {
  const healthNotes = health && health.summary && Array.isArray(health.summary.memory) ? health.summary.memory : null;
  const boardNotes = leaderboard && Array.isArray(leaderboard.memory) ? leaderboard.memory : null;
  const summaryNotes = summary && Array.isArray(summary.memory) ? summary.memory : null;
  if (healthNotes) {
    const differs = boardNotes && JSON.stringify(boardNotes) !== JSON.stringify(healthNotes);
    return { notes: healthNotes, where: "health.summary.memory", healthMissing: false, differs: differs };
  }
  if (boardNotes) return { notes: boardNotes, where: "leaderboard.memory", healthMissing: true, differs: false };
  if (summaryNotes) return { notes: summaryNotes, where: "the latest generation summary", healthMissing: true, differs: false };
  return { notes: null, where: "missing", healthMissing: true, differs: false };
}
function readLeaderMap(health, summary) {
  const healthMap = health && health.summary && health.summary.leaders;
  if (healthMap && typeof healthMap === "object" && !Array.isArray(healthMap)) {
    return { map: healthMap, where: "health.summary.leaders" };
  }
  if (summary && summary.leaders && typeof summary.leaders === "object" && !Array.isArray(summary.leaders)) {
    return { map: summary.leaders, where: "the latest generation summary" };
  }
  return { map: null, where: "missing" };
}
function compareGroup(a, b) {
  if (a === "missing") return 1;
  if (b === "missing") return -1;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}
function ensureGroup(groups, id) {
  const key = String(id);
  if (!groups.has(key)) groups.set(key, { id: key, robots: [], leaderId: null });
  return groups.get(key);
}
function buildArenaModel(agents, trades, leaderInfo, notes) {
  const groups = new Map();
  const leaderMap = leaderInfo && leaderInfo.map ? leaderInfo.map : null;
  if (leaderMap) {
    Object.keys(leaderMap).forEach(id => {
      const group = ensureGroup(groups, id);
      if (present(leaderMap[id])) group.leaderId = String(leaderMap[id]);
    });
  }
  (agents || []).forEach(agent => {
    const gid = groupIdOf(agent);
    const group = ensureGroup(groups, gid == null ? "missing" : gid);
    const id = present(agent.agent_id) ? String(agent.agent_id) : "missing";
    const flag = leaderFlag(agent);
    const mapped = !!(group.leaderId && group.leaderId === id);
    group.robots.push({
      id: id,
      origin: present(agent.origin) ? String(agent.origin) : "missing",
      leader: flag === true || mapped,
      leaderFlag: flag,
      mappedLeader: mapped,
      inBoard: true,
      hasFills: false,
      isScore: agent.is_score,
      oosScore: agent.oos_score,
      placeNote: "",
      agent: agent
    });
  });
  groups.forEach(group => {
    if (!group.leaderId || group.robots.some(robot => robot.id === group.leaderId)) return;
    const parsed = parseAgentId(group.leaderId);
    const placeNote = parsed && parsed.group !== String(group.id)
      ? "Leaders map places this id in group " + group.id + "; the agent id reads as group " + parsed.group + "."
      : "Leaderboard row is missing.";
    group.robots.push({
      id: group.leaderId,
      origin: parsed && parsed.origin ? parsed.origin : "missing",
      leader: true,
      leaderFlag: null,
      mappedLeader: true,
      inBoard: false,
      hasFills: false,
      isScore: undefined,
      oosScore: undefined,
      placeNote: placeNote,
      agent: null
    });
  });
  const seen = new Set();
  groups.forEach(group => group.robots.forEach(robot => seen.add(robot.id)));
  const fillIds = [];
  (trades || []).forEach(trade => {
    if (trade && present(trade.agent_id) && fillIds.indexOf(String(trade.agent_id)) === -1) fillIds.push(String(trade.agent_id));
  });
  fillIds.forEach(id => {
    let found = false;
    groups.forEach(group => {
      group.robots.forEach(robot => {
        if (robot.id === id) {
          robot.hasFills = true;
          found = true;
        }
      });
    });
    if (found || seen.has(id)) return;
    const parsed = parseAgentId(id);
    const group = ensureGroup(groups, parsed ? parsed.group : "missing");
    const mapped = group.leaderId === id;
    group.robots.push({
      id: id,
      origin: parsed && parsed.origin ? parsed.origin : "missing",
      leader: mapped,
      leaderFlag: null,
      mappedLeader: mapped,
      inBoard: false,
      hasFills: true,
      isScore: undefined,
      oosScore: undefined,
      placeNote: parsed ? "Group comes from the agent id. Leaderboard row is missing." : "Group is missing. Leaderboard row is missing.",
      agent: null
    });
    seen.add(id);
  });
  (notes || []).forEach(note => {
    const source = noteSourceGroup(note);
    if (source != null) ensureGroup(groups, source);
  });
  const list = Array.from(groups.values());
  list.forEach(group => {
    group.robots.sort((a, b) => {
      if (a.leader !== b.leader) return a.leader ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
  });
  list.sort((a, b) => compareGroup(a.id, b.id));
  return list;
}
function robotTitle(robot) {
  const bits = [robot.id || "agent id missing"];
  if (robot.mappedLeader && robot.leaderFlag === true) bits.push("leader");
  else if (robot.mappedLeader && robot.leaderFlag === false) bits.push("named leader; leader flag is no");
  else if (robot.mappedLeader) bits.push(robot.inBoard ? "named leader; leader flag missing" : "leader id");
  else if (robot.leaderFlag === true) bits.push("leader flag");
  else if (robot.leaderFlag === false) bits.push("not the leader");
  else bits.push("leader flag missing");
  bits.push(robot.origin === "missing" ? "origin missing" : robot.origin);
  bits.push("training " + scoreText(robot.isScore));
  bits.push("unseen " + scoreText(robot.oosScore));
  if (robot.placeNote) bits.push(robot.placeNote);
  if (robot.hasFills) bits.push("has simulated fills in this snapshot");
  return bits.join(" · ");
}
function staggerDelay(id) {
  let hash = 0;
  const text = String(id);
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) % 1700;
  return (hash / 1000).toFixed(2) + "s";
}
function formatNote(note) {
  if (typeof note === "string") return note || "missing";
  if (!note || typeof note !== "object") return "missing";
  return fieldText(note, "kind") + " " + fieldText(note, "pattern") + " (" + fieldText(note, "cost") + "): " + fieldText(note, "text");
}
function kindClass(kind) {
  if (kind === "worked" || kind === "failed") return kind;
  if (!kind || kind === "missing") return "missing";
  return "other";
}
function moneyText(summary, key) {
  if (!summary || summary[key] == null || summary[key] === "" || Number.isNaN(Number(summary[key]))) return "missing";
  return "$" + num(summary[key], 2);
}
function summaryScore(summary, key) {
  if (!summary || !present(summary[key])) return "missing";
  return scoreText(summary[key]);
}
function routeFor(note, index, groupIds) {
  const source = noteSourceGroup(note);
  if (source != null) {
    const start = String(source);
    return {
      mode: "from-source",
      sourceKnown: true,
      source: start,
      targets: groupIds.filter(id => id !== start),
      route: []
    };
  }
  if (groupIds.length < 2) {
    return { mode: "tour", sourceKnown: false, source: null, targets: [], route: groupIds.slice() };
  }
  const shift = groupIds.length ? index % groupIds.length : 0;
  return {
    mode: "tour",
    sourceKnown: false,
    source: null,
    targets: [],
    route: groupIds.slice(shift).concat(groupIds.slice(0, shift))
  };
}
function flightEndpoints(flight, leg) {
  if (flight.mode === "from-source") {
    if (!flight.targets.length) return { from: flight.source, to: null };
    return { from: flight.source, to: flight.targets[leg % flight.targets.length] };
  }
  const route = flight.route || [];
  if (!route.length) return { from: null, to: null };
  if (route.length === 1) return { from: route[0], to: null };
  return { from: route[leg % route.length], to: route[(leg + 1) % route.length] };
}
function clusterLeaderLabel(group) {
  if (group.leaderId) return group.leaderId;
  const flagged = group.robots.filter(robot => robot.leaderFlag === true);
  if (flagged.length === 1) return flagged[0].id;
  if (flagged.length > 1) return flagged.length + " leader flags";
  return "leader missing";
}
function perGroupSize(population, rosterCount) {
  if (typeof population !== "number" || !rosterCount) return null;
  if (population % rosterCount !== 0) return null;
  return population / rosterCount;
}
function paintClusters(model, each) {
  const host = document.getElementById("cluster-grid");
  if (!host) return;
  host.innerHTML = "";
  if (!model.length) {
    host.innerHTML = "<p class='sub'>No groups in this snapshot.</p>";
    return;
  }
  model.forEach(group => {
    const article = document.createElement("article");
    article.className = "cluster";
    article.dataset.group = group.id;
    const head = document.createElement("div");
    head.className = "cluster-head";
    const gid = document.createElement("div");
    gid.className = "gid";
    gid.textContent = group.id === "missing" ? "Group missing" : "Group " + group.id;
    const leader = document.createElement("div");
    leader.className = "leader-id";
    leader.textContent = clusterLeaderLabel(group);
    head.appendChild(gid);
    head.appendChild(leader);
    const pit = document.createElement("div");
    pit.className = "pit";
    if (!group.robots.length) {
      const empty = document.createElement("p");
      empty.className = "sub";
      empty.textContent = "No named agents";
      pit.appendChild(empty);
    }
    group.robots.forEach(robot => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "robot" + (robot.leader ? " leader" : "") + (robot.hasFills ? " has-fills" : "");
      button.dataset.origin = KNOWN_ORIGINS.has(robot.origin) ? robot.origin : "missing";
      button.style.animationDelay = staggerDelay(robot.id);
      button.title = robotTitle(robot);
      button.setAttribute("aria-label", button.title);
      button.innerHTML = "<span class='crown' aria-hidden='true'><i></i><i></i><i></i></span><span class='antenna' aria-hidden='true'></span><span class='head' aria-hidden='true'><i></i><i></i></span><span class='body' aria-hidden='true'></span><span class='fills' aria-hidden='true'></span>";
      button.addEventListener("click", () => openRobot(robot));
      pit.appendChild(button);
    });
    const meta = document.createElement("p");
    meta.className = "sub pit-meta";
    const unnamed = group.id !== "missing" && typeof each === "number" ? Math.max(0, each - group.robots.length) : null;
    meta.textContent = unnamed == null ? group.robots.length + " named" : group.robots.length + " named · " + unnamed + " not in this snapshot";
    article.appendChild(head);
    article.appendChild(pit);
    if (unnamed) {
      const seats = document.createElement("div");
      seats.className = "seats";
      seats.setAttribute("aria-hidden", "true");
      for (let i = 0; i < unnamed; i++) {
        const seat = document.createElement("span");
        seat.className = "seat";
        seats.appendChild(seat);
      }
      article.appendChild(seats);
    }
    article.appendChild(meta);
    host.appendChild(article);
  });
}
function openRobot(robot) {
  if (robot.agent) {
    showAgent(robot.agent);
    return;
  }
  selectedId = robot.id;
  document.getElementById("agent-title").textContent = robot.id + " · leaderboard row missing";
  document.getElementById("genome").textContent = robot.placeNote || "This agent is named in the snapshot, but the leaderboard row is missing.";
  drawEquity([]);
  renderTrades(latestTrades.filter(trade => trade.agent_id === robot.id));
  document.querySelectorAll("#board tbody tr").forEach(row => row.classList.remove("on"));
}
function paintNoteList(notes) {
  const list = document.getElementById("note-list");
  if (!list) return;
  list.innerHTML = "";
  if (notes == null) return;
  notes.forEach((note, index) => {
    const item = document.createElement("li");
    item.dataset.index = String(index);
    const kind = fieldText(note, "kind");
    const kindNode = document.createElement("span");
    kindNode.className = "kind " + kindClass(kind);
    kindNode.textContent = kind;
    item.appendChild(kindNode);
    item.appendChild(document.createTextNode(" " + fieldText(note, "pattern") + " · " + fieldText(note, "cost") + " · " + fieldText(note, "text")));
    list.appendChild(item);
  });
}
function writeArenaCopy(health, summary, model, noteInfo, leaderInfo) {
  const readout = document.getElementById("arena-readout");
  const size = document.getElementById("arena-size");
  const notes = document.getElementById("arena-notes");
  if (!readout || !size || !notes) return;
  const generation = present(health.generation) ? "Generation " + health.generation : "Generation missing";
  const feed = present(health.feed) ? "feed " + health.feed : (present(health.mode) ? "feed " + health.mode : "feed missing");
  const lag = health.feed_lag_s == null ? "lag missing" : "lag " + num(health.feed_lag_s, 1) + "s";
  readout.textContent = generation + " · " + feed + " · " + lag
    + " · training median " + moneyText(summary, "median_is_net") + " (score " + summaryScore(summary, "median_is") + ")"
    + " · unseen-window median " + moneyText(summary, "median_oos_net") + " (score " + summaryScore(summary, "median_oos") + ")";
  const roster = model.filter(group => group.id !== "missing");
  const named = model.reduce((count, group) => count + group.robots.length, 0);
  let sizeText;
  if (typeof health.population === "number" && roster.length && health.population % roster.length === 0) {
    sizeText = health.population + " agents across " + roster.length + " groups (" + (health.population / roster.length) + " each). " + named + " are named in this snapshot.";
  } else if (present(health.population)) {
    sizeText = "Population " + health.population + ". " + roster.length + " groups in this snapshot. Per-group size is missing. " + named + " agents are named.";
  } else {
    sizeText = "Population missing. " + roster.length + " groups in this snapshot. " + named + " agents are named.";
  }
  if (!leaderInfo.map) sizeText += " Leader list is missing. A crown follows a leader flag on a named agent.";
  else sizeText += " Leader ids from " + leaderInfo.where + ".";
  size.textContent = sizeText;
  const shared = noteInfo.notes;
  if (shared == null) {
    notes.textContent = "Shared notes are missing from this snapshot.";
    return;
  }
  if (!shared.length) {
    notes.textContent = "No shared notes in this snapshot.";
    return;
  }
  const known = shared.filter(note => noteSourceGroup(note) != null).length;
  const source = noteInfo.healthMissing
    ? "From " + noteInfo.where + ". health.summary.memory is missing."
    : "From " + noteInfo.where + ".";
  const differ = noteInfo.differs ? " leaderboard.memory does not match it." : "";
  let path;
  if (roster.length < 2) path = " Fewer than two groups are in this snapshot, so a note cannot travel between groups.";
  else if (known === shared.length) path = " Each note leaves its recorded group and arrives at the others.";
  else if (known === 0) path = " Notes do not name a publishing group, so each note travels across the groups. That path is not a recorded sender.";
  else path = " " + known + " of " + shared.length + " notes name a publishing group and leave that group. The others travel across the groups without a recorded sender.";
  notes.textContent = shared.length + " shared notes. " + source + differ + path;
}
function armFlights(notes, groupIds) {
  const token = ++flightToken;
  noteFlights = [];
  const layer = document.getElementById("note-layer");
  if (!layer) return;
  layer.innerHTML = "";
  if (!notes || !notes.length || prefersReducedMotion()) return;
  noteFlights = notes.map((note, index) => {
    const plan = routeFor(note, index, groupIds);
    const chip = document.createElement("div");
    const kind = fieldText(note, "kind");
    chip.className = "note-chip " + kindClass(kind);
    const who = plan.sourceKnown ? "leaves group " + plan.source : "shared";
    chip.innerHTML = "<div class='note-k'>" + escapeHtml(who + " · " + kind + " · " + fieldText(note, "pattern") + " · " + fieldText(note, "cost")) + "</div><div class='note-t'>" + escapeHtml(fieldText(note, "text")) + "</div>";
    chip.style.opacity = "0";
    layer.appendChild(chip);
    plan.note = note;
    plan.el = chip;
    plan.arc = index % 2 === 0 ? 1 : -1;
    plan.w = 0;
    plan.h = 0;
    return plan;
  });
  const canTravel = noteFlights.some(flight => flight.mode === "from-source" ? flight.targets.length > 0 : (flight.route || []).length > 1);
  if (!canTravel) {
    noteFlights.forEach(flight => { flight.el.style.opacity = "0"; });
    return;
  }
  noteEpoch = performance.now();
  requestAnimationFrame(now => stepNotes(now, token));
}
function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function placeChip(flight, x, y) {
  const chip = flight.el;
  if (!flight.w) {
    flight.w = chip.offsetWidth || 160;
    flight.h = chip.offsetHeight || 36;
  }
  chip.style.transform = "translate(" + Math.round(x - flight.w / 2) + "px, " + Math.round(y - flight.h / 2) + "px)";
}
function stepNotes(now, token) {
  if (token !== flightToken) return;
  const stage = document.getElementById("arena-stage");
  if (!stage || !noteFlights.length) return;
  const stageBox = stage.getBoundingClientRect();
  const clusters = new Map();
  document.querySelectorAll("#cluster-grid .cluster").forEach(el => {
    const box = el.getBoundingClientRect();
    clusters.set(el.dataset.group, {
      el: el,
      x: box.left - stageBox.left + box.width / 2,
      y: box.top - stageBox.top + box.height * 0.42
    });
    el.classList.remove("sending", "receiving");
  });
  const hopMs = 2600;
  const hopsPerNote = 3;
  const count = noteFlights.length;
  const elapsed = Math.max(0, now - noteEpoch);
  const slot = hopsPerNote * hopMs;
  const slotIndex = Math.floor(elapsed / slot);
  const active = slotIndex % count;
  const hopInSlot = Math.floor((elapsed % slot) / hopMs);
  const raw = (elapsed % hopMs) / hopMs;
  const travel = 0.74;
  const posT = raw < travel ? raw / travel : 1;
  const eased = posT < 0.5 ? 2 * posT * posT : 1 - Math.pow(-2 * posT + 2, 2) / 2;
  document.querySelectorAll("#note-list li").forEach((item, index) => item.classList.toggle("on", index === active));
  noteFlights.forEach((flight, index) => {
    if (index !== active) {
      flight.el.style.opacity = "0";
      return;
    }
    const round = Math.floor(slotIndex / count);
    const leg = round * hopsPerNote + hopInSlot;
    const ends = flightEndpoints(flight, leg);
    const from = ends.from != null ? clusters.get(String(ends.from)) : null;
    const to = ends.to != null ? clusters.get(String(ends.to)) : null;
    if (!from || !to) {
      if (from) {
        placeChip(flight, from.x, from.y);
        flight.el.style.opacity = "1";
        from.el.classList.add("receiving");
      } else flight.el.style.opacity = "0";
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const arc = Math.sin(Math.PI * eased) * 26 * flight.arc;
    placeChip(flight, from.x + dx * eased + (-dy / len) * arc, from.y + dy * eased + (dx / len) * arc);
    flight.el.style.opacity = "1";
    if (flight.sourceKnown && raw < 0.2) from.el.classList.add("sending");
    if (raw > 0.72) to.el.classList.add("receiving");
  });
  requestAnimationFrame(t => stepNotes(t, token));
}
function renderArena(bundle) {
  const health = bundle.health || {};
  const generations = (bundle.generations && bundle.generations.generations) || [];
  const summary = generations.length ? (generations[generations.length - 1].summary || null) : null;
  const agents = (bundle.leaderboard && bundle.leaderboard.agents) || [];
  const trades = (bundle.trades && bundle.trades.trades) || [];
  const leaderInfo = readLeaderMap(health, summary);
  const noteInfo = readSharedNotes(health, bundle.leaderboard, summary);
  const model = buildArenaModel(agents, trades, leaderInfo, noteInfo.notes || []);
  const signature = JSON.stringify({
    groups: model.map(group => ({
      id: group.id,
      leaderId: group.leaderId,
      robots: group.robots.map(robot => [robot.id, robot.leader, robot.leaderFlag, robot.origin, robot.inBoard, robot.hasFills, robot.isScore, robot.oosScore, robot.placeNote])
    })),
    notes: noteInfo.notes,
    where: noteInfo.where,
    leaders: leaderInfo.where,
    population: health.population,
    generation: health.generation
  });
  writeArenaCopy(health, summary, model, noteInfo, leaderInfo);
  const memoryNode = document.getElementById("memory");
  if (memoryNode) {
    memoryNode.textContent = noteInfo.notes == null
      ? "Shared notes are missing from this snapshot."
      : (!noteInfo.notes.length ? "No shared notes in this snapshot." : noteInfo.notes.map(formatNote).join(" · "));
  }
  if (signature === arenaSignature) return;
  arenaSignature = signature;
  const rosterCount = model.filter(group => group.id !== "missing").length;
  paintClusters(model, perGroupSize(health.population, rosterCount));
  paintNoteList(noteInfo.notes);
  const travelIds = model.map(group => group.id).filter(id => id !== "missing");
  armFlights(noteInfo.notes, travelIds.length ? travelIds : model.map(group => group.id));
}
function tickArenaFreshness() {
  const node = document.getElementById("arena-fresh");
  if (!node) return;
  if (!publishedUnix) {
    node.textContent = "Publish time is missing. The stale check needs manifest.published_unix.";
    return;
  }
  const age = Math.max(0, Date.now() / 1000 - publishedUnix);
  const stale = age * 1000 > (cfg.staleAfterMs || 120000);
  node.textContent = stale
    ? "This snapshot is " + Math.round(age) + "s old. Robots, notes, and the numbers above are still the last real gist data."
    : "Snapshot is " + Math.round(age) + "s old.";
}

function render(bundle) {
  const health = bundle.health || {};
  const generations = (bundle.generations && bundle.generations.generations) || [];
  const agents = (bundle.leaderboard && bundle.leaderboard.agents) || [];
  const trades = (bundle.trades && bundle.trades.trades) || [];
  const llm = bundle.llm || {};
  latestAgents = agents;
  latestTrades = trades;
  publishedUnix = Number((bundle.manifest && bundle.manifest.published_unix) || 0);
  const uptime = health.started_at ? Math.round(Date.now() / 1000 - health.started_at) + "s" : "—";
  setMessage(health.message || health.mode || "snapshot loaded");
  document.getElementById("health").innerHTML = [
    card("Uptime", uptime),
    card("Feed", escapeHtml(health.feed || health.mode || "—")),
    card("Feed lag", health.feed_lag_s == null ? "—" : num(health.feed_lag_s, 1) + "s"),
    card("Snapshots", health.snapshots ?? "—"),
    card("API RTT p50", health.rtt_ms_p50 == null ? "—" : num(health.rtt_ms_p50, 1) + " ms"),
    card("Rate-limit 429s", health.rate_limit_hits ?? 0),
    card("Errors", health.feed_errors ?? (health.last_error ? 1 : 0)),
    card("Generation", health.generation ?? "—"),
    card("Agents", health.population ?? "—"),
    card("LLM", escapeHtml((health.llm && (health.llm.status + (health.llm.provider ? " · " + health.llm.provider : ""))) || "evolution")),
    card("Paper", "yes")
  ].join("") + (health.last_error ? `<p class="sub">Last error: ${escapeHtml(health.last_error)}</p>` : "");
  renderMarkets(health.markets || []);
  drawChart(generations);
  const last = generations.length ? generations[generations.length - 1] : null;
  const spread = last && last.summary && last.summary.eligible_spread;
  const origins = (last && last.summary && last.summary.origins) || {};
  document.getElementById("spread").textContent = !last
    ? "No generation yet."
    : (!spread || !spread.n)
      ? "No agent is eligible yet. Scores are the provisional warm-up return. Origins: " + JSON.stringify(origins)
      : `Eligible fitness n=${spread.n} min ${fitNum(spread.min)} median ${fitNum(spread.median)} max ${fitNum(spread.max)}. Origins ${JSON.stringify(origins)}`;
  const summary = last && last.summary;
  document.getElementById("costs").innerHTML = summary ? `
    <p>Fees (sum of agents, selection windows) <span class="metric">${num(summary.fees_is, 2)}</span></p>
    <p>Book slippage vs touch at fill <span class="metric">${num(summary.slippage_is, 2)}</span></p>
    <p>Latency attribution (touch move after the decision; negative if the price improved) <span class="metric">${num(summary.latency_cost_is, 2)}</span></p>
    <p>Capital lockup, dollar-seconds <span class="metric">${num(summary.lockup_is, 0)}</span></p>
    <p class="sub">Net PnL already includes fees and the price actually paid. These lines are not charged a second time.</p>` : "<p class='sub'>Waiting for a generation.</p>";
  const body = document.querySelector("#board tbody");
  body.innerHTML = "";
  if (!agents.length) {
    body.innerHTML = "<tr><td colspan='14'>No agents in the latest generation.</td></tr>";
  }
  agents.forEach(agent => {
    const ism = agent.is_metrics || {};
    const group = groupCell(agent);
    const leader = leaderCell(agent);
    const origin = present(agent.origin) ? agent.origin : "missing";
    const tr = document.createElement("tr");
    tr.className = "click";
    tr.dataset.id = agent.agent_id;
    tr.innerHTML = `<td>${escapeHtml(agent.agent_id)}</td><td>${escapeHtml(group)}</td><td>${escapeHtml(leader)}</td><td>${escapeHtml(origin)}</td><td>${scoreText(agent.is_score)}</td><td>${scoreText(agent.oos_score)}</td><td>${num(ism.net_pnl, 2)}</td><td>${num(ism.fees, 2)}</td><td>${num(ism.spread_slippage, 2)}</td><td>${num(ism.latency_cost, 2)}</td><td>${ism.n_round_trips ?? "—"}</td><td>${num(ism.win_rate, 2)}</td><td>${num(ism.max_drawdown, 2)}</td><td>${escapeHtml(statusLabel(agent, ism))}</td>`;
    tr.onclick = () => showAgent(agent);
    body.appendChild(tr);
  });
  const history = document.querySelector("#history tbody");
  history.innerHTML = generations.map(row => {
    const summaryRow = row.summary || {};
    return `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.created_at)}</td><td>${escapeHtml(row.is_windows)}</td><td>${escapeHtml(row.oos_window)}</td><td>${escapeHtml(summaryRow.eligible_is ?? "—")}</td><td>${num(summaryRow.median_is_net, 2)}</td><td>${num(summaryRow.median_oos_net, 2)}</td><td>${num(summaryRow.best_oos_net, 2)}</td></tr>`;
  }).join("") || "<tr><td colspan='8'>No generations yet.</td></tr>";
  const step = health.last_step;
  const calls = llm.calls || [];
  const effects = llm.effects || [];
  const lastEffect = effects[effects.length - 1];
  const callRows = calls.slice(0, 12).map(call => `<tr><td>${escapeHtml(call.created_at || "")}</td><td>${escapeHtml(call.status || "")}</td><td>${escapeHtml(call.provider || "")}</td><td>${escapeHtml(call.model || "")}</td><td>${escapeHtml(call.reject_reasons || "")}</td><td>${escapeHtml((call.accepted || "").slice(0, 240))}</td></tr>`).join("");
  document.getElementById("llm").innerHTML = `
    <p>${step ? `Generation ${escapeHtml(step.generation)} → ${escapeHtml(step.next_generation)}. Scored origins ${escapeHtml(JSON.stringify(step.scored_origins || {}))}. Next origins ${escapeHtml(JSON.stringify(step.next_origins || {}))}.` : "No generation step yet."}</p>
    <p class="sub">${step && step.bounds && Object.keys(step.bounds).length ? "Active sampling bounds " + escapeHtml(JSON.stringify(step.bounds)) : "Sampling bounds are the hard ranges."}</p>
    <p>${lastEffect ? `Holdout mean dollars, LLM-seeded agents ${num(lastEffect.llm_mean_oos)} (n=${escapeHtml(lastEffect.n_llm)}) vs everyone else ${num(lastEffect.evo_mean_oos)} (n=${escapeHtml(lastEffect.n_evo)}). ${escapeHtml(lastEffect.note || "")}` : "The LLM-versus-evolution comparison is the next generation's holdout, after seeds are in the population."}</p>
    <table><thead><tr><th>When</th><th>Status</th><th>Provider</th><th>Model</th><th>Rejected</th><th>Accepted</th></tr></thead><tbody>${callRows || "<tr><td colspan='6'>No LLM call yet. With no reachable provider the arena stays on pure evolution.</td></tr>"}</tbody></table>`;
  renderTrades(trades);
  renderArena(bundle);
  if (selectedId) {
    const again = agents.find(agent => agent.agent_id === selectedId);
    if (again) showAgent(again);
  }
  tickFreshness();
}
function fitNum(value) {
  if (typeof value === "number" && Number.isFinite(value) && value <= -1000) return "—";
  return num(value);
}

function tickFreshness() {
  const node = document.getElementById("freshness");
  const stale = document.getElementById("stale");
  // A quiet publisher leaves published_unix unchanged. Keep the last numbers and say so.
  if (!publishedUnix) {
    if (node) node.textContent = "last updated —";
    if (stale) stale.classList.remove("show");
  } else {
    const age = Math.max(0, Date.now() / 1000 - publishedUnix);
    if (node) node.textContent = `last updated ${Math.round(age)} seconds ago · paper trading snapshot`;
    if (stale) stale.classList.toggle("show", age * 1000 > (cfg.staleAfterMs || 120000));
  }
  tickArenaFreshness();
}
function reportRefreshError(err) {
  const text = String(err);
  const kept = publishedUnix || (document.getElementById("cluster-grid") && document.getElementById("cluster-grid").childElementCount);
  setMessage(kept ? text + " Showing the last snapshot." : text);
}

async function refresh() {
  if (!cfg.gistId || String(cfg.gistId).startsWith("REPLACE")) {
    setMessage("Set the public gist id in config.js (site/config.js). Do not put a token there.");
    return;
  }
  const parsed = await loadSnapshot();
  const bundle = {};
  FILES.forEach(name => { bundle[name.replace(".json", "")] = parsed[name]; });
  render(bundle);
}

refresh().catch(reportRefreshError);
setInterval(() => refresh().catch(reportRefreshError), cfg.refreshMs || 30000);
setInterval(tickFreshness, 1000);
