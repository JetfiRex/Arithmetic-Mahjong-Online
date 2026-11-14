"use strict";

const $ = (id) => document.getElementById(id);
const localRoom = window.localMultiplayer || null;
const LABEL = { CHI: "吃", PENG: "碰", MING_GANG: "杠", AN_GANG: "暗杠", JIA_GANG: "加杠", HU: "胡", PASS: "过" };
const STAGES = { LOBBY: "等待开局", HAND_PREPARATION: "开局理牌", BOT_TURN: "其他玩家出牌回合", READY_SOURCE: "等待来牌", OWN_TURN: "我的出牌回合", WAITING_DRAW: "等待摸牌", WAITING_RESPONSE: "来牌响应", WAITING_ACTION_DETAIL: "选择吃法", WAITING_ROB_KONG: "等待其他玩家响应", ROUND_ENDED: "本局结束" };
const TIMER_FIELDS = [
  ["discard_response_seconds", "t1", "吃碰杠胡响应", 5],
  ["action_detail_seconds", "t2", "选择吃法", 5],
  ["turn_action_seconds", "t3", "摸牌后出牌", 30],
  ["rob_kong_seconds", "t4", "抢杠响应", 5],
];
const VALUES = [...Array(21).keys(), 24, "+", "×"];
let state, busy = false, polling = false, numberView = false;
let selected = null, chiSelection = new Set();
let deckSelection = null, dragging = null, editorKind = null, shownResult = null;
let receivedAt = 0, toastTimer, lastWindow = null;
let settingsKey = null, setupShownFor = null, chiWindowKey = null, dragClickUntil = 0;
let handLayout = null, handRenderOwner = null, handMeldNode = null, handRow = null;
let meldRenderKey = null, meldRenderRoot = null, renderedStateKey = null;
let dropIndicator = null, dropPreview = null, suppressedDragClick = null;
const handTiles = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function tile(value, interactive = false) {
  const node = element(interactive ? "button" : "span", "tile");
  node.dataset.value = value;
  if (typeof value === "string") node.classList.add("operator");
  if (numberView) node.classList.add("number-view");
  const art = element("span", "tile-art");
  const index = VALUES.indexOf(value);
  art.style.backgroundPosition = `${(index % 6) * 20}% ${Math.floor(index / 6) * (100 / 3)}%`;
  art.setAttribute("aria-hidden", "true");
  node.append(art, element("span", "tile-value", value));
  node.setAttribute("aria-label", `${value} 牌`);
  if (interactive) node.type = "button";
  return node;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}

function ui() {
  const value = state.ui || state.practice;
  return localRoom && state.network?.enabled && (!localRoom.connectionId || value.autopilot)
    ? { ...value, sorting_allowed: false, editing_allowed: false } : value;
}
function viewerId() { return localRoom ? state.viewer_player_id : "p0"; }
function me() {
  const player = rawMe();
  if (!handLayout || handLayout.owner !== layoutOwner()) return player;
  const records = new Map(player.hand_tile_records.map(t => [t.tile_id, t]));
  const ordered = layoutOrder().map(id => records.get(id)).filter(Boolean);
  return {...player, hand_tile_records: ordered, hand_tiles: ordered.map(t => t.value)};
}
function stage() { return ui().stage; }
function manualChi() { return state.pending_action_detail?.selection_mode === "manual"; }

function rawMe(snapshot = state) {
  const id = localRoom ? snapshot.viewer_player_id : "p0";
  const player = snapshot.players.find(p => p.player_id === id) || snapshot.players[snapshot.viewer_seat ?? 0];
  return {hand_tile_records: [], ...player};
}

function layoutOwner(snapshot = state) {
  if (localRoom && !snapshot.viewer_player_id) return null;
  return `${snapshot.server_instance_id}:${snapshot.session_id}:${snapshot.round_id}:${localRoom ? snapshot.viewer_player_id : "p0"}`;
}

function layoutOrder(layout = handLayout) {
  return layout ? [...layout.order] : [];
}

function reconcileLayout(next) {
  const owner = layoutOwner(next);
  if (!owner) { handLayout = null; return; }
  const ids = rawMe(next).hand_tile_records.map(t => t.tile_id), valid = new Set(ids);
  if (handLayout?.owner !== owner) {
    handLayout = {owner, order: ids, version: 0};
    return;
  }
  const order = handLayout.order.filter(id => valid.has(id));
  const placed = new Set(order);
  order.push(...ids.filter(id => !placed.has(id)));
  if (order.length !== handLayout.order.length || order.some((id,i) => id !== handLayout.order[i])) {
    handLayout.order = order;
    handLayout.version++;
  }
}

function handContentSignature(player) {
  return JSON.stringify(player.hand_tile_records.map(t => [t.tile_id, t.value]).sort((a,b) => a[0].localeCompare(b[0])));
}

function moveHand(data) {
  if (!state || !handLayout || !ui().sorting_allowed || ui().recovery_pending || ui().autopilot || me().is_out) return false;
  const order = layoutOrder();
  const from = order.indexOf(data.tile_id);
  if (from < 0 || !Number.isInteger(data.index) || data.index < 0 || data.index >= order.length) return false;
  order.splice(from, 1);
  order.splice(data.index, 0, data.tile_id);
  handLayout.order = order;
  handLayout.version++;
  renderHand(); renderActions();
  return true;
}

function selectLocalTiles(required) {
  const remaining = new Map();
  for (const value of required) remaining.set(value, (remaining.get(value) || 0) + 1);
  const chosen = [];
  for (const {tile_id, value} of me().hand_tile_records) {
    if ((remaining.get(value) || 0) > 0) {
      chosen.push(tile_id);
      remaining.set(value, remaining.get(value) - 1);
    }
  }
  if (chosen.length !== required.length) throw new Error("动作所需手牌已变化");
  return chosen;
}

function prepareAction(type, data) {
  const result = {...data};
  if (type === "discard" && handLayout) {
    const order = layoutOrder(), authority = rawMe().hand_tile_records.map(t => t.tile_id);
    if (order.some((id,i) => id !== authority[i])) result.hand_order = order;
  } else if (type === "response" && ["PENG", "MING_GANG"].includes(data.action)) {
    const option = state.response_window?.options_by_player[viewerId()]?.find(o => o.action_type === data.action);
    const required = option?.payload_options[0]?.hand_tiles;
    if (!required) throw new Error("响应窗口已变化");
    result.selected_tile_ids = selectLocalTiles(required);
  } else if (type === "turn_action" && ["AN_GANG", "JIA_GANG"].includes(data.action)) {
    const option = state.turn_options_by_player[viewerId()]?.find(o => o.action_type === data.action);
    const payload = option?.payload_options.find(p => p.option_id === data.option_id);
    if (!payload) throw new Error("杠牌窗口已变化");
    result.selected_tile_ids = selectLocalTiles(payload.required_values);
  } else if (type === "chi" && data.option_id != null) {
    const option = state.pending_action_detail?.payload_options.find(p => p.option_id === data.option_id);
    if (!option) throw new Error("吃牌窗口已变化");
    result.selected_tile_ids = selectLocalTiles(option.required_values);
  } else if (type === "chi" && data.tile_ids) {
    result.selected_tile_ids = [...data.tile_ids];
    delete result.tile_ids;
  }
  return result;
}

// Every mutation carries both the snapshot revision and the relevant action window.
async function send(type, data = {}) {
  if (type === "move") return moveHand(data);
  if (busy || !state) return false;
  busy = true;
  document.body.classList.add("working");
  try {
    data = prepareAction(type, data);
    renderActions();
    const pending = localRoom ? localRoom.send(type, data) : fetch("/api/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, revision: state.revision, turn_window_id: state.turn_window_id, ...data }),
    });
    const token = localRoom?.token, generation = localRoom?.identityGeneration;
    const response = await pending;
    const result = await response.json();
    if (localRoom && (token !== localRoom.token || generation !== localRoom.identityGeneration)) return false;
    if (result.state) accept(result.state);
    if (!response.ok) throw new Error(result.error || "操作失败");
    return true;
  } catch (error) {
    if ($("setup-dialog").open) $("setup-error").textContent = error.message;
    toast(error.message || "连接失败");
    return false;
  } finally {
    busy = false;
    document.body.classList.remove("working");
    if (state) renderActions();
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = localRoom ? await localRoom.poll() : await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("离线");
    const token = localRoom?.token, generation = localRoom?.identityGeneration;
    const next = await response.json();
    if (localRoom && (token !== localRoom.token || generation !== localRoom.identityGeneration)) return;
    accept(next);
    $("connection-dot").classList.remove("offline");
  } catch {
    $("connection-dot").classList.add("offline");
  } finally { polling = false; }
}

function accept(next) {
  if (localRoom && (state?.session_id !== next.session_id || state?.server_instance_id !== next.server_instance_id)) state = null;
  if (state && next.revision < state.revision) return;
  if (dragging?.kind === "hand") {
    const player = next.players.find((p) => p.player_id === (localRoom ? next.viewer_player_id : "p0"));
    const nextUI = next.ui || next.practice;
    if (dragging.owner !== layoutOwner(next)
        || dragging.signature !== handContentSignature(player)
        || !nextUI.sorting_allowed || nextUI.recovery_pending || nextUI.autopilot || player?.is_out) endDrag(false);
  }
  if (localRoom && state?.round_id !== next.round_id && $("result-dialog").open) $("result-dialog").close();
  const changed = !state || next.revision !== state.revision;
  reconcileLayout(next);
  state = next;
  receivedAt = performance.now();
  const stateKey = `${layoutOwner()}:${state.viewer_seat}:${state.revision}`;
  if (changed || renderedStateKey !== stateKey) {
    if ((next.ui || next.practice).recovery_pending) { selected = null; chiSelection.clear(); }
    const window = `${state.round_id}:${state.phase === "WAITING_TURN_ACTION" ? state.turn_window_id : ""}`;
    if (lastWindow !== window) {
      selected = null;
      lastWindow = window;
    }
    const detail = state.pending_action_detail;
    const nextChiKey = detail?.player_id === viewerId() ? `${state.round_id}:${detail.detail_id}` : null;
    if (chiWindowKey !== nextChiKey) { chiSelection.clear(); chiWindowKey = nextChiKey; }
    const ids = new Set(me().hand_tile_records.map((t) => t.tile_id));
    if (!ids.has(selected)) selected = null;
    chiSelection = new Set([...chiSelection].filter((id) => ids.has(id)));
    render();
    renderedStateKey = stateKey;
  }
  renderTimer();
}

function render() {
  const practice = ui();
  if (dragging?.kind === "hand" && (!practice.sorting_allowed || practice.recovery_pending || me().is_out)) endDrag(false);
  $("round-label").textContent = practice.started === false ? "等待开局" : practice.mode === "four" ? `第 ${practice.round_number} 局` : `第 ${practice.round_number} 次试牌`;
  $("clock-label").textContent = practice.timeout_settings ? Object.values(practice.timeout_settings).some((v) => v !== null) ? "计时已开启" : "不计时" : practice.scene === "timer" ? "计时体验" : "无计时";
  if (state.config?.fast_mode) $("clock-label").textContent += " · 快速模式";
  $("mode-label").textContent = practice.mode === "four" ? "四人开发者局" : "单人试牌";
  $("table-mode").replaceChildren(document.createTextNode(practice.mode === "four" ? "FOUR PLAYERS" : "SOLITAIRE"), element("span", "", practice.mode === "four" ? "四人开发者局" : "单人试牌台"));
  if (!$("scene-select").options.length) {
    for (const [value, label] of Object.entries(practice.scenes)) {
      const option = element("option", "", label); option.value = value; $("scene-select").append(option);
    }
  }
  $("scene-select").value = practice.scene;
  $("scene-select").parentElement.hidden = practice.mode === "four";
  $("scene-select").disabled = practice.settings_locked === true;
  $("wall-counter").textContent = `牌山 ${state.wall.remaining_count}`;
  $("stage-label").textContent = stage() === "BOT_TURN" ? `${state.players[state.current_turn_seat].name} · t3 出牌` : stage() === "WAITING_ROB_KONG" && state.rob_kong_window ? "t4 · 抢杠响应" : STAGES[stage()] || "处理中";
  $("hand-count").textContent = `${me().hand_count} 张`;
  $("edit-hand").disabled = !practice.editing_allowed;
  $("edit-wall").disabled = !practice.editing_allowed;
  $("deck-add").disabled = !practice.editing_allowed;
  $("show-result").hidden = !state.round_result;
  renderHand();
  renderMelds();
  renderTable();
  renderDeck();
  renderActions();
  renderActivity();
  renderOpponents();
  renderFlow();
  renderSettings();
  renderRecovery();
  if (localRoom) localRoom.render();
  if (!practice.recovery_pending && state.round_result && shownResult !== state.round_id && (!localRoom || state.room?.phase === "REVIEWING")) {
    shownResult = state.round_id;
    showResult();
  }
}

function placeHandNodes(parent, nodes) {
  const keep = new Set(nodes);
  nodes.forEach((node, index) => {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
}

function dragGeometry() {
  if (!dragging || dragging.kind !== "hand") return null;
  if (!dragging.geometry) {
    const zone = handRow, bounds = zone.getBoundingClientRect();
    const nodes = [...zone.querySelectorAll("[data-tile-id]")].filter(n => n.dataset.tileId !== dragging.id);
    const targets = nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return {mid: (rect.left + rect.right) / 2, left: node.offsetLeft - 3};
    });
    const last = nodes.at(-1);
    dragging.geometry = {zone, bounds, targets, end: last ? last.offsetLeft + last.offsetWidth + 2 : 2};
  }
  return dragging.geometry;
}

function handDropTarget(event, fresh = false) {
  if (fresh && dragging) dragging.geometry = null;
  const area = dragGeometry();
  if (!area || event.clientX < area.bounds.left) return null;
  let index = area.targets.findIndex(t => event.clientX < t.mid);
  if (index < 0) index = area.targets.length;
  return {zone: area.zone, index, left: area.targets[index]?.left ?? area.end};
}

function previewHandDrop(event) {
  if (dragging?.kind !== "hand" || !ui().sorting_allowed) return;
  event.preventDefault();
  const target = handDropTarget(event);
  if (!target) { clearDrop(); return; }
  if (dropPreview?.zone === target.zone && dropPreview.index === target.index && dropPreview.left === target.left) return;
  if (dropPreview?.zone !== target.zone) dropPreview?.zone.classList.remove("drop-active");
  if (!dropIndicator) { dropIndicator = element("span", "drop-slot"); dropIndicator.style.left = "0"; }
  target.zone.classList.add("drop-active");
  dropIndicator.style.transform = `translateX(${target.left}px)`;
  if (dropIndicator.parentNode !== target.zone) target.zone.append(dropIndicator);
  dropPreview = target;
}

function commitHandDrop(event) {
  if (dragging?.kind !== "hand" || !ui().sorting_allowed) return;
  event.preventDefault();
  if (dragging.owner !== layoutOwner() || dragging.layoutVersion !== handLayout?.version) { endDrag(); return; }
  const target = handDropTarget(event, true), id = dragging.id;
  endDrag(false);
  if (target) moveHand({tile_id: id, index: target.index});
  else renderHand();
}

function handTileNode(id, value) {
  let node = handTiles.get(id);
  if (node) return node;
  node = tile(value, true); node.dataset.tileId = id; node.title = `${value}`;
  node.onpointerdown = () => { suppressedDragClick = null; };
  node.onclick = () => {
    if (suppressedDragClick === id && performance.now() < dragClickUntil) { suppressedDragClick = null; return; }
    suppressedDragClick = null;
    if (ui().recovery_pending || ui().autopilot || me().is_out) return;
    else if (manualChi()) {
      if (chiSelection.has(id)) chiSelection.delete(id);
      else if (chiSelection.size < 3) chiSelection.add(id);
      else toast("最多选择 3 张牌");
    } else if (stage() === "OWN_TURN") selected = selected === id ? null : id;
    renderHand(); renderMelds(); renderActions();
  };
  node.ondragstart = event => {
    if (!ui().sorting_allowed) { event.preventDefault(); return; }
    dragging = {kind: "hand", id, node, owner: layoutOwner(), layoutVersion: handLayout.version,
      signature: handContentSignature(rawMe()), geometry: null};
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    node.classList.add("dragging");
  };
  node.ondragend = () => endDrag();
  handTiles.set(id, node);
  return node;
}

function renderHand() {
  if (dragging?.kind === "hand") return;
  const root = $("hand-regions"), player = me();
  if (localRoom && !viewerId()) {
    handRenderOwner = null;
    root.replaceChildren();
    const meldArea = element("div", "meld-area"); meldArea.id = "meld-area"; root.append(meldArea);
    const zone = element("div", "hand-region observer-hand");
    for (let i = 0; i < player.hand_count; i++) zone.append(player.observer_tiles ? tile(player.observer_tiles[i]) : element("span", "tile back"));
    root.append(zone);
    return;
  }
  const owner = layoutOwner();
  if (handRenderOwner !== owner || !handMeldNode || handMeldNode.parentNode !== root) {
    root.replaceChildren(); handTiles.clear();
    handMeldNode = element("div", "meld-area"); handMeldNode.id = "meld-area";
    handRow = element("div", "hand-region");
    handRow.setAttribute("aria-label", "手牌");
    handRow.ondragover = event => previewHandDrop(event);
    handRow.ondrop = event => commitHandDrop(event);
    handRenderOwner = owner; root.append(handMeldNode, handRow);
    root.ondragover = event => { if (event.target === root) previewHandDrop(event); };
    root.ondrop = event => { if (event.target === root) commitHandDrop(event); };
    $("hand-scroll").onscroll = () => { if (dragging?.kind === "hand") dragging.geometry = null; };
  }
  const records = new Map(player.hand_tile_records.map(t => [t.tile_id, t.value]));
  for (const [id, node] of handTiles) if (!records.has(id)) { node.remove(); handTiles.delete(id); }
  const scroll = $("hand-scroll").scrollLeft;
  const nodes = player.hand_tile_records.map(({tile_id, value}) => {
    const node = handTileNode(tile_id, value);
    node.disabled = !!player.is_out || !!ui().recovery_pending || !!ui().autopilot || !!(state.network?.enabled && !localRoom?.connectionId);
    node.draggable = !!ui().sorting_allowed;
    node.classList.toggle("selected", selected === tile_id || chiSelection.has(tile_id));
    node.classList.toggle("number-view", numberView);
    return node;
  });
  placeHandNodes(handRow, nodes);
  if ($("hand-scroll").scrollLeft !== scroll) $("hand-scroll").scrollLeft = scroll;
}

function clearDrop() {
  dropPreview?.zone.classList.remove("drop-active");
  dropIndicator?.remove(); dropPreview = null;
  if (dragging?.kind === "deck") document.querySelectorAll(".drop-target").forEach(n => n.classList.remove("drop-target"));
}

function endDrag(redraw = true) {
  const previous = dragging;
  clearDrop(); dragging = null;
  previous?.node?.classList.remove("dragging");
  if (previous?.kind === "hand") {
    suppressedDragClick = previous.id; dragClickUntil = performance.now() + 250;
    if (redraw && state) { renderHand(); renderMelds(); }
  }
}

function renderMelds() {
  const root = $("meld-area"), key = JSON.stringify([me().melded_groups, numberView]);
  if (root === meldRenderRoot && key === meldRenderKey) return;
  root.replaceChildren();
  for (const meld of me().melded_groups) {
    const group = element("div", "meld"); group.title = meld.group_type;
    const faces = meld.display_tiles || meld.tiles.map((value) => ({ value, orientation: "upright" }));
    for (const face of faces) {
      const node = tile(face.value);
      if (face.orientation === "sideways") node.classList.add("sideways");
      if (face.orientation === "back") { node.classList.add("back"); node.setAttribute("aria-label", "背面牌"); }
      group.append(node);
    }
    root.append(group);
  }
  meldRenderRoot = root; meldRenderKey = key;
}

function renderTable() {
  $("incoming-tile").replaceChildren();
  const response = ["WAITING_RESPONSE", "WAITING_ACTION_DETAIL"].includes(state.phase);
  const rob = state.rob_kong_window;
  const drawn = me().hand_tile_records.find((t) => t.tile_id === ui().drawn_tile_id);
  const value = rob ? rob.tile : response ? state.last_discard?.tile : stage() === "OWN_TURN" ? drawn?.value : null;
  if (value !== null && value !== undefined) $("incoming-tile").append(tile(value));
  $("incoming-caption").textContent = rob ? `${state.players.find((p) => p.player_id === rob.source_player_id)?.name}加杠` : response ? "来牌" : drawn ? "本次摸牌" : stage() === "OWN_TURN" ? "待出牌" : "等待来牌";
  const river = $("discard-river"); river.replaceChildren();
  const four = ui().mode === "four";
  $("discard-label").textContent = four ? "我的弃牌" : "弃牌";
  river.setAttribute("aria-label", four ? "我的弃牌" : "弃牌");
  if (four) {
    river.dataset.playerId = me().player_id;
    appendDiscards(river, me());
    $("discard-count").textContent = `${me().discarded_tiles.length} 张`;
    return;
  }
  delete river.dataset.playerId;
  const visibleDiscards = state.players.flatMap((p) => p.discarded_tiles);
  // History also contains claimed tiles; only render discards still in the river.
  const counts = new Map(); visibleDiscards.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  const history = state.discard_history.slice().reverse().filter((record) => {
    if (!(counts.get(record.tile) > 0)) return false;
    counts.set(record.tile, counts.get(record.tile) - 1); return true;
  }).reverse();
  for (const record of history) {
    const node = tile(record.tile); node.title = `${state.players.find((p) => p.player_id === record.player_id)?.name}的弃牌`; river.append(node);
  }
  $("discard-count").textContent = `${history.length} 张`;
}

function appendDiscards(root, player) {
  for (const value of player.discarded_tiles) {
    const node = tile(value);
    node.title = `${player.name}的弃牌`;
    root.append(node);
  }
}

function action(label, handler, className = "", disabled = false, symbol = null) {
  const node = element("button", `action-button ${className}`, label);
  if (symbol) node.append(icon(symbol));
  node.disabled = disabled || busy; node.onclick = handler; $("actions").append(node);
}

function renderActions() {
  $("actions").replaceChildren(); $("chi-options").replaceChildren();
  if (localRoom?.renderActions()) return;
  const status = $("action-status");
  if (localRoom && !viewerId() && stage() !== "ROUND_ENDED") {
    status.textContent = ui().started ? "观战中" : "等待房主安排四人开局";
    if (state.room?.is_host) action("房主设置", openSettings, "primary");
    return;
  }
  if (ui().recovery_pending) {
    status.textContent = "对局已暂停";
    action("恢复对局", renderRecovery, "primary", false, "arrow-right");
  } else if (stage() === "LOBBY") {
    status.textContent = "等待确认开局设置";
    action("开局设置", openSettings, "primary", false, "arrow-right");
  } else if (stage() === "BOT_TURN") {
    status.textContent = `${state.players[state.current_turn_seat].name}的回合`;
  } else if (stage() === "HAND_PREPARATION") {
    status.textContent = "可以拖牌排序，理牌结束后庄家开始回合";
  } else if (stage() === "READY_SOURCE") {
    status.textContent = "来牌待翻开";
    action("翻牌", () => send("reveal"), "primary", false, "arrow-right");
  } else if (stage() === "WAITING_DRAW") {
    status.textContent = "响应已结束";
    action("摸牌", () => send("draw"), "primary", false, "plus");
  } else if (stage() === "WAITING_RESPONSE") {
    const window = state.response_window;
    const submitted = !!window.requests_by_player[viewerId()];
    const options = window.options_by_player[viewerId()] || [];
    status.textContent = submitted ? "已提交，等待响应结束" : options.length ? "选择来牌操作" : "等待响应结束";
    for (const option of options) action(LABEL[option.action_type], () => send("response", { action: option.action_type, window_id: window.window_id }),
      option.action_type === "HU" ? "hu" : option.action_type === "PASS" ? "" : "primary", submitted);
  } else if (stage() === "WAITING_ACTION_DETAIL") {
    const detail = state.pending_action_detail;
    if (manualChi()) {
      status.textContent = `已选 ${chiSelection.size} / 3 张`;
      action("确认吃牌", () => send("chi", { tile_ids: [...chiSelection], detail_id: detail.detail_id }), "primary", chiSelection.size !== 3, "check");
    } else {
      status.textContent = `${detail.payload_options.length} 种吃法`;
      for (const option of detail.payload_options) {
        const choice = element("button", "chi-choice");
        choice.disabled = busy;
        choice.title = `吃 ${option.preview}`; choice.setAttribute("aria-label", choice.title);
        option.display_tiles.forEach((value, index) => {
          const node = tile(value); if (index === option.claimed_display_index) node.classList.add("claimed"); choice.append(node);
        });
        choice.onclick = () => send("chi", { option_id: option.option_id, detail_id: detail.detail_id });
        $("chi-options").append(choice);
      }
    }
    action("过", () => send("chi", { detail_id: detail.detail_id }));
  } else if (stage() === "OWN_TURN") {
    const options = state.turn_options_by_player[viewerId()] || [];
    let blocked = false, hasPrompt = false;
    for (const option of options) {
      const kind = option.action_type;
      if (kind === "HU" && !state.turn_hu_prompt_passed) {
        hasPrompt = true;
        action("胡", () => send("turn_action", { action: kind }), "hu");
      }
      if (["AN_GANG", "JIA_GANG"].includes(kind) && !state.turn_gang_prompt_passed) {
        blocked = hasPrompt = true;
        for (const payload of option.payload_options) action(`${LABEL[kind]} ${payload.tile}`, () => send("turn_action", { action: kind, option_id: payload.option_id }), "gang");
      }
    }
    if (hasPrompt) action("过", () => send("turn_action", { action: "PASS" }));
    status.textContent = blocked ? "有杠牌选项" : selected ? `已选 ${me().hand_tile_records.find((t) => t.tile_id === selected)?.value}` : "我的回合";
    action("出牌", () => send("discard", { tile_id: selected }), "primary", !selected || blocked, "arrow-right");
  } else if (stage() === "WAITING_ROB_KONG" && state.rob_kong_window) {
    status.textContent = "t4 · 抢杠响应";
    for (const option of state.rob_kong_window.options) action(LABEL[option.action_type], () => send("rob_response", { action: option.action_type, window_id: state.rob_kong_window.window_id }), option.action_type === "HU" ? "hu" : "", state.rob_kong_window.submitted);
  } else if (stage() === "ROUND_ENDED") {
    status.textContent = state.round_result.end_reason === "wall_empty" ? "牌山已空" : "本局已结算";
    action("查看结算", showResult, "primary");
  } else status.textContent = "等待其他玩家响应";
}

function renderTimer() {
  if (localRoom && state) localRoom.renderConnectionCountdown();
  if (state && ui().recovery_pending) {
    const remaining = ui().recovery_remaining_seconds;
    $("timer").hidden = false;
    $("timer").textContent = remaining == null ? "已暂停" : `${Math.ceil(remaining)}s · 暂停`;
    $("timer").classList.remove("urgent");
    return;
  }
  const timer = state?.active_timer;
  const paused = state?.paused_turn_remaining_seconds;
  $("timer").hidden = !timer && paused === null;
  if (!timer && paused !== null && paused !== undefined) { $("timer").textContent = `${Math.ceil(paused)}s · 暂停`; return; }
  if (!timer) return;
  const seconds = Math.max(0, timer.deadline_at - state.server_now - (performance.now() - receivedAt) / 1000);
  const name = { HAND_PREPARATION: "理牌", RESPONSE_WINDOW: "t1", DETAIL_SELECTION: "t2", TURN_DECISION: "t3", ROB_KONG_RESPONSE: "t4" }[timer.kind];
  $("timer").textContent = `${name} · ${Math.ceil(seconds)}s`;
  $("timer").classList.toggle("urgent", seconds <= 5);
}

function renderOpponents() {
  const root = $("opponent-seats"); root.hidden = ui().mode !== "four"; root.replaceChildren();
  if (root.hidden) return;
  for (const offset of [3, 2, 1]) {
    const seat = ((localRoom ? state.viewer_seat || 0 : 0) + offset) % 4;
    const player = state.players[seat];
    const panel = element("div", "opponent-seat");
    panel.classList.toggle("active", state.phase === "WAITING_TURN_ACTION" && state.current_turn_seat === seat);
    panel.dataset.seat = seat;
    const heading = element("div", "opponent-heading");
    heading.append(element("strong", "", player.name), element("span", "", `${player.is_dealer ? "庄 · " : ""}${player.is_out ? `已胡 · 第${player.win_order}位 · ` : ""}${player.hand_count} 张`));
    const backs = element("div", "opponent-hand");
    for (let i = 0; i < player.hand_count; i++) backs.append(player.observer_tiles ? tile(player.observer_tiles[i]) : element("span", "mini-back"));
    panel.append(heading, backs, element("span", "opponent-score", `${player.score} 分`));
    if (localRoom) {
      const melds = element("div", "opponent-melds");
      for (const meld of player.melded_groups) {
        const group = element("span", "meld");
        for (const face of meld.display_tiles || meld.tiles.map((value) => ({ value }))) {
          const node = tile(face.value);
          if (face.orientation === "back") node.classList.add("back");
          if (face.orientation === "sideways") node.classList.add("sideways");
          group.append(node);
        }
        melds.append(group);
      }
      panel.append(melds);
    }
    const discards = element("div", "opponent-discard-zone");
    const caption = element("div", "zone-heading");
    caption.append(element("span", "", "弃牌"), element("span", "", `${player.discarded_tiles.length} 张`));
    const river = element("div", "discard-river opponent-discards");
    river.dataset.playerId = player.player_id;
    river.setAttribute("aria-label", `${player.name}的弃牌`);
    appendDiscards(river, player);
    discards.append(caption, river);
    panel.append(discards);
    root.append(panel);
  }
}

function visiblePhase() {
  if (localRoom && state.active_timer?.kind === "ROB_KONG_RESPONSE") return "t4";
  if (state.phase === "WAITING_ROB_KONG") return state.rob_kong_window ? "t4" : "t3";
  return { WAITING_RESPONSE: "t1", WAITING_ACTION_DETAIL: "t2", WAITING_TURN_ACTION: "t3" }[state.phase];
}

function renderFlow() {
  $("flow-monitor").hidden = !ui().started;
  $("phase-steps").replaceChildren(); $("phase-history").replaceChildren();
  if (!ui().started) return;
  for (const [, phase, label] of TIMER_FIELDS) {
    const node = element("span", "phase-step", `${phase} ${label}`);
    node.classList.toggle("active", visiblePhase() === phase); $("phase-steps").append(node);
  }
  for (const entry of (ui().phase_history || []).slice(-7)) {
    const name = state.players.find((p) => p.player_id === entry.player_id)?.name;
    $("phase-history").append(element("span", "", `${entry.number}. ${entry.phase} · ${name}`));
  }
}

function openSettings() {
  if (localRoom) { localRoom.openSettings(); return; }
  if (!("started" in ui())) { send("scene", { scene: ui().scene }); return; }
  renderSettings();
  if (!$("setup-dialog").open) $("setup-dialog").showModal();
}

function syncSettingControls() {
  const locked = ui().settings_locked;
  const enabled = $("timers-enabled").checked;
  document.querySelectorAll(".timer-setting").forEach((row) => {
    row.querySelector("[type=checkbox]").disabled = locked || !enabled;
    row.querySelector("[type=number]").disabled = locked || !enabled || !row.querySelector("[type=checkbox]").checked;
  });
  const solo = document.querySelector('[name="game-mode"]:checked').value === "solo";
  $("setup-scene-row").hidden = !solo;
}

function renderSettings() {
  if (localRoom) return;
  const practice = ui();
  if (!("started" in practice)) return;
  const key = `${state.game_id}:${practice.settings_locked}:${JSON.stringify(practice.timeout_settings)}`;
  if (key !== settingsKey) {
    settingsKey = key;
    $("setup-error").textContent = "";
    $("timer-settings").replaceChildren();
    for (const [field, phase, label, fallback] of TIMER_FIELDS) {
      const value = practice.timeout_settings[field];
      const row = element("div", "timer-setting"); row.dataset.field = field;
      const toggle = element("input"); toggle.type = "checkbox"; toggle.checked = value !== null; toggle.setAttribute("aria-label", `启用 ${phase}`); toggle.onchange = syncSettingControls;
      const input = element("input"); input.type = "number"; input.min = "1"; input.max = "600"; input.step = "1"; input.value = value ?? fallback; input.setAttribute("aria-label", `${phase} 秒数`);
      row.append(toggle, element("strong", "", phase), element("span", "", label), input, element("small", "", "秒")); $("timer-settings").append(row);
    }
    $("timers-enabled").checked = Object.values(practice.timeout_settings).some((v) => v !== null);
    $("timers-enabled").disabled = practice.settings_locked;
    document.querySelectorAll('[name="game-mode"]').forEach((input) => { input.checked = input.value === practice.mode; input.disabled = practice.settings_locked; });
    $("setup-scene").replaceChildren();
    for (const [value, label] of Object.entries(practice.scenes)) { const option = element("option", "", label); option.value = value; $("setup-scene").append(option); }
    $("setup-scene").value = practice.scene;
    $("setup-scene").disabled = practice.settings_locked;
    $("start-game").hidden = practice.started;
    $("reset-game").hidden = !practice.started;
    $("setup-status").textContent = practice.started ? "本局计时与模式已锁定" : "开局前可调整";
    syncSettingControls();
  }
  if (!practice.started && setupShownFor !== state.round_id) {
    setupShownFor = state.round_id;
    if (!$("setup-dialog").open) $("setup-dialog").showModal();
  }
}

function renderDeck() {
  if (localRoom) return;
  const values = ui().wall_tiles;
  const root = $("deck-grid"), scroll = root.scrollTop; root.replaceChildren();
  if (deckSelection >= values.length) deckSelection = null;
  $("next-tile").replaceChildren();
  if (values.length) $("next-tile").append(tile(values[0]));
  $("deck-remaining").textContent = values.length;
  const editable = ui().editing_allowed;
  $("deck-to-front").disabled = !editable || deckSelection === null || deckSelection === 0;
  $("deck-delete").disabled = !editable || deckSelection === null;
  $("deck-selection").textContent = deckSelection === null ? "未选中牌" : `第 ${deckSelection + 1} 张 · ${values[deckSelection]}`;
  values.forEach((value, index) => {
    const cell = element("button", "deck-cell"); cell.title = `第 ${index + 1} 张：${value}`;
    cell.setAttribute("aria-label", cell.title); cell.classList.toggle("selected", index === deckSelection);
    cell.append(tile(value), element("span", "", String(index + 1).padStart(2, "0")));
    cell.onclick = () => { deckSelection = index; renderDeck(); };
    cell.draggable = editable;
    cell.ondragstart = (event) => {
      dragging = { kind: "deck", index }; event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    };
    cell.ondragend = endDrag;
    cell.ondragover = (event) => { if (dragging?.kind === "deck") { event.preventDefault(); clearDrop(); cell.classList.add("drop-target"); } };
    cell.ondrop = (event) => {
      if (dragging?.kind !== "deck") return;
      event.preventDefault(); const from = dragging.index; endDrag();
      const tiles = [...values]; const [value] = tiles.splice(from, 1); tiles.splice(index, 0, value);
      deckSelection = index; send("edit_wall", { tiles });
    };
    root.append(cell);
  });
  root.scrollTop = scroll;
}

function renderActivity() {
  const event = state.event_log.at(-1);
  const labels = { tile_drawn: "已摸牌", tile_discarded: "已出牌", hand_tile_moved: "手牌位置已更新", turn_action_passed: "已跳过本次提示", chi_completed: "吃牌完成", peng_completed: "碰牌完成", gang_completed: "杠牌完成", win_settled: "胡牌已结算", round_ended: "本局结束", practice_wall_edited: "牌堆已更新", practice_hand_edited: "手牌已更新", response_window_opened: "来牌响应中", detail_selection_opened: "等待选择吃法" };
  $("activity-text").textContent = event ? labels[event.event_type] || labels[event.type] || STAGES[stage()] : "等待第一张来牌";
}

function openEditor(kind) {
  if (!ui().editing_allowed) return;
  editorKind = kind;
  $("editor-title").textContent = kind === "edit_wall" ? "编辑牌堆" : "编辑手牌";
  $("editor-order").textContent = kind === "edit_wall" ? "摸牌顺序 · 下一张在最前" : "手牌顺序";
  $("tile-input").value = JSON.stringify(kind === "edit_wall" ? ui().wall_tiles : me().hand_tiles);
  $("editor-error").textContent = "";
  $("editor-dialog").showModal();
}

function showResult() {
  const finished = Boolean(state.round_result);
  const partial = !finished && state.config?.mode === "blood_battle" && state.settlement_events?.length;
  const result = state.round_result || (partial ? { settlement_events: state.settlement_events,
    score_deltas: state.players.map((player) => ({ player_id: player.player_id,
      delta: state.settlement_events.reduce((total, event) => total + (event.score_deltas.find((item) => item.player_id === player.player_id)?.delta || 0), 0) })) } : null);
  if (!result) return;
  const content = $("result-content"); content.replaceChildren();
  const ownEvent = result.settlement_events.find((e) => e.winner_id === viewerId());
  const events = localRoom ? result.settlement_events : ownEvent ? [ownEvent] : [];
  $("result-title").textContent = events.length ? `${events[0].win_result.win_method} · 胡牌` : "流局";
  if (state.config?.mode === "blood_battle") $("result-title").textContent = finished
    ? (result.end_reason === "wall_empty" ? "血战流局 · 保留此前结算" : "血战结束 · 三家已胡")
    : `血战即时结算 · 已胡 ${events.length}/3 家`;
  if (partial) content.append(element("p", "result-method", "血战仍在继续，整局结束后可查看牌山。"));
  for (const event of events) {
    if (localRoom) content.append(element("h3", "", `${event.win_order ? `第 ${event.win_order} 位 · ` : ""}${state.players.find((p) => p.player_id === event.winner_id)?.name}`));
    const win = event.win_result;
    const summary = element("div", "result-summary");
    summary.append(element("strong", "result-fan", win.total_fan), element("span", "", "番"));
    const payment = element("div", "result-payment");
    payment.append(element("strong", "", `+${event.score_deltas.find((d) => d.player_id === event.winner_id)?.delta || 0}`), "分"); summary.append(payment);
    const groups = element("div", "result-groups");
    for (const values of win.groups) { const group = element("div", "result-group"); displayFormula(values).forEach((v) => group.append(tile(v))); groups.append(group); }
    content.append(summary, groups);
    for (const item of win.fan_items) {
      const row = element("div", "fan-row"); const name = element("span", "", item.name);
      if (item.count > 1) name.append(element("small", "", `×${item.count}`));
      row.append(name, element("span", "", `${item.total_fan} 番`)); content.append(row);
    }
    const payers = event.score_deltas.filter((item) => item.delta < 0).map((item) => state.players.find((player) => player.player_id === item.player_id)?.name).join("、");
    content.append(element("p", "result-method", `${win.win_method} · ${win.win_type} · 起和 ${win.starting_fan} 番 · 计分 ${win.capped_fan} 番 · 每家 ${win.base_payment} 分${localRoom ? ` · 付款：${payers}` : ""}`));
  }
  if (!events.length) content.append(element("p", "draw-result", "牌山已空，本局分数不变。"));
  if (localRoom) {
    $("next-round-button").hidden = !finished;
    for (const player of state.players) {
      const delta = result.score_deltas.find((item) => item.player_id === player.player_id)?.delta || 0;
      content.append(element("p", "fan-row", `${player.name} · 座位 ${player.seat + 1} · 本局 ${delta >= 0 ? "+" : ""}${delta} · 累计 ${player.score} 分`));
    }
    $("next-round-button").disabled = !state.room?.is_host;
  }
  if (!$("result-dialog").open) $("result-dialog").showModal();
}

function displayFormula(values) {
  // Calculator groups are operator-first; this is presentation, not validation.
  const op = values.find((v) => v === "+" || v === "×");
  const numbers = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!op || values.length !== 4 || numbers.length !== 3) return values;
  for (let left = 0; left < 3; left++) {
    for (let right = left + 1; right < 3; right++) {
      const result = numbers[3 - left - right];
      if ((op === "+" ? numbers[left] + numbers[right] : numbers[left] * numbers[right]) === result) return [numbers[left], op, numbers[right], result];
    }
  }
  return values;
}

window.addEventListener?.("resize", () => { if (dragging?.kind === "hand") dragging.geometry = null; });
$("scene-select").onchange = () => send("scene", { scene: $("scene-select").value });
function renderRecovery() {
  if (localRoom) { localRoom.renderRecovery(); return; }
  const dialog = $("recovery-dialog");
  if (!ui().recovery_pending) { if (dialog.open) dialog.close(); return; }
  $("stage-label").textContent = "对局已暂停";
  $("recovery-summary").textContent = `第 ${ui().round_number} 局 · 牌山 ${state.wall.remaining_count} 张`;
  const remaining = ui().recovery_remaining_seconds;
  $("recovery-time").textContent = remaining == null ? "对局已暂停" : `操作剩余 ${Math.ceil(remaining)} 秒`;
  $("recovery-error").textContent = ui().storage_error ? "存档写入失败，对局已退回最后保存点并暂停。" : "";
  for (const id of ["setup-dialog", "editor-dialog", "result-dialog"]) if ($(id).open) $(id).close();
  if (!dialog.open) dialog.showModal();
}
$("recovery-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("recovery-resume").onclick = () => send("resume");
$("recovery-reset").onclick = () => { if (confirm("放弃保存的对局并返回开局设置？")) send("reset", { round_id: state.round_id }); };
$("restart-button").onclick = openSettings;
$("timers-enabled").onchange = () => {
  const toggles = [...document.querySelectorAll('.timer-setting [type="checkbox"]')];
  if ($("timers-enabled").checked && !toggles.some((input) => input.checked)) toggles.forEach((input) => { input.checked = true; });
  syncSettingControls();
};
document.querySelectorAll('[name="game-mode"]').forEach((input) => { input.onchange = syncSettingControls; });
$("setup-form").onsubmit = async (event) => {
  event.preventDefault();
  const timeouts = {};
  document.querySelectorAll(".timer-setting").forEach((row) => {
    timeouts[row.dataset.field] = $("timers-enabled").checked && row.querySelector("[type=checkbox]").checked ? Number(row.querySelector("[type=number]").value) : null;
  });
  if (await send("start", { mode: document.querySelector('[name="game-mode"]:checked').value, scene: $("setup-scene").value, timeouts })) $("setup-dialog").close();
};
$("reset-game").onclick = () => send("reset", { round_id: state.round_id });
$("developer-toggle").onclick = () => $("developer-panel").classList.toggle("open");
$("developer-close").onclick = () => $("developer-panel").classList.remove("open");
$("face-mode").onclick = () => setAppearance(false);
$("number-mode").onclick = () => setAppearance(true);
function setAppearance(value) { numberView = value; $("face-mode").classList.toggle("active", !value); $("number-mode").classList.toggle("active", value); render(); }
$("edit-hand").onclick = () => openEditor("edit_hand");
$("edit-wall").onclick = $("deck-add").onclick = () => openEditor("edit_wall");
$("deck-to-front").onclick = () => { const tiles = [...ui().wall_tiles]; tiles.unshift(...tiles.splice(deckSelection, 1)); deckSelection = 0; send("edit_wall", { tiles }); };
$("deck-delete").onclick = () => { const tiles = [...ui().wall_tiles]; tiles.splice(deckSelection, 1); deckSelection = null; send("edit_wall", { tiles }); };
$("show-result").onclick = showResult;
$("next-round-button").onclick = async () => {
  if (localRoom) { await localRoom.nextRound(); return; }
  if (await send("next_round", { round_id: state.round_id })) $("result-dialog").close();
};
document.querySelectorAll("[data-close]").forEach((node) => { node.onclick = () => $(node.dataset.close).close(); });
$("editor-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const tiles = JSON.parse($("tile-input").value);
    if (!Array.isArray(tiles)) throw new Error("请输入 JSON 数组");
    if (await send(editorKind, { tiles })) $("editor-dialog").close();
  } catch (error) { $("editor-error").textContent = error.message; }
};
for (const value of VALUES) {
  const button = element("button", "", value); button.type = "button";
  button.title = `添加 ${value}`;
  button.onclick = () => {
    try {
      const tiles = JSON.parse($("tile-input").value);
      if (!Array.isArray(tiles)) throw new Error("请输入 JSON 数组");
      tiles.push(value); $("tile-input").value = JSON.stringify(tiles); $("editor-error").textContent = "";
    } catch (error) { $("editor-error").textContent = error.message; }
  };
  $("tile-palette").append(button);
}
poll();
setInterval(poll, 700);
setInterval(() => { if (state) renderTimer(); }, 100);
