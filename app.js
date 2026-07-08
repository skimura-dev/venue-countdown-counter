const STORAGE_KEY = "venue-countdown-game-v1";
const ANSWERED_KEY = "venue-countdown-answered-question-v1";
const PARTICIPANT_KEY = "venue-countdown-participant-id-v1";
const API_URL = (window.EVENT_API_URL || "").trim();
const SEARCH_PARAMS = new URLSearchParams(location.search);
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
  answerDeadline: null,
  winMode: "zero",
  history: [],
  latest: null
};

let state = loadLocalState();
let answerChoice = "○";
let timerId = null;
let pollId = null;
let syncing = false;

const $ = (id) => document.getElementById(id);

function isRemoteMode() {
  return API_URL.length > 0;
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

async function syncFromRemote() {
  if (!isRemoteMode() || syncing) return;
  syncing = true;
  try {
    const response = await apiRequest("state");
    state = { ...structuredClone(defaultState), ...response.state };
    saveLocalState();
    render();
  } catch (error) {
    console.warn(error);
  } finally {
    syncing = false;
  }
}

async function runRemoteAction(action, payload = {}) {
  const response = await apiRequest(action, payload);
  state = { ...structuredClone(defaultState), ...response.state };
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
  renderAnswerSummary();
  renderStage();
  renderAnswer();
  renderQr();
}

function renderSettings() {
  if (document.activeElement?.closest(".setup-panel")) return;
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
  const currentAnswers = state.history.filter((item) => item.questionId === state.questionId && ["○", "×"].includes(item.answer));
  const circleCount = currentAnswers.filter((item) => item.answer === "○").length;
  const crossCount = currentAnswers.filter((item) => item.answer === "×").length;
  $("circleCount").textContent = circleCount;
  $("crossCount").textContent = crossCount;
  $("summaryNote").textContent = `${state.question} / 合計 ${currentAnswers.length}件`;
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
  document.querySelectorAll("[data-answer-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.answerChoice === answerChoice);
  });
}

function renderQr() {
  const answerUrl = `${location.origin}${location.pathname}?participant=1#answer`;
  const overlayUrl = `${location.origin}${location.pathname}?overlay=1#screen`;
  const overlayTopicUrl = `${location.origin}${location.pathname}?overlay=topic#screen`;
  const overlayTeamAUrl = `${location.origin}${location.pathname}?overlay=teamA#screen`;
  const overlayTeamBUrl = `${location.origin}${location.pathname}?overlay=teamB#screen`;
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

function teamName(team) {
  return team === "A" ? state.teamAName : state.teamBName;
}

async function submitAudienceAnswer() {
  if (hasAnsweredCurrentQuestion()) return;
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

  localStorage.setItem(ANSWERED_KEY, String(state.questionId));
  if (isRemoteMode()) {
    await runRemoteAction("answer", item);
    return;
  }

  state.history.unshift(item);
  saveLocalState();
  render();
}

function applyPoints(item) {
  if (item.team === "A") {
    state.scoreA -= item.points;
  } else {
    state.scoreB -= item.points;
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
    await runRemoteAction("settings", payload);
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
  state.answerDeadline = deadlineFromNow();
  saveLocalState();
  render();
}

async function closeAnswers() {
  if (isRemoteMode()) {
    await runRemoteAction("closeAnswers");
    return;
  }

  state.answerDeadline = new Date(Date.now() - 1000).toISOString();
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
    answerDeadline: deadlineFromNow(),
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

function hasAnsweredCurrentQuestion() {
  return localStorage.getItem(ANSWERED_KEY) === String(state.questionId);
}

function deadlineFromNow() {
  return new Date(Date.now() + state.answerDuration * 1000).toISOString();
}

function remainingSeconds() {
  if (!state.answerDeadline) return state.answerDuration;
  return Math.max(0, Math.ceil((new Date(state.answerDeadline).getTime() - Date.now()) / 1000));
}

function isAnswerClosed() {
  return remainingSeconds() <= 0;
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
  pollId = setInterval(syncFromRemote, 1000);
}

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
  state.answerDeadline = deadlineFromNow();
  saveLocalState();
}
startTimer();
startRemotePolling();
if (isRemoteMode()) {
  syncFromRemote();
}
