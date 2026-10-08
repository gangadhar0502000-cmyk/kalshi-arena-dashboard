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
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number) || number <= -1000) return "—";
  return number.toFixed(4);
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
    const response = await fetch(raw);
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
    const value = row.summary && row.summary[item.key];
    if (typeof value === "number") vals.push(value);
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
      const value = row.summary && row.summary[item.key];
      if (typeof value !== "number") return;
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
    "\n\nselection metrics\n" + JSON.stringify(ism, null, 2) +
    "\n\nholdout metrics\n" + JSON.stringify(agent.oos_metrics || {}, null, 2);
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

function render(bundle) {
  const health = bundle.health || {};
  const generations = (bundle.generations && bundle.generations.generations) || [];
  const agents = (bundle.leaderboard && bundle.leaderboard.agents) || [];
  const memoryNotes = (bundle.leaderboard && bundle.leaderboard.memory) || [];
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
      : `Eligible fitness n=${spread.n} min ${num(spread.min)} median ${num(spread.median)} max ${num(spread.max)}. Origins ${JSON.stringify(origins)}`;
  const summary = last && last.summary;
  document.getElementById("costs").innerHTML = summary ? `
    <p>Fees (sum of agents, selection windows) <span class="metric">${num(summary.fees_is, 2)}</span></p>
    <p>Book slippage vs touch at fill <span class="metric">${num(summary.slippage_is, 2)}</span></p>
    <p>Latency attribution (touch move after the decision; negative if the price improved) <span class="metric">${num(summary.latency_cost_is, 2)}</span></p>
    <p>Capital lockup, dollar-seconds <span class="metric">${num(summary.lockup_is, 0)}</span></p>
    <p class="sub">Net PnL already includes fees and the price actually paid. These lines are not charged a second time.</p>` : "<p class='sub'>Waiting for a generation.</p>";
  const memoryNode = document.getElementById("memory");
  if (memoryNode) {
    memoryNode.textContent = !memoryNotes.length
      ? "No shared notes yet."
      : memoryNotes.map(note => `${note.kind || ""} ${note.pattern || ""} (${note.cost || ""}): ${note.text || ""}`).join(" · ");
  }
  const body = document.querySelector("#board tbody");
  body.innerHTML = "";
  if (!agents.length) {
    body.innerHTML = "<tr><td colspan='14'>No agents in the latest generation.</td></tr>";
  }
  agents.forEach(agent => {
    const ism = agent.is_metrics || {};
    const group = ism.group_id != null ? ism.group_id : (agent.group_id != null ? agent.group_id : "—");
    const leader = ism.leader || agent.leader ? "yes" : "";
    const tr = document.createElement("tr");
    tr.className = "click";
    tr.dataset.id = agent.agent_id;
    tr.innerHTML = `<td>${escapeHtml(agent.agent_id)}</td><td>${escapeHtml(group)}</td><td>${escapeHtml(leader)}</td><td>${escapeHtml(agent.origin)}</td><td>${scoreText(agent.is_score)}</td><td>${scoreText(agent.oos_score)}</td><td>${num(ism.net_pnl, 2)}</td><td>${num(ism.fees, 2)}</td><td>${num(ism.spread_slippage, 2)}</td><td>${num(ism.latency_cost, 2)}</td><td>${ism.n_round_trips ?? "—"}</td><td>${num(ism.win_rate, 2)}</td><td>${num(ism.max_drawdown, 2)}</td><td>${escapeHtml(statusLabel(agent, ism))}</td>`;
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
  if (selectedId) {
    const again = agents.find(agent => agent.agent_id === selectedId);
    if (again) showAgent(again);
  }
  tickFreshness();
}

function tickFreshness() {
  const node = document.getElementById("freshness");
  const stale = document.getElementById("stale");
  if (!publishedUnix) {
    node.textContent = "last updated —";
    stale.classList.remove("show");
    return;
  }
  const age = Math.max(0, Date.now() / 1000 - publishedUnix);
  node.textContent = `last updated ${Math.round(age)} seconds ago · paper trading snapshot`;
  stale.classList.toggle("show", age * 1000 > (cfg.staleAfterMs || 120000));
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

refresh().catch(err => setMessage(String(err)));
setInterval(() => refresh().catch(err => setMessage(String(err))), cfg.refreshMs || 30000);
setInterval(tickFreshness, 1000);
