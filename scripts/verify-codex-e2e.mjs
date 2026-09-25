/* global fetch, WebSocket, clearTimeout */
/**
 * Codex の SQLite 履歴から実 Electron のタイルまでを検証する。
 * 専用 dataDir・Codex DB・Claude 登録簿・プロジェクトを一時ディレクトリに作る。
 * 実ユーザーの履歴や認証情報を使わず、Jev も呼び出さない。
 * 実行: npm run build 後に node scripts/verify-codex-e2e.mjs [出力先]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ID = "p-codex-e2e";
const CODEX_THREAD = "00000000-c0de-4000-8000-000000000001";
const CODEX_SID = `codex:${CODEX_THREAD}`;
const CLAUDE_SID = "00000000-c1a0-4000-8000-000000000001";
const GHOST_SID = "00000000-dead-4000-8000-000000000001";
const SWEEP_MS = 1500;
const POLL_MS = 300;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-codex-e2e-"));
const projectDir = path.join(dataDir, "fixture-project");
const codexDir = path.join(dataDir, ".codex");
const registryDir = path.join(dataDir, ".claude", "sessions");
const loopDir = path.join(dataDir, ".claude", "eval-loop");
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : dataDir;
for (const dir of [projectDir, codexDir, registryDir, loopDir, outDir]) fs.mkdirSync(dir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const eventPort = await freePort();
let cdpPort = await freePort();
while (cdpPort === eventPort) cdpPort = await freePort();

const stateDb = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
const historyDb = new DatabaseSync(path.join(codexDir, "thread_history_1.sqlite"));
stateDb.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT, source TEXT, archived INTEGER,
    created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,
    name TEXT, title TEXT
  );
`);
historyDb.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE thread_turns (
    thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
    started_at INTEGER, completed_at INTEGER
  );
  CREATE TABLE thread_items (
    thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT
  );
`);
const startMs = Date.now();
stateDb.prepare("INSERT INTO threads VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)")
  .run(CODEX_THREAD, path.toNamespacedPath(projectDir), "cli", Math.floor(startMs / 1000), Math.floor(startMs / 1000), startMs, startMs, "Codex fixture", "Codex fixture task");

function touchThread() {
  const now = Date.now();
  stateDb.prepare("UPDATE threads SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
    .run(Math.floor(now / 1000), now, CODEX_THREAD);
}
function addItem(turnId, itemId, ordinal, type, data) {
  historyDb.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)")
    .run(CODEX_THREAD, turnId, itemId, ordinal, type, JSON.stringify(data));
  touchThread();
}
function addTurn(turnId, ordinal, prompt) {
  historyDb.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, 'inProgress', ?, NULL)")
    .run(CODEX_THREAD, turnId, ordinal, Math.floor(Date.now() / 1000));
  addItem(turnId, `${turnId}-user`, 1, "userMessage", { type: "userMessage", content: [{ type: "text", text: prompt }] });
}
addTurn("turn-1", 1, "Codex fixture first task");

fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
  version: 1, port: eventPort, theme: "dark", alwaysOnTopDefault: false,
  notifySound: { enabled: false }, customStatuses: [], showUnlinked: false, monitorCodex: true,
}, null, 2));
fs.writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({
  version: 1, projects: [{ id: PROJECT_ID, name: "Codex fixture", path: projectDir, clickTarget: "cursor", registeredAt: new Date().toISOString() }],
}, null, 2));
fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId: CLAUDE_SID, cwd: projectDir, kind: "interactive", entrypoint: "cli", status: "busy",
}));
const transcript = path.join(dataDir, "claude-fixture.jsonl");
fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "Claude fixture task" } }) + "\n");

const checks = [];
const checkpoints = [];
function check(label, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ label, passed, actual, expected });
  console.log(`${passed ? "OK" : "NG"}: ${label}`);
  if (!passed) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

let child;
let cdp;
function launch() {
  const env = {
    ...process.env,
    TERMINAL_APP_DATA_DIR: dataDir,
    TERMINAL_APP_CODEX_HOME: codexDir,
    TERMINAL_APP_CODEX_POLL_MS: String(POLL_MS),
    TERMINAL_APP_SESSIONS_DIR: registryDir,
    TERMINAL_APP_EVAL_LOOP_DIR: loopDir,
    TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS),
    TERMINAL_APP_JEV: "off",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT, env, stdio: "ignore", windowsHide: true,
  });
}

async function connect() {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    if (child.exitCode !== null) throw new Error(`Electron が終了しました: ${child.exitCode}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      page = list.find((target) => target.type === "page" && String(target.url).includes("index.html"));
    } catch { /* 起動待ち */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("CDP の page ターゲットが見つかりません");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    clearTimeout(waiting.timer);
    if (response.error) waiting.reject(new Error(JSON.stringify(response.error)));
    else waiting.resolve(response.result);
  });
  ws.addEventListener("close", () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("CDP 接続が閉じました"));
    }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 応答待ち時間超過: ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const connection = {
    ws, send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`renderer で例外: ${result.exceptionDetails.text}`);
      return result.result.value;
    },
    async shot(name) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outDir, name), Buffer.from(result.data, "base64"));
    },
  };
  // 起動直後の page はまだ file:// への遷移中の場合がある。
  for (let i = 0; i < 40; i++) {
    try {
      if (await connection.evaluate("document.readyState === 'complete' && typeof window.terminalApp?.getSnapshot === 'function'")) return connection;
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed") && !String(error).includes("Cannot find context")) throw error;
    }
    await sleep(100);
  }
  ws.close();
  throw new Error("renderer の読み込みが完了しません");
}

async function stop() {
  if (cdp) {
    try { await Promise.race([cdp.send("Browser.close"), sleep(1000)]); } catch { /* 終了時は接続も閉じる */ }
    cdp.ws.close();
    cdp = undefined;
  }
  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1500)]);
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1000)]);
  }
}

async function view() {
  return cdp.evaluate(`(async () => {
    const snapshot = await window.terminalApp.getSnapshot();
    const sessions = snapshot.splitSessions[${JSON.stringify(PROJECT_ID)}]
      ?? [snapshot.sessions[${JSON.stringify(PROJECT_ID)}]].filter(Boolean);
    return {
      presence: snapshot.windowPresence[${JSON.stringify(PROJECT_ID)}],
      showUnlinked: snapshot.config.showUnlinked,
      sessions: sessions.map(s => ({ sessionId: s.sessionId, provider: s.provider ?? 'claude', state: s.state,
        workText: s.workText, confirmKind: s.confirmKind, runningSince: s.runningSince })),
      counts: snapshot.counts,
      tiles: [...document.querySelectorAll('.tile')].map(tile => ({
        sessionId: tile.dataset.sessionId,
        classes: tile.className,
        hidden: tile.hidden,
        provider: tile.querySelector('.tile-provider').hidden ? '' : tile.querySelector('.tile-provider').textContent,
        status: tile.querySelector('.tile-status').textContent,
      })),
    };
  })()`);
}
async function waitFor(label, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await view();
    if (predicate(latest)) return latest;
    await sleep(150);
  }
  throw new Error(`${label} の待機時間超過: ${JSON.stringify(latest)}`);
}
const codex = (snapshot) => snapshot.sessions.find((session) => session.sessionId === CODEX_SID);
const codexTile = (snapshot) => snapshot.tiles.find((tile) => tile.provider === "Codex");
function checkpoint(name, snapshot) { checkpoints.push({ name, ...snapshot }); }
async function post(event) {
  const response = await fetch(`http://127.0.0.1:${eventPort}/terminal-app/event`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projectDir, transcript_path: transcript, ...event }),
  });
  check(`hook ${event.session_id === GHOST_SID ? "ghost" : "Claude"} の受信`, response.status, 204);
}
const appLog = () => fs.readFileSync(path.join(dataDir, "logs", "app.log"), "utf8");

let error;
try {
  launch();
  cdp = await connect();
  let current = await waitFor("Codex 実行中", (s) => codex(s)?.state === "running" && codexTile(s)?.classes.includes("state-running"));
  check("Codex DB の実行中を表示", codex(current).provider, "codex");
  check("Codex の最新ユーザー依頼を表示", codex(current).workText, "Codex fixture first task");
  check("Codex ラベル付きタイルを表示", codexTile(current).hidden, false);
  checkpoint("running", current);

  historyDb.prepare("UPDATE thread_turns SET status = 'completed', completed_at = ? WHERE thread_id = ? AND turn_id = 'turn-1'")
    .run(Math.floor(Date.now() / 1000), CODEX_THREAD);
  touchThread();
  current = await waitFor("Codex 完了", (s) => codex(s)?.state === "done" && codexTile(s)?.classes.includes("state-done") && s.presence === false);
  check("未接続を隠す設定でも Codex 完了を表示", [current.showUnlinked, codexTile(current).hidden], [false, false]);
  check("Cursor が無くても Codex 完了を灰色化しない", codexTile(current).classes.includes("is-unlinked"), false);
  checkpoint("completed", current);
  await cdp.shot("01-codex-completed.png");

  addTurn("turn-2", 2, "Codex fixture next task");
  current = await waitFor("Codex 新しいターン", (s) => codex(s)?.state === "running" && codex(s)?.workText === "Codex fixture next task");
  check("新しいターンで完了から実行中に戻る", codex(current).state, "running");
  checkpoint("next-turn", current);

  await post({ hook_event_name: "UserPromptSubmit", session_id: CLAUDE_SID, prompt: "Claude fixture task" });
  current = await waitFor("Claude と Codex の分割", (s) => s.sessions.length === 2 && s.tiles.length === 2);
  check("同じ cwd の Claude と Codex を分割表示", current.sessions.map((s) => s.provider).sort(), ["claude", "codex"]);
  check("Claude のラベル表示は変えない", current.tiles.find((tile) => tile.sessionId === CLAUDE_SID)?.provider, "");
  check("分割タイルをセッション数に反映", current.counts.total, 2);
  checkpoint("mixed-split", current);
  await cdp.shot("02-claude-codex-split.png");

  await post({ hook_event_name: "UserPromptSubmit", session_id: GHOST_SID, prompt: "Ghost fixture task" });
  await waitFor("掃引対象 Claude の取り込み", (s) => s.sessions.some((session) => session.sessionId === GHOST_SID));
  current = await waitFor("Claude の 2 回掃引", (s) =>
    !s.sessions.some((session) => session.sessionId === GHOST_SID)
    && appLog().includes(`セッション終了を確認（登録簿にプロセスなし）: session=${GHOST_SID}`));
  check("Claude 掃引後も Codex の実行中が残る", codex(current)?.state, "running");
  check("Codex を Claude 登録簿の終了判定にかけない", appLog().includes(`セッション終了を確認（登録簿にプロセスなし）: session=${CODEX_SID}`), false);
  checkpoint("after-two-sweeps", current);

  addItem("turn-2", "question-1", 2, "agentMessage", {
    type: "agentMessage", questions: [{ title: "どちらの手順で進めますか", options: null }],
  });
  current = await waitFor("Codex 質問待ち", (s) => codex(s)?.state === "confirm" && codexTile(s)?.status.includes("返答待ち"));
  check("Codex の質問を返答待ちで表示", codex(current).confirmKind, "question");
  check("返答待ちの Codex を先頭に表示", current.tiles[0].provider, "Codex");
  checkpoint("question", current);
  await cdp.shot("03-codex-question.png");

  await stop();
  launch();
  cdp = await connect();
  current = await waitFor("再起動後の Codex 復元", (s) => codex(s)?.state === "confirm" && codexTile(s)?.status.includes("返答待ち"));
  check("再起動後も同じ Codex セッションを表示", codex(current).sessionId, CODEX_SID);
  check("再起動後も質問待ちを復元", codex(current).confirmKind, "question");
  checkpoint("restarted", current);
  await cdp.shot("04-codex-restarted.png");
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
  console.error(`NG: ${error}`);
  if (cdp) {
    try { await cdp.shot("failure.png"); } catch { /* 接続が失われていても結果を保存する */ }
  }
} finally {
  await stop();
  stateDb.close();
  historyDb.close();
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({
    at: new Date().toISOString(), passed: !error && checks.every((item) => item.passed),
    checks, checkpoints, error, sweepMs: SWEEP_MS, codexPollMs: POLL_MS,
  }, null, 2));
}
console.log(`結果: ${path.join(outDir, "result.json")}`);
process.exitCode = error ? 1 : 0;
