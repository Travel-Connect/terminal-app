/* global fetch, WebSocket */
/**
 * 260907_2 ライブ検証: 実 Electron（非デモ・専用 dataDir・専用ポート・擬似 eval-loop ディレクトリ・擬似登録簿）で、
 * タイルのループ進捗バッジが eval-loop の state.json / codex ジョブから作られることを実測する。
 *
 * (a) registry/sessions/<sessionId> → state（進行中・2 周目・best_score 78・codex generator ジョブ走行中）
 *     → 「ループ 2/4・codex 実装中 1分・最高 78点」
 * (b) registry/agents/<agentId> → state（fork ループ。session_id で対応付け。evaluator 段階）→ 「ループ 1/4・採点中」
 * (c) ループの無いセッションにはバッジが出ない
 * (d) heartbeat が古くなる（codex ジョブ終了）→ 「ループ 2/4・実装中・最高 78点」
 * (e) ループ終了（threshold_met・92 点）→ 「ループ終了・合格 92点」。fork ループは 31 分前に終了 → バッジ消滅
 *
 * 使い方: npm run build 後に node scripts/verify-loop-badge-e2e.mjs [出力先ディレクトリ]
 * 実 ~/.claude/eval-loop と ~/.claude/sessions には触れない。掃引 2 秒。実稼働アプリ（既定 41321）と並走できる。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42201;
const CDP_PORT = 9339;
const SWEEP_MS = 2000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-badge-e2e-"));
const sessionsDir = path.join(dataDir, "sessions");
const evalLoopDir = path.join(dataDir, "eval-loop");
const outDir = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : dataDir;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(path.join(evalLoopDir, "registry", "sessions"), { recursive: true });
fs.mkdirSync(path.join(evalLoopDir, "registry", "agents"), { recursive: true });

const projects = ["a", "b", "c"].map((k) => ({ key: k, id: `p-${k}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), `ta-badge-proj-${k}-`)) }));
const S = { a: "e2e0000a-0000-4000-8000-000000000001", b: "e2e0000b-0000-4000-8000-000000000002", c: "e2e0000c-0000-4000-8000-000000000003" };
const AGENT = "a1b2c3d4e5f60718";
const nowS = () => Math.floor(Date.now() / 1000);
const fwd = (p) => p.replace(/\\/g, "/");

// 擬似登録簿（pid は自プロセス = 生存。status busy で切断判定の対象外）
for (const k of ["a", "b", "c"]) {
  fs.writeFileSync(path.join(sessionsDir, `${k}.json`), JSON.stringify({ pid: process.pid, sessionId: S[k], entrypoint: "cli", status: "busy" }));
}

// state.json（v3 形式の要点）
const stateA = path.join(evalLoopDir, "states", "a");
const stateB = path.join(evalLoopDir, "states", "agent");
fs.mkdirSync(path.join(stateA, "jobs", "iter-001-generator"), { recursive: true });
fs.mkdirSync(path.join(stateB, "jobs"), { recursive: true });
const writeState = (dir, obj) => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ schema_version: 3, loop_type: "eval", jobs_dir: fwd(path.join(dir, "jobs")), ...obj }));
writeState(stateA, { active: true, iteration: 1, max_iterations: 4, threshold: 90, phase: "generator", best_score: 78, session_id: S.a, agent_id: null, generator_skill: "assign-codex-generator" });
writeState(stateB, { active: true, iteration: 0, max_iterations: 4, threshold: 90, phase: "evaluator", session_id: S.b, agent_id: AGENT });
fs.writeFileSync(path.join(evalLoopDir, "registry", "sessions", S.a), fwd(path.join(stateA, "state.json")) + "\n");
fs.writeFileSync(path.join(evalLoopDir, "registry", "agents", AGENT), fwd(path.join(stateB, "state.json")) + "\n");
const jobA = path.join(stateA, "jobs", "iter-001-generator");
fs.writeFileSync(path.join(jobA, "started_at"), String(nowS() - 65));
fs.writeFileSync(path.join(jobA, "heartbeat"), "");

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: EVENT_PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false }, customStatuses: [], showUnlinked: true }, null, 2)
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify({ version: 1, projects: projects.map((p) => ({ id: p.id, name: `loop-${p.key}`, path: p.dir, clickTarget: "cursor", registeredAt: new Date().toISOString() })) }, null, 2)
);

const child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    TERMINAL_APP_DATA_DIR: dataDir,
    TERMINAL_APP_SESSIONS_DIR: sessionsDir,
    TERMINAL_APP_EVAL_LOOP_DIR: evalLoopDir,
    TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS),
  },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK " : "NG "} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期待 ${JSON.stringify(expected)})`}`);
  if (!ok) failures.push(label);
}

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && String(t.url).includes("index.html"));
      if (page) return page;
    } catch {
      /* 起動待ち */
    }
    await sleep(500);
  }
  throw new Error("CDP の page ターゲットが見つかりません（起動失敗？）");
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`renderer で例外: ${r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, "base64"));
}
async function inject(key, event) {
  const p = projects.find((x) => x.key === key);
  const res = await fetch(`http://127.0.0.1:${EVENT_PORT}/terminal-app/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: p.dir, session_id: S[key], transcript_path: path.join(dataDir, `${key}.jsonl`), ...event }),
  });
  return res.status;
}
/** snapshot の loopText と、描画されたバッジ（.tile-loop）の文字列・表示有無 */
async function view() {
  return evaluate(`window.terminalApp.getSnapshot().then(s => ({
    a: s.sessions['p-a']?.loopText ?? null,
    b: s.sessions['p-b']?.loopText ?? null,
    c: s.sessions['p-c']?.loopText ?? null,
    dom: Object.fromEntries([...document.querySelectorAll('.tile')].map(t => [t.dataset.id, {
      loop: t.querySelector('.tile-loop').hidden ? null : t.querySelector('.tile-loop').textContent,
      row: !t.querySelector('.tile-badge-row').hidden,
    }])),
  }))`);
}
const logFile = () => {
  const dir = path.join(dataDir, "logs");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".log")) : [];
  return files.length > 0 ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
};

try {
  await sleep(1200);
  for (const k of ["a", "b", "c"]) {
    fs.writeFileSync(path.join(dataDir, `${k}.jsonl`), '{"type":"user","message":{"role":"user","content":"x"}}\n');
    check(`注入 UserPromptSubmit（${k}）`, await inject(k, { hook_event_name: "UserPromptSubmit", prompt: `ループ ${k}` }), 204);
  }
  await sleep(SWEEP_MS + 1500);
  await shot("01-badges.png");
  let v = await view();
  check("(a) sessions 登録のループ: 2 周目・codex 実装中 1 分・最高 78 点", v.a, "ループ 2/4・codex 実装中 1分・最高 78点");
  check("(b) agents 登録（fork）のループ: session_id で対応付き 採点中", v.b, "ループ 1/4・採点中");
  check("(c) ループの無いセッションにはバッジ無し", v.c, null);
  check("描画: a/b はバッジ表示・c は行ごと非表示", v.dom, {
    "p-a": { loop: "ループ 2/4・codex 実装中 1分・最高 78点", row: true },
    "p-b": { loop: "ループ 1/4・採点中", row: true },
    "p-c": { loop: null, row: false },
  });
  check("ログ: バッジ出現の記録", logFile().includes(`ループ進捗バッジ 表示: loop-a (session=${S.a}) — ループ 2/4・codex 実装中 1分・最高 78点`), true);

  // (d) heartbeat が古くなる = codex ジョブが終わった（exit_code が書かれる前の一瞬 or 死亡）→ phase 表示へ
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(jobA, "heartbeat"), old, old);
  await sleep(SWEEP_MS + 1000);
  check("(d) heartbeat 30 秒超で codex 表示が消え phase 表示へ", (await view()).a, "ループ 2/4・実装中・最高 78点");

  // (e) 終了: a は合格 92 点（今）、b は 31 分前に上限到達 → 期限切れで消える
  writeState(stateA, { active: false, iteration: 1, max_iterations: 4, threshold: 90, phase: "eval", latest_score: 92, best_score: 92, ended_reason: "threshold_met", ended_at: nowS(), session_id: S.a });
  writeState(stateB, { active: false, iteration: 3, max_iterations: 4, phase: "eval", best_score: 70, ended_reason: "max_iterations", ended_at: nowS() - 31 * 60, session_id: S.b, agent_id: AGENT });
  await sleep(SWEEP_MS + 1000);
  await shot("02-ended.png");
  v = await view();
  check("(e) 終了直後: ループ終了・合格 92点", v.a, "ループ終了・合格 92点");
  check("(e) 31 分前に終わった fork ループのバッジは消える", v.b, null);
  check("(e) 描画: b の行は非表示に戻る", v.dom["p-b"], { loop: null, row: false });
  check("ログ: バッジ消滅の記録", logFile().includes(`ループ進捗バッジ 消滅: loop-b (session=${S.b})`), true);

  fs.writeFileSync(path.join(outDir, "app.log"), logFile());
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ failures, sessions: S, agent: AGENT, sweepMs: SWEEP_MS, at: new Date().toISOString() }, null, 2));
} finally {
  try {
    await Promise.race([send("Browser.close"), sleep(1000)]);
  } catch {
    /* 既に閉じている */
  }
  ws.close();
  await sleep(500);
  if (child.exitCode === null) child.kill();
  for (const p of projects) fs.rmSync(p.dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`NG: ${failures.length} 件の不一致`);
  process.exit(1);
}
console.log(`すべて期待どおり（出力: ${outDir}）`);
