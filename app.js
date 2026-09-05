const STORAGE_KEY = "venue-countdown-game-v1";
const ANSWERED_KEY = "venue-countdown-answered-question-v1";
const PARTICIPANT_KEY = "venue-countdown-participant-id-v1";
const ACCESS_TOKEN = "321-live-8kq4";
const API_URL = (window.EVENT_API_URL || "").trim();
const SUPABASE_URL = (window.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (window.SUPABASE_ANON_KEY || "").trim();
const SEARCH_PARAMS = new URLSearchParams(location.search);
const ACCESS_GRANTED = hasAccess();
const PARTICIPANT_MODE = SEARCH_PARAMS.has("participant");
const OVERLAY_VALUE = SEARCH_PARAMS.get("overlay");
const OVERLAY_MODE = SEARCH_PARAMS.has("overlay");
const OVERLAY_PARTS = new Set(["topic", "teamA", "teamB"]);
const OVERLAY_PART = OVERLAY_PARTS.has(OVERLAY_VALUE) ? OVERLAY_VALUE : "all";

const defaultState = {
  teamAName: "チームA",
  teamBName: "チームB",
  startNumber: 1000,
  scoreA: 1000,
  scoreB: 1000,
  currentTeam: "A",
  turn: 1,
  turnLabel: "1ターン目",
  questionId: 1,
  question: "今日関東から来た人",
  answerDuration: 60,
  answerDeadline: "1970-01-01T00:00:00.000Z",
  winMode: "zero",
  history: [],
  latest: null
};

let state = loadLocalState();
let answerChoice = "○";
let timerId = null;
let pollId = null;
let syncing = false;
let submittingAnswer = false;
let syncStatus = {
  type: "idle",
  text: "同期状態を確認中"
};

const $ = (id) => document.getElementById(id);

function hasAccess() {
  return SEARCH_PARAMS.get("access") === ACCESS_TOKEN;
}

function renderAccessGate() {
  $("accessForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("accessCode").value.trim() !== ACCESS_TOKEN) {
      $("accessError").hidden = false;
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set("access", ACCESS_TOKEN);
    location.href = url.toString();
  });
}

function isRemoteMode() {
  return isSupabaseMode() || API_URL.length > 0;
}

function isSupabaseMode() {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

function loadLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(defaultState);
  try {
    return { ...structuredClone(defaultState), ...JSON.parse(raw) };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event("game-state-updated"));
}

function participantId() {
  let id = localStorage.getItem(PARTICIPANT_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PARTICIPANT_KEY, id);
  }
  return id;
}

function apiRequest(action, payload = {}) {
  if (isSupabaseMode()) {
    return supabaseRequest(action, payload);
  }
  return new Promise((resolve, reject) => {
    const callback = `eventApi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    url.searchParams.set("payload", JSON.stringify(payload));
    url.searchParams.set("callback", callback);

    window[callback] = (response) => {
      delete window[callback];
      script.remove();
      if (response && response.ok) {
        resolve(response);
      } else {
        reject(new Error(response?.error || "API request failed"));
      }
    };

    script.onerror = () => {
      delete window[callback];
      script.remove();
      reject(new Error("API request failed"));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.hint || `Supabase request failed: ${response.status}`);
  }
  return data;
}

function publicState(value) {
  return {
    ...structuredClone(defaultState),
    ...value,
    history: Array.isArray(value?.history) ? value.history : [],
  };
}

function stateForStorage(value) {
  const clean = { ...value };
  delete clean.history;
  delete clean.answerCounts;
  return clean;
}

async function readSupabaseState(options = {}) {
  const includeCounts = options.includeCounts ?? !PARTICIPANT_MODE;
  const includeManualHistory = options.includeManualHistory ?? !PARTICIPANT_MODE;
  const rows = await supabaseFetch("event_state?id=eq.1&select=state");
  const base = publicState(rows?.[0]?.state || defaultState);
  const [counts, manualHistory] = await Promise.all([
    includeCounts ? readSupabaseCounts(base.questionId) : Promise.resolve(null),
    includeManualHistory ? readSupabaseManualHistory() : Promise.resolve(null),
  ]);
  return {
    ...base,
    ...(counts ? { answerCounts: counts } : {}),
    ...(manualHistory ? { history: manualHistory } : {}),
  };
}

async function readSupabaseCounts(questionId) {
  const rows = await supabaseFetch(`event_answers?question_id=eq.${encodeURIComponent(questionId)}&status=eq.active&select=answer`);
  return rows.reduce((acc, row) => {
    if (row.answer === "×") acc.cross += 1;
    if (row.answer === "○") acc.circle += 1;
    acc.total = acc.circle + acc.cross;
    return acc;
  }, { circle: 0, cross: 0, total: 0 });
}

async function readSupabaseManualHistory() {
  const rows = await supabaseFetch("event_manual?order=applied_at.desc&limit=120&select=id,applied_at,question_id,question,team,answer,points,note");
  return rows.map((row) => {
    const note = row.note || "";
    const undo = note.startsWith("undo:");
    return {
      id: row.id,
      team: row.team,
      answer: row.answer,
      points: Math.max(0, Math.floor(Number(row.points || 0))),
      questionId: row.question_id,
      question: row.question,
      createdAt: row.applied_at,
      appliedAt: row.applied_at,
      turnLabel: extractTurnLabelFromNote(note),
      undo,
      undoTargetId: undo ? note.replace("undo:", "") : "",
    };
  });
}

async function writeSupabaseState(nextState) {
  const body = {
    id: 1,
    state: stateForStorage(nextState),
    updated_at: new Date().toISOString(),
  };
  await supabaseFetch("event_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
}

async function appendSupabaseManual(item, nextState) {
  await supabaseFetch("event_manual", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: item.id,
      applied_at: item.appliedAt || item.createdAt,
      question_id: item.questionId,
      question: item.question,
      team: item.team,
      answer: item.answer,
      points: item.points,
      score_a: nextState.scoreA,
      score_b: nextState.scoreB,
      note: item.undo ? `undo:${item.undoTargetId || ""}` : turnLabelNote(item.turnLabel),
    }),
  });
}

async function supabaseRequest(action, payload = {}) {
  let remoteState = await readSupabaseState({ includeCounts: false, includeManualHistory: false });

  if (action === "state") {
    remoteState = await readSupabaseState();
    return { ok: true, state: remoteState };
  }

  if (action === "settings") {
    const previousQuestion = remoteState.question;
    const previousStart = remoteState.startNumber;
    remoteState.teamAName = String(payload.teamAName || "チームA").trim() || "チームA";
    remoteState.teamBName = String(payload.teamBName || "チームB").trim() || "チームB";
    remoteState.startNumber = Math.max(1, Math.floor(Number(payload.startNumber || 1000)));
    remoteState.winMode = String(payload.winMode || "zero").trim() || "zero";
    remoteState.turnLabel = String(payload.turnLabel || `${remoteState.turn}ターン目`).trim() || `${remoteState.turn}ターン目`;
    remoteState.question = String(payload.question || "今日関東から来た人").trim() || "今日関東から来た人";
    remoteState.answerDuration = Math.max(5, Math.floor(Number(payload.answerDuration || 60)));
    if (remoteState.question !== previousQuestion) {
      remoteState.questionId += 1;
    }
    remoteState.answerDeadline = deadlineFromNowFor(remoteState.answerDuration);
    if (previousStart !== remoteState.startNumber) {
      remoteState.scoreA = remoteState.startNumber;
      remoteState.scoreB = remoteState.startNumber;
    }
    remoteState.history = [];
    await writeSupabaseState(remoteState);
  }

  if (action === "answer") {
    if (isClosedState(remoteState)) {
      return { ok: true, state: remoteState };
    }
    await supabaseFetch("event_answers?on_conflict=question_id,client_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        id: payload.id || crypto.randomUUID(),
        client_id: String(payload.clientId || "").trim(),
        team: remoteState.currentTeam,
        answer: payload.answer === "×" ? "×" : "○",
        points: payload.answer === "×" ? 0 : 1,
        question_id: remoteState.questionId,
        question: remoteState.question,
        status: "active",
        created_at: new Date().toISOString(),
      }),
    });
    return { ok: true, state: remoteState };
  }

  if (action === "manual") {
    const item = {
      id: payload.id || crypto.randomUUID(),
      team: payload.team === "B" ? "B" : "A",
      answer: String(payload.answer || "手動反映").trim() || "手動反映",
      points: Math.max(0, Math.floor(Number(payload.points || 0))),
      questionId: remoteState.questionId,
      question: remoteState.question,
      turnLabel: remoteState.turnLabel,
      createdAt: new Date().toISOString(),
      appliedAt: new Date().toISOString(),
    };
    applyPointsToState(remoteState, item);
    remoteState.latest = item;
    remoteState.history = [];
    await appendSupabaseManual(item, remoteState);
    await writeSupabaseState(remoteState);
  }

  if (action === "undoManual") {
    const rows = await supabaseFetch("event_manual?team=in.(A,B)&points=gt.0&order=applied_at.desc&limit=1&select=id,team,points,question_id,question,note");
    const target = rows.find((row) => !(row.note || "").startsWith("undo:"));
    if (target) {
      const item = {
        id: crypto.randomUUID(),
        team: target.team,
        answer: "取り消し",
        points: Math.max(0, Math.floor(Number(target.points || 0))),
        questionId: target.question_id,
        question: target.question,
        turnLabel: extractTurnLabelFromNote(target.note || ""),
        createdAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
        undo: true,
        undoTargetId: target.id,
      };
      if (item.team === "A") remoteState.scoreA += item.points;
      if (item.team === "B") remoteState.scoreB += item.points;
      remoteState.latest = item;
      remoteState.history = [];
      await appendSupabaseManual(item, remoteState);
      await writeSupabaseState(remoteState);
    }
  }

  if (action === "nextTurn") {
    remoteState.turn += 1;
    remoteState.turnLabel = `${remoteState.turn}ターン目`;
    remoteState.currentTeam = remoteState.currentTeam === "A" ? "B" : "A";
    remoteState.questionId += 1;
    remoteState.answerDeadline = closedDeadline();
    remoteState.history = [];
    await writeSupabaseState(remoteState);
  }

  if (action === "closeAnswers") {
    remoteState.answerDeadline = closedDeadline();
    remoteState.history = [];
    await writeSupabaseState(remoteState);
  }

  if (action === "swapTeam") {
    remoteState.currentTeam = remoteState.currentTeam === "A" ? "B" : "A";
    remoteState.history = [];
    await writeSupabaseState(remoteState);
  }

  if (action === "clearCurrentAnswers") {
    await supabaseFetch(`event_answers?question_id=eq.${encodeURIComponent(remoteState.questionId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "cleared" }),
    });
  }

  if (action === "reset") {
    remoteState.scoreA = remoteState.startNumber;
    remoteState.scoreB = remoteState.startNumber;
    remoteState.currentTeam = "A";
    remoteState.turn = 1;
    remoteState.turnLabel = "1ターン目";
    remoteState.questionId += 1;
    remoteState.answerDeadline = closedDeadline();
    remoteState.history = [];
    remoteState.latest = null;
    await writeSupabaseState(remoteState);
  }

  const next = await readSupabaseState({
    includeCounts: action !== "answer",
    includeManualHistory: action !== "answer",
  });
  return { ok: true, state: next };
}

async function syncFromRemote() {
  if (!isRemoteMode() || syncing) return;
  syncing = true;
  try {
    const response = await apiRequest("state");
    state = { ...structuredClone(defaultState), ...response.state };
    setSyncStatus("ok", `同期済み ${formatStatusTime(new Date())}`);
    saveLocalState();
    render();
  } catch (error) {
    console.warn(error);
    setSyncStatus("error", `同期エラー ${formatStatusTime(new Date())}`);
    renderSyncStatus();
  } finally {
    syncing = false;
  }
}

async function runRemoteAction(action, payload = {}) {
  setSyncStatus("saving", "保存中");
  renderSyncStatus();
  const response = await apiRequest(action, payload);
  state = { ...structuredClone(defaultState), ...response.state };
  setSyncStatus("ok", `保存済み ${formatStatusTime(new Date())}`);
  saveLocalState();
  render();
}

function activeView() {
  if (PARTICIPANT_MODE) return "answer";
  const hash = location.hash.replace("#", "");
  if (["control", "screen", "answer"].includes(hash)) return hash;
  return "control";
}

function showView() {
  const view = activeView();
  document.body.dataset.view = view;
  for (const name of ["control", "screen", "answer"]) {
    $(`${name}View`).classList.toggle("active", name === view);
    document.querySelector(`[data-view-link="${name}"]`).classList.toggle("active", name === view);
  }
  render();
}

function render() {
  renderSettings();
  renderControl();
  renderSyncStatus();
  renderAnswerSummary();
  renderManualLog();
  renderStage();
  renderAnswer();
  renderQr();
}

function renderSettings() {
  if (document.activeElement?.closest(".setup-panel")) return;
  const selectedManualTeam = $("manualTeam").value || state.currentTeam;
  $("teamAName").value = state.teamAName;
  $("teamBName").value = state.teamBName;
  $("startNumber").value = state.startNumber;
  $("winMode").value = state.winMode;
  $("turnLabel").value = state.turnLabel;
  $("questionText").value = state.question;
  $("answerDuration").value = state.answerDuration;
  $("manualTeam").innerHTML = `
    <option value="A">${escapeHtml(state.teamAName)}</option>
    <option value="B">${escapeHtml(state.teamBName)}</option>
  `;
  $("manualTeam").value = ["A", "B"].includes(selectedManualTeam) ? selectedManualTeam : state.currentTeam;
}

function renderControl() {
  $("miniTeamA").textContent = state.teamAName;
  $("miniTeamB").textContent = state.teamBName;
  $("miniScoreA").textContent = state.scoreA;
  $("miniScoreB").textContent = state.scoreB;
  $("currentTurn").textContent = state.turnLabel;
  $("currentTeam").textContent = teamName(state.currentTeam);
  $("currentQuestion").textContent = state.question;
  $("currentTimer").textContent = timerText();
}

function renderAnswerSummary() {
  if (state.answerCounts) {
    $("circleCount").textContent = state.answerCounts.circle;
    $("crossCount").textContent = state.answerCounts.cross;
    $("summaryNote").textContent = `${state.question} / 合計 ${state.answerCounts.total}件`;
    return;
  }
  const currentAnswers = state.history.filter((item) => item.questionId === state.questionId && ["○", "×"].includes(item.answer));
  const circleCount = currentAnswers.filter((item) => item.answer === "○").length;
  const crossCount = currentAnswers.filter((item) => item.answer === "×").length;
  $("circleCount").textContent = circleCount;
  $("crossCount").textContent = crossCount;
  $("summaryNote").textContent = `${state.question} / 合計 ${currentAnswers.length}件`;
}

function renderSyncStatus() {
  const element = $("syncStatus");
  if (!element) return;
  element.textContent = syncStatus.text;
  element.dataset.status = syncStatus.type;
}

function renderManualLog() {
  const log = $("manualLog");
  const groups = manualLogGroups();

  if (groups.length === 0) {
    log.innerHTML = `<p class="empty-log">まだ手動減点はありません。</p>`;
    return;
  }

  log.innerHTML = groups.map((group) => {
    const rows = group.items.map((item) => {
      const sign = item.undo ? "+" : "-";
      const actionText = item.undo ? "取り消し" : "減点";
      return `
        <li class="${item.undo ? "is-undo" : ""}">
          <span>${escapeHtml(formatLogTime(item.appliedAt || item.createdAt))}</span>
          <strong>${escapeHtml(teamName(item.team))}</strong>
          <em>${sign}${escapeHtml(item.points)} / ${escapeHtml(actionText)}</em>
        </li>
      `;
    }).join("");

    return `
      <article class="turn-log-card">
        <header>
          <div>
            <strong>${escapeHtml(group.turnLabel)}</strong>
            <p>${escapeHtml(group.question)}</p>
          </div>
          <span>${escapeHtml(state.teamAName)} -${group.totalA} / ${escapeHtml(state.teamBName)} -${group.totalB}</span>
        </header>
        <ul>${rows}</ul>
      </article>
    `;
  }).join("");
}

function renderStage() {
  $("stageTurn").textContent = state.turnLabel;
  $("stageMission").textContent = state.winMode === "zero" ? "0に近づけろ!!" : "0に近い方が勝ち!!";
  $("stageQuestion").textContent = state.question;
  $("stageTimer").textContent = timerText();
  $("stageNameA").textContent = state.teamAName;
  $("stageNameB").textContent = state.teamBName;
  $("stageScoreA").textContent = state.scoreA;
  $("stageScoreB").textContent = state.scoreB;

  if (state.latest) {
    $("latestAnswer").textContent = `${state.latest.points}票`;
    $("latestPoints").textContent = state.latest.undo
      ? `${teamName(state.latest.team)}の減点を取り消し`
      : `${teamName(state.latest.team)}に反映`;
  } else {
    $("latestAnswer").textContent = "0票";
    $("latestPoints").textContent = "手動減点後に表示されます";
  }
}

function renderAnswer() {
  $("answerQuestion").textContent = state.question;
  const answered = hasAnsweredCurrentQuestion();
  const closed = isAnswerClosed();
  $("answerForm").hidden = answered || closed;
  $("thanksView").hidden = !answered;
  $("closedView").hidden = answered || !closed;
  $("answerTimer").textContent = timerText();
  $("sendAnswerBtn").disabled = submittingAnswer || answered || closed;
  $("sendAnswerBtn").textContent = submittingAnswer ? "送信中..." : "回答を送信";
  document.querySelectorAll("[data-answer-choice]").forEach((button) => {
    button.disabled = submittingAnswer || answered || closed;
    button.classList.toggle("active", button.dataset.answerChoice === answerChoice);
  });
}

function renderQr() {
  const answerUrl = publicUrl({ participant: "1" }, "answer");
  const overlayUrl = publicUrl({ overlay: "1" }, "screen");
  const overlayTopicUrl = publicUrl({ overlay: "topic" }, "screen");
  const overlayTeamAUrl = publicUrl({ overlay: "teamA" }, "screen");
  const overlayTeamBUrl = publicUrl({ overlay: "teamB" }, "screen");
  $("answerUrl").href = answerUrl;
  $("answerUrl").textContent = answerUrl;
  $("overlayUrl").href = overlayUrl;
  $("overlayUrl").textContent = overlayUrl;
  $("overlayTopicUrl").href = overlayTopicUrl;
  $("overlayTopicUrl").textContent = `お題だけ: ${overlayTopicUrl}`;
  $("overlayTeamAUrl").href = overlayTeamAUrl;
  $("overlayTeamAUrl").textContent = `チームAだけ: ${overlayTeamAUrl}`;
  $("overlayTeamBUrl").href = overlayTeamBUrl;
  $("overlayTeamBUrl").textContent = `チームBだけ: ${overlayTeamBUrl}`;
  $("answerQr").src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(answerUrl)}`;
}

function publicUrl(params, hash) {
  const url = new URL(location.pathname, location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access", ACCESS_TOKEN);
  url.hash = hash;
  return url.toString();
}

function teamName(team) {
  return team === "A" ? state.teamAName : state.teamBName;
}

async function submitAudienceAnswer() {
  if (submittingAnswer || hasAnsweredCurrentQuestion()) return;
  if (isAnswerClosed()) {
    render();
    return;
  }

  const item = {
    id: crypto.randomUUID(),
    clientId: participantId(),
    team: state.currentTeam,
    answer: answerChoice,
    points: answerChoice === "○" ? 1 : 0,
    questionId: state.questionId,
    question: state.question,
    createdAt: new Date().toISOString()
  };

  submittingAnswer = true;
  renderAnswer();

  try {
    if (isRemoteMode()) {
      await runRemoteAction("answer", item);
      localStorage.setItem(ANSWERED_KEY, String(item.questionId));
      return;
    }

    state.history.unshift(item);
    localStorage.setItem(ANSWERED_KEY, String(state.questionId));
    saveLocalState();
    render();
  } catch (error) {
    console.warn(error);
    alert("回答の送信に失敗しました。通信状況を確認して、もう一度送信してください。");
  } finally {
    submittingAnswer = false;
    renderAnswer();
  }
}

function applyPoints(item) {
  applyPointsToState(state, item);
}

function applyPointsToState(targetState, item) {
  if (item.team === "A") {
    targetState.scoreA -= item.points;
  } else {
    targetState.scoreB -= item.points;
  }
}

async function applySettings() {
  const payload = {
    teamAName: $("teamAName").value.trim() || "チームA",
    teamBName: $("teamBName").value.trim() || "チームB",
    startNumber: Math.max(1, Math.floor(Number($("startNumber").value || 1000))),
    winMode: $("winMode").value,
    turnLabel: $("turnLabel").value.trim() || `${state.turn}ターン目`,
    question: $("questionText").value.trim() || "今日関東から来た人",
    answerDuration: Math.max(5, Math.floor(Number($("answerDuration").value || 60)))
  };

  if (isRemoteMode()) {
    localStorage.removeItem(ANSWERED_KEY);
    try {
      await runRemoteAction("settings", payload);
    } catch (error) {
      console.warn(error);
      setSyncStatus("error", `保存エラー ${formatStatusTime(new Date())}`);
      renderSyncStatus();
      alert("設定の保存に失敗しました。回線状況を確認して、もう一度「設定を反映」を押してください。");
    }
    return;
  }

  const previousStart = state.startNumber;
  const previousQuestion = state.question;
  state = { ...state, ...payload };
  if (state.question !== previousQuestion) {
    state.questionId += 1;
    localStorage.removeItem(ANSWERED_KEY);
  }
  state.answerDeadline = deadlineFromNow();

  if (previousStart !== state.startNumber && state.history.length === 0) {
    state.scoreA = state.startNumber;
    state.scoreB = state.startNumber;
  }

  saveLocalState();
  render();
}

function setSyncStatus(type, text) {
  syncStatus = { type, text };
}

function formatStatusTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function nextTurn() {
  localStorage.removeItem(ANSWERED_KEY);
  if (isRemoteMode()) {
    await runRemoteAction("nextTurn");
    return;
  }

  state.turn += 1;
  state.turnLabel = `${state.turn}ターン目`;
  state.currentTeam = state.currentTeam === "A" ? "B" : "A";
  state.questionId += 1;
  state.answerDeadline = closedDeadline();
  saveLocalState();
  render();
}

async function closeAnswers() {
  if (isRemoteMode()) {
    await runRemoteAction("closeAnswers");
    return;
  }

  state.answerDeadline = closedDeadline();
  saveLocalState();
  render();
}

async function resetGame() {
  const ok = confirm("現在の回答集計とスコアを初期化しますか?");
  if (!ok) return;
  localStorage.removeItem(ANSWERED_KEY);

  if (isRemoteMode()) {
    await runRemoteAction("reset");
    return;
  }

  state = {
    ...state,
    scoreA: state.startNumber,
    scoreB: state.startNumber,
    currentTeam: "A",
    turn: 1,
    turnLabel: "1ターン目",
    questionId: state.questionId + 1,
    answerDeadline: closedDeadline(),
    history: [],
    latest: null
  };
  saveLocalState();
  render();
}

async function applyManual() {
  const item = {
    id: crypto.randomUUID(),
    team: $("manualTeam").value,
    answer: $("manualAnswer").value.trim() || "手動反映",
    points: Math.max(0, Math.floor(Number($("manualPoints").value || 0))),
    questionId: state.questionId,
    question: state.question,
    turnLabel: state.turnLabel,
    createdAt: new Date().toISOString()
  };

  $("manualAnswer").value = "";
  $("manualPoints").value = "";

  if (isRemoteMode()) {
    await runRemoteAction("manual", item);
    return;
  }

  applyPoints(item);
  state.history.unshift({ ...item, appliedAt: new Date().toISOString() });
  state.latest = item;
  saveLocalState();
  render();
}

function isUndoableManual(item) {
  return item && ["A", "B"].includes(item.team) && !item.clientId && !item.undo && !item.undone && item.answer !== "初期化";
}

async function undoLastManual() {
  if (isRemoteMode()) {
    await runRemoteAction("undoManual");
    return;
  }

  const target = state.history.find(isUndoableManual);
  if (!target) {
    alert("取り消せる手動反映がありません。");
    return;
  }

  if (target.team === "A") {
    state.scoreA += target.points;
  } else {
    state.scoreB += target.points;
  }

  target.undone = true;
  const undoItem = {
    id: crypto.randomUUID(),
    team: target.team,
    answer: "取り消し",
    points: target.points,
    questionId: target.questionId,
    question: target.question,
    turnLabel: target.turnLabel,
    createdAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(),
    undo: true,
    undoTargetId: target.id
  };
  state.history.unshift(undoItem);
  state.latest = undoItem;
  saveLocalState();
  render();
}

async function clearCurrentAnswers() {
  localStorage.removeItem(ANSWERED_KEY);
  if (isRemoteMode()) {
    await runRemoteAction("clearCurrentAnswers");
    return;
  }
  state.history = state.history.filter((item) => item.questionId !== state.questionId || !["○", "×"].includes(item.answer));
  saveLocalState();
  render();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function turnLabelNote(turnLabel) {
  const label = String(turnLabel || "").trim();
  return label ? `turnLabel:${label}` : "";
}

function extractTurnLabelFromNote(note) {
  const prefix = "turnLabel:";
  if (!String(note || "").startsWith(prefix)) return "";
  return String(note).slice(prefix.length).trim();
}

function isManualLogItem(item) {
  return item
    && ["A", "B"].includes(item.team)
    && Number.isFinite(Number(item.points))
    && !item.clientId
    && item.answer !== "初期化"
    && !["○", "×"].includes(item.answer);
}

function manualLogGroups() {
  const items = state.history
    .filter(isManualLogItem)
    .map((item) => ({
      ...item,
      turnLabel: item.turnLabel || fallbackTurnLabel(item),
      appliedAt: item.appliedAt || item.createdAt || "",
    }))
    .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime());

  const groups = new Map();
  for (const item of items) {
    const key = `${item.questionId}:${item.turnLabel}:${item.question}`;
    if (!groups.has(key)) {
      groups.set(key, {
        turnLabel: item.turnLabel,
        question: item.question || "お題未設定",
        totalA: 0,
        totalB: 0,
        latestAt: item.appliedAt,
        items: [],
      });
    }
    const group = groups.get(key);
    const signedPoints = item.undo ? -item.points : item.points;
    if (item.team === "A") group.totalA += signedPoints;
    if (item.team === "B") group.totalB += signedPoints;
    group.items.push(item);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      totalA: Math.max(0, group.totalA),
      totalB: Math.max(0, group.totalB),
    }))
    .sort((a, b) => new Date(b.latestAt || 0).getTime() - new Date(a.latestAt || 0).getTime())
    .slice(0, 12);
}

function fallbackTurnLabel(item) {
  if (item.questionId === state.questionId) return state.turnLabel;
  return `${item.questionId}回目`;
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function hasAnsweredCurrentQuestion() {
  return localStorage.getItem(ANSWERED_KEY) === String(state.questionId);
}

function deadlineFromNow() {
  return deadlineFromNowFor(state.answerDuration);
}

function deadlineFromNowFor(seconds) {
  return new Date(Date.now() + Number(seconds || 60) * 1000).toISOString();
}

function closedDeadline() {
  return new Date(Date.now() - 1000).toISOString();
}

function remainingSeconds() {
  if (!state.answerDeadline) return 0;
  return Math.max(0, Math.ceil((new Date(state.answerDeadline).getTime() - Date.now()) / 1000));
}

function isAnswerClosed() {
  return remainingSeconds() <= 0;
}

function isClosedState(targetState) {
  if (!targetState.answerDeadline) return true;
  return new Date(targetState.answerDeadline).getTime() <= Date.now();
}

function timerText() {
  const seconds = remainingSeconds();
  if (seconds <= 0) return "受付終了";
  return `残り ${seconds}秒`;
}

function startTimer() {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(() => {
    renderControl();
    renderStage();
    renderAnswer();
  }, 1000);
}

function startRemotePolling() {
  if (!isRemoteMode()) return;
  if (pollId) clearInterval(pollId);
  const interval = PARTICIPANT_MODE ? 5000 : 1000;
  pollId = setInterval(syncFromRemote, interval);
}

if (!ACCESS_GRANTED) {
  renderAccessGate();
} else {
  document.body.classList.remove("access-locked");
  $("accessGate").hidden = true;

  window.addEventListener("hashchange", showView);
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    state = loadLocalState();
    render();
  });
  window.addEventListener("game-state-updated", () => {
    if (isRemoteMode()) return;
    state = loadLocalState();
    render();
  });

  $("saveSettingsBtn").addEventListener("click", applySettings);
  $("closeAnswersBtn").addEventListener("click", closeAnswers);
  $("nextTurnBtn").addEventListener("click", nextTurn);
  $("swapTeamBtn").addEventListener("click", async () => {
    if (isRemoteMode()) {
      await runRemoteAction("swapTeam");
      return;
    }
    state.currentTeam = state.currentTeam === "A" ? "B" : "A";
    saveLocalState();
    render();
  });
  $("resetGameBtn").addEventListener("click", resetGame);
  $("manualApplyBtn").addEventListener("click", applyManual);
  $("undoManualBtn").addEventListener("click", undoLastManual);
  $("clearHistoryBtn").addEventListener("click", clearCurrentAnswers);
  document.querySelectorAll("[data-answer-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      answerChoice = button.dataset.answerChoice;
      renderAnswer();
    });
  });
  $("sendAnswerBtn").addEventListener("click", submitAudienceAnswer);

  if (PARTICIPANT_MODE) {
    document.body.classList.add("participant-mode");
    if (location.hash !== "#answer") location.hash = "answer";
    showView();
  } else if (OVERLAY_MODE) {
    if (location.hash !== "#screen") location.hash = "screen";
    showView();
  } else if (!location.hash) {
    location.hash = "control";
  } else {
    showView();
  }
  if (OVERLAY_MODE) {
    document.body.classList.add("overlay-mode");
    document.body.dataset.overlayPart = OVERLAY_PART;
  }
  if (!state.answerDeadline) {
    state.answerDeadline = closedDeadline();
    saveLocalState();
  }
  startTimer();
  startRemotePolling();
  if (isRemoteMode()) {
    syncFromRemote();
  }
}
