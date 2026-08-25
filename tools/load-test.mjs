import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const API_URL = "https://script.google.com/macros/s/AKfycbzVgbuxhQZd0gUhu6HGoG2NwqmmAWQXIbaVTtEii8tNAFSDuolWHm6qB1-tykk2phf0aQ/exec";
const COUNT = Number(process.argv.find((arg) => arg.startsWith("--count="))?.split("=")[1] || 200);
const CONCURRENCY = Number(process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1] || COUNT);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.resolve("load-test-results");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(action, payload = {}, timeoutMs = 45000) {
  const callback = `cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("callback", callback);
  if (payload && Object.keys(payload).length > 0) {
    url.searchParams.set("payload", JSON.stringify(payload));
  }

  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
      headers: { "user-agent": "venue-counter-load-test/1.0" },
    });
    const body = await response.text();
    const elapsedMs = performance.now() - startedAt;
    if (!response.ok) {
      return { ok: false, httpStatus: response.status, elapsedMs, error: body.slice(0, 300) };
    }
    const prefix = `${callback}(`;
    const jsonText = body.startsWith(prefix) && body.endsWith(");")
      ? body.slice(prefix.length, -2)
      : body;
    try {
      const data = JSON.parse(jsonText);
      return { ok: Boolean(data.ok), httpStatus: response.status, elapsedMs, data, error: data.ok ? null : data.error };
    } catch (error) {
      return {
        ok: false,
        httpStatus: response.status,
        elapsedMs,
        error: String(error?.message || error),
        bodySnippet: body.slice(0, 500),
      };
    }
  } catch (error) {
    return { ok: false, httpStatus: null, elapsedMs: performance.now() - startedAt, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index]);
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

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`Preparing test question: ${RUN_ID}`);
  const settings = await api("settings", {
    teamAName: "負荷テストA",
    teamBName: "負荷テストB",
    startNumber: 1000,
    winMode: "zero",
    turnLabel: "負荷テスト",
    question: `負荷テスト ${RUN_ID}`,
    answerDuration: 300,
  });
  if (!settings.ok) {
    throw new Error(`settings failed: ${settings.error}`);
  }

  const stateBefore = await api("state");
  const questionId = stateBefore.data.state.questionId;
  console.log(`Question ID: ${questionId}`);
  await sleep(1000);

  const startedAt = performance.now();
  const tasks = Array.from({ length: COUNT }, (_, index) => async () => {
    const answer = index % 5 === 0 ? "×" : "○";
    const result = await api("answer", {
      id: `load-${RUN_ID}-${index}`,
      clientId: `load-client-${RUN_ID}-${index}`,
      answer,
    });
    return {
      index,
      answer,
      ok: result.ok,
      httpStatus: result.httpStatus,
      elapsedMs: Math.round(result.elapsedMs),
      error: result.error || null,
      bodySnippet: result.bodySnippet || null,
    };
  });

  console.log(`Sending ${COUNT} answers with concurrency ${CONCURRENCY}...`);
  const answers = await runPool(tasks, CONCURRENCY);
  const totalElapsedMs = Math.round(performance.now() - startedAt);

  const stateAfter = await api("state", {}, 60000);
  const history = stateAfter?.data?.state?.history || [];
  const currentAnswers = history.filter((item) => Number(item.questionId) === Number(questionId) && (item.answer === "○" || item.answer === "×"));
  const ok = answers.filter((item) => item.ok);
  const failed = answers.filter((item) => !item.ok);
  const latencies = ok.map((item) => item.elapsedMs);
  const summary = {
    runId: RUN_ID,
    count: COUNT,
    concurrency: CONCURRENCY,
    questionId,
    totalElapsedMs,
    requestSuccess: ok.length,
    requestFailed: failed.length,
    recordedAnswersInState: currentAnswers.length,
    recordedCircle: currentAnswers.filter((item) => item.answer === "○").length,
    recordedCross: currentAnswers.filter((item) => item.answer === "×").length,
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

  const detailPath = path.join(OUT_DIR, `${RUN_ID}-details.json`);
  const summaryPath = path.join(OUT_DIR, `${RUN_ID}-summary.json`);
  await fs.writeFile(detailPath, JSON.stringify({ summary, answers }, null, 2));
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Summary: ${summaryPath}`);
  console.log(`Details: ${detailPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
