import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "1"];
}));

const SUPABASE_URL = (args.url || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = args.key || process.env.SUPABASE_ANON_KEY || "";
const COUNT = Number(args.count || 200);
const CONCURRENCY = Number(args.concurrency || COUNT);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.resolve("load-test-results");

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Usage: SUPABASE_URL=https://xxxxx.supabase.co SUPABASE_ANON_KEY=xxxxx node tools/load-test-supabase.mjs --count=200 --concurrency=200");
  process.exit(1);
}

async function supabaseFetch(route, options = {}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${route}`, {
      ...options,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const text = await response.text();
    const elapsedMs = Math.round(performance.now() - startedAt);
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      return { ok: false, httpStatus: response.status, elapsedMs, error: data?.message || text.slice(0, 300) };
    }
    return { ok: true, httpStatus: response.status, elapsedMs, data };
  } catch (error) {
    return { ok: false, httpStatus: null, elapsedMs: Math.round(performance.now() - startedAt), error: String(error?.message || error) };
  }
}

async function writeState(state) {
  return supabaseFetch("event_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: 1, state, updated_at: new Date().toISOString() }),
  });
}

async function readState() {
  const response = await supabaseFetch("event_state?id=eq.1&select=state");
  if (!response.ok) throw new Error(response.error);
  return response.data[0].state;
}

async function readCounts(questionId) {
  const response = await supabaseFetch(`event_answers?question_id=eq.${questionId}&status=eq.active&select=answer`);
  if (!response.ok) throw new Error(response.error);
  return response.data.reduce((acc, row) => {
    if (row.answer === "○") acc.circle += 1;
    if (row.answer === "×") acc.cross += 1;
    acc.total = acc.circle + acc.cross;
    return acc;
  }, { circle: 0, cross: 0, total: 0 });
}

async function runPool(tasks, concurrency) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const current = await readState();
  const testState = {
    ...current,
    teamAName: "負荷テストA",
    teamBName: "負荷テストB",
    startNumber: 1000,
    scoreA: 1000,
    scoreB: 1000,
    currentTeam: "A",
    turn: 1,
    turnLabel: "負荷テスト",
    questionId: Number(current.questionId || 1) + 1,
    question: `Supabase負荷テスト ${RUN_ID}`,
    answerDuration: 300,
    answerDeadline: new Date(Date.now() + 300000).toISOString(),
    winMode: "zero",
    latest: null,
  };
  const setup = await writeState(testState);
  if (!setup.ok) throw new Error(setup.error);

  const startedAt = performance.now();
  const tasks = Array.from({ length: COUNT }, (_, index) => async () => {
    const answer = index % 5 === 0 ? "×" : "○";
    const response = await supabaseFetch("event_answers?on_conflict=question_id,client_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        id: `supabase-load-${RUN_ID}-${index}`,
        client_id: `supabase-load-client-${RUN_ID}-${index}`,
        team: "A",
        answer,
        points: answer === "○" ? 1 : 0,
        question_id: testState.questionId,
        question: testState.question,
        status: "active",
        created_at: new Date().toISOString(),
      }),
    });
    return { index, answer, ok: response.ok, httpStatus: response.httpStatus, elapsedMs: response.elapsedMs, error: response.error || null };
  });

  const answers = await runPool(tasks, CONCURRENCY);
  const counts = await readCounts(testState.questionId);
  const ok = answers.filter((item) => item.ok);
  const failed = answers.filter((item) => !item.ok);
  const latencies = ok.map((item) => item.elapsedMs);
  const summary = {
    runId: RUN_ID,
    count: COUNT,
    concurrency: CONCURRENCY,
    questionId: testState.questionId,
    totalElapsedMs: Math.round(performance.now() - startedAt),
    requestSuccess: ok.length,
    requestFailed: failed.length,
    recordedAnswers: counts.total,
    recordedCircle: counts.circle,
    recordedCross: counts.cross,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : null,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    failuresByError: failed.reduce((acc, item) => {
      const key = item.error || `HTTP ${item.httpStatus}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };

  const summaryPath = path.join(OUT_DIR, `${RUN_ID}-supabase-summary.json`);
  const detailPath = path.join(OUT_DIR, `${RUN_ID}-supabase-details.json`);
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  await fs.writeFile(detailPath, JSON.stringify({ summary, answers }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
