const SPREADSHEET_ID = "1m-45wmJI9fMxkY5TuTL5k04DH5VqN0wVB8RHivxEirE";
const STATE_SHEET = "State";
const ANSWERS_SHEET = "Answers";
const MANUAL_SHEET = "ManualLog";

function defaultState() {
  return {
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
    answerDeadline: new Date(Date.now() + 60 * 1000).toISOString(),
    winMode: "zero",
    history: [],
    latest: null
  };
}

function doGet(e) {
  setupSheets_();
  if (!e.parameter.action) {
    return html_();
  }
  const action = (e.parameter.action || "state").trim();
  const callback = (e.parameter.callback || "").trim();
  const payload = parsePayload_(e.parameter.payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    const result = handleAction_(action, payload);
    return json_(result, callback);
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) }, callback);
  } finally {
    lock.releaseLock();
  }
}

function handleAction_(action, payload) {
  let state = getState_();

  if (action === "state") {
    return { ok: true, state };
  }

  if (action === "settings") {
    const previousQuestion = state.question;
    const previousStart = state.startNumber;
    state.teamAName = stringOr_(payload.teamAName, "チームA");
    state.teamBName = stringOr_(payload.teamBName, "チームB");
    state.startNumber = Math.max(1, Math.floor(Number(payload.startNumber || 1000)));
    state.winMode = stringOr_(payload.winMode, "zero");
    state.turnLabel = stringOr_(payload.turnLabel, state.turn + "ターン目");
    state.question = stringOr_(payload.question, "今日関東から来た人");
    state.answerDuration = Math.max(5, Math.floor(Number(payload.answerDuration || 60)));
    if (state.question !== previousQuestion) {
      state.questionId += 1;
    }
    state.answerDeadline = deadlineFromNow_(state.answerDuration);
    if (previousStart !== state.startNumber && state.history.length === 0) {
      state.scoreA = state.startNumber;
      state.scoreB = state.startNumber;
    }
  }

  if (action === "answer") {
    if (isClosed_(state)) {
      return { ok: true, state };
    }
    const clientId = stringOr_(payload.clientId, "");
    const exists = state.history.some((item) => {
      return item.questionId === state.questionId && item.clientId === clientId && (item.answer === "○" || item.answer === "×");
    });
    if (!exists) {
      const answer = {
        id: stringOr_(payload.id, Utilities.getUuid()),
        clientId,
        team: state.currentTeam,
        answer: payload.answer === "×" ? "×" : "○",
        points: payload.answer === "×" ? 0 : 1,
        questionId: state.questionId,
        question: state.question,
        createdAt: new Date().toISOString()
      };
      state.history.unshift(answer);
      appendAnswer_(answer);
    }
  }

  if (action === "manual") {
    const item = {
      id: stringOr_(payload.id, Utilities.getUuid()),
      team: payload.team === "B" ? "B" : "A",
      answer: stringOr_(payload.answer, "手動反映"),
      points: Math.max(0, Math.floor(Number(payload.points || 0))),
      questionId: state.questionId,
      question: state.question,
      createdAt: new Date().toISOString(),
      appliedAt: new Date().toISOString()
    };
    if (item.team === "A") {
      state.scoreA -= item.points;
    } else {
      state.scoreB -= item.points;
    }
    state.latest = item;
    state.history.unshift(item);
    appendManual_(item, state);
  }

  if (action === "undoManual") {
    const target = state.history.find((item) => {
      return item && (item.team === "A" || item.team === "B") && !item.clientId && !item.undo && !item.undone && item.answer !== "初期化";
    });
    if (target) {
      if (target.team === "A") {
        state.scoreA += Number(target.points || 0);
      } else {
        state.scoreB += Number(target.points || 0);
      }
      target.undone = true;
      const undoItem = {
        id: Utilities.getUuid(),
        team: target.team,
        answer: "取り消し",
        points: Math.max(0, Math.floor(Number(target.points || 0))),
        questionId: target.questionId,
        question: target.question,
        createdAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
        undo: true,
        undoTargetId: target.id
      };
      state.latest = undoItem;
      state.history.unshift(undoItem);
      appendManual_(undoItem, state);
    }
  }

  if (action === "nextTurn") {
    state.turn += 1;
    state.turnLabel = state.turn + "ターン目";
    state.currentTeam = state.currentTeam === "A" ? "B" : "A";
    state.questionId += 1;
    state.answerDeadline = deadlineFromNow_(state.answerDuration);
  }

  if (action === "closeAnswers") {
    state.answerDeadline = new Date(Date.now() - 1000).toISOString();
  }

  if (action === "swapTeam") {
    state.currentTeam = state.currentTeam === "A" ? "B" : "A";
  }

  if (action === "clearCurrentAnswers") {
    state.history = state.history.filter((item) => {
      return item.questionId !== state.questionId || (item.answer !== "○" && item.answer !== "×");
    });
    markCurrentAnswersCleared_(state.questionId);
  }

  if (action === "reset") {
    state.scoreA = state.startNumber;
    state.scoreB = state.startNumber;
    state.currentTeam = "A";
    state.turn = 1;
    state.turnLabel = "1ターン目";
    state.questionId += 1;
    state.answerDeadline = deadlineFromNow_(state.answerDuration);
    state.history = [];
    state.latest = null;
    appendManual_({
      id: Utilities.getUuid(),
      team: "-",
      answer: "初期化",
      points: 0,
      questionId: state.questionId,
      question: state.question,
      createdAt: new Date().toISOString(),
      appliedAt: new Date().toISOString()
    }, state);
  }

  saveState_(state);
  return { ok: true, state };
}

function setupSheets_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const stateSheet = getOrCreateSheet_(ss, STATE_SHEET);
  if (stateSheet.getLastRow() === 0) {
    stateSheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
    stateSheet.getRange(2, 1, 1, 2).setValues([["stateJson", JSON.stringify(defaultState())]]);
  }

  const answersSheet = getOrCreateSheet_(ss, ANSWERS_SHEET);
  if (answersSheet.getLastRow() === 0) {
    answersSheet.getRange(1, 1, 1, 9).setValues([[
      "createdAt", "questionId", "question", "team", "answer", "points", "clientId", "id", "status"
    ]]);
  }

  const manualSheet = getOrCreateSheet_(ss, MANUAL_SHEET);
  if (manualSheet.getLastRow() === 0) {
    manualSheet.getRange(1, 1, 1, 10).setValues([[
      "appliedAt", "questionId", "question", "team", "answer", "points", "scoreA", "scoreB", "id", "note"
    ]]);
  }
}

function getState_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateSheet_(ss, STATE_SHEET);
  const raw = sheet.getRange(2, 2).getValue();
  if (!raw) return defaultState();
  try {
    return Object.assign(defaultState(), JSON.parse(raw));
  } catch (error) {
    return defaultState();
  }
}

function saveState_(state) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateSheet_(ss, STATE_SHEET);
  sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  sheet.getRange(2, 1, 1, 2).setValues([["stateJson", JSON.stringify(state)]]);
}

function appendAnswer_(answer) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateSheet_(ss, ANSWERS_SHEET);
  sheet.appendRow([
    answer.createdAt,
    answer.questionId,
    answer.question,
    answer.team,
    answer.answer,
    answer.points,
    answer.clientId,
    answer.id,
    "active"
  ]);
}

function appendManual_(item, state) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateSheet_(ss, MANUAL_SHEET);
  sheet.appendRow([
    item.appliedAt || item.createdAt,
    item.questionId,
    item.question,
    item.team,
    item.answer,
    item.points,
    state.scoreA,
    state.scoreB,
    item.id,
    ""
  ]);
}

function markCurrentAnswersCleared_(questionId) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateSheet_(ss, ANSWERS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const values = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const statuses = values.map((row) => {
    return [Number(row[1]) === Number(questionId) ? "cleared" : row[8]];
  });
  sheet.getRange(2, 9, statuses.length, 1).setValues(statuses);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function json_(data, callback) {
  const body = callback ? `${callback}(${JSON.stringify(data)});` : JSON.stringify(data);
  return ContentService
    .createTextOutput(body)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function parsePayload_(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function stringOr_(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function deadlineFromNow_(seconds) {
  return new Date(Date.now() + Number(seconds || 60) * 1000).toISOString();
}

function isClosed_(state) {
  return new Date(state.answerDeadline).getTime() <= Date.now();
}

function html_() {
  return HtmlService.createHtmlOutput(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>会場回答</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #111827;
      --muted: #64748b;
      --line: #e2e8f0;
      --red: #f0062f;
      --blue: #0875d1;
      --bg: #f8fafc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
      color: var(--ink);
      background: linear-gradient(135deg, #fff2df 0%, #f8fafc 48%, #e8f4ff 100%);
    }
    main {
      width: min(100%, 520px);
      min-height: 100vh;
      margin: 0 auto;
      padding: 28px 18px;
      display: grid;
      align-content: center;
      gap: 18px;
    }
    .panel {
      background: rgba(255,255,255,.92);
      border: 1px solid rgba(226,232,240,.9);
      border-radius: 8px;
      box-shadow: 0 18px 60px rgba(15,23,42,.12);
      padding: 22px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .12em;
    }
    h1 {
      margin: 0;
      font-size: clamp(24px, 8vw, 38px);
      line-height: 1.15;
    }
    .question {
      margin: 16px 0 0;
      font-size: 20px;
      font-weight: 900;
      line-height: 1.5;
    }
    .timer {
      display: inline-flex;
      margin-top: 16px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-weight: 800;
    }
    .choices {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 18px;
    }
    button {
      min-height: 108px;
      border: 0;
      border-radius: 8px;
      color: #fff;
      font-size: 54px;
      font-weight: 1000;
      cursor: pointer;
      box-shadow: 0 12px 28px rgba(15,23,42,.16);
    }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .yes { background: var(--red); }
    .no { background: var(--blue); }
    .thanks {
      display: none;
      padding: 26px 18px;
      text-align: center;
    }
    .thanks strong {
      display: block;
      font-size: 28px;
      margin-bottom: 8px;
    }
    .note {
      margin: 14px 0 0;
      color: var(--muted);
      font-weight: 700;
      line-height: 1.7;
    }
    .closed .choices { display: none; }
    .answered .answer-box { display: none; }
    .answered .thanks { display: block; }
  </style>
</head>
<body>
  <main id="app">
    <section class="panel">
      <p class="eyebrow">LIVE ANSWER</p>
      <h1 id="turn">読み込み中</h1>
      <p class="question" id="question">しばらくお待ちください</p>
      <span class="timer" id="timer">残り --秒</span>
    </section>
    <section class="panel answer-box">
      <p class="eyebrow">ANSWER</p>
      <div class="choices">
        <button class="yes" type="button" data-answer="○">○</button>
        <button class="no" type="button" data-answer="×">×</button>
      </div>
      <p class="note" id="note">どちらかを選んで送信してください。</p>
    </section>
    <section class="panel thanks">
      <strong>回答ありがとうございます</strong>
      <p class="note">次のお題に切り替わると、また回答できます。</p>
    </section>
  </main>
  <script>
    const app = document.getElementById("app");
    const turn = document.getElementById("turn");
    const question = document.getElementById("question");
    const timer = document.getElementById("timer");
    const note = document.getElementById("note");
    const buttons = [...document.querySelectorAll("button[data-answer]")];
    const clientKey = "venue-countdown-public-client-v1";
    const answeredKey = "venue-countdown-public-answered-v1";
    const clientId = localStorage.getItem(clientKey) || crypto.randomUUID();
    localStorage.setItem(clientKey, clientId);
    let state = null;
    let sending = false;

    function answeredQuestionId() {
      return Number(localStorage.getItem(answeredKey) || 0);
    }

    function setAnswered(questionId) {
      localStorage.setItem(answeredKey, String(questionId));
    }

    function api(action, payload = {}) {
      const url = new URL(location.href.split("#")[0]);
      url.searchParams.set("action", action);
      if (Object.keys(payload).length) {
        url.searchParams.set("payload", JSON.stringify(payload));
      }
      return fetch(url.toString(), { cache: "no-store" }).then((res) => res.json());
    }

    function remainingSeconds() {
      if (!state) return 0;
      return Math.max(0, Math.ceil((new Date(state.answerDeadline).getTime() - Date.now()) / 1000));
    }

    function render() {
      if (!state) return;
      const left = remainingSeconds();
      const answered = answeredQuestionId() === Number(state.questionId);
      turn.textContent = state.turnLabel || (state.turn + "ターン目");
      question.textContent = "お題: " + state.question;
      timer.textContent = left > 0 ? "残り " + left + "秒" : "受付終了";
      app.classList.toggle("answered", answered);
      app.classList.toggle("closed", left <= 0);
      buttons.forEach((button) => button.disabled = sending || answered || left <= 0);
      note.textContent = left > 0 ? "どちらかを選んで送信してください。" : "回答時間が終了しました。";
    }

    function refresh() {
      api("state").then((data) => {
        if (data.ok) {
          state = data.state;
          render();
        }
      }).catch(() => {
        note.textContent = "通信を確認しています。";
      });
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        if (!state || sending) return;
        sending = true;
        render();
        api("answer", {
          id: crypto.randomUUID(),
          clientId,
          answer: button.dataset.answer
        }).then((data) => {
          if (data.ok) {
            state = data.state;
            setAnswered(state.questionId);
          }
        }).finally(() => {
          sending = false;
          render();
        });
      });
    });

    refresh();
    setInterval(refresh, 3000);
    setInterval(render, 500);
  </script>
</body>
</html>`)
    .setTitle("会場回答")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
