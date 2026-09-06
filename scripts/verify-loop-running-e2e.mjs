/* global fetch, WebSocket */
/**
 * 260907_1 ライブ検証: 実 Electron（非デモ・専用 dataDir・専用ポート・擬似登録簿）に実 hook 形式のイベントを注入し、
 * 「ループ・codex・同期 fork の作業中はタイルを実行中に保つ（戻す）」を実測する。
 *
 * (a) cli 起動相当（登録簿 status=busy）: Stop → いったん完了 → 3.5 秒後の前倒し判定で実行中へ戻る（R1/R6）。
 *     status=idle にして Stop → 完了のまま（本当の完了は戻さない）
 * (b) Cursor 起動相当（status 無し）: Stop → 完了 → transcript に block 痕跡（preventedContinuation=true）→
 *     実行中へ戻り、作業テキストが block 理由のラベルになる（R2）。正常終端を書いて Stop → 完了のまま
 * (c) 同期 fork の再現: 本体 transcript を古くしても status=busy なら切断しない（R4）。status 無しでも
 *     subagent 記録が新しければ切断しない（R4）。両方古いと切断 → subagent 記録の更新で実行中へ戻る（R3）
 *
 * 使い方: npm run build 後に node scripts/verify-loop-running-e2e.mjs [出力先ディレクトリ]
 * 登録簿は env TERMINAL_APP_SESSIONS_DIR で一時ディレクトリに差し替える（実 ~/.claude/sessions には触れない。
 * pid は本スクリプト自身 = 生存）。掃引 2 秒・切断 HARD 4 秒に短縮。実稼働アプリ（既定 41321）と並走できる。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42199;
const CDP_PORT = 9337;
const SWEEP_MS = 2000;
// 切断閾値（通常 3 分 / HARD 15 分）は 20 秒に短縮する。各シナリオの待ち（最長 7 秒）より長く、
// 切断させたい場面では mtime を 60 秒前に設定して即座に閾値を超えさせる
const STALE_HARD_MS = 20_000;
const RECHECK_WAIT_MS = 4500; // STOPPED_RESUME_MIN_AGE_MS(3000) + 500 の前倒し判定を確実に過ぎる待ち
const BLOCK_REASON = "[Eval-loop iteration 1/4 | RESUME 1/3] The loop is mid-iteration and your response ended before the iteration completed. Continue now.\nSTATE_FILE=C:/x/state.json";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-loop-e2e-"));
const sessionsDir = path.join(dataDir, "sessions");
const projCli = fs.mkdtempSync(path.join(os.tmpdir(), "ta-loop-proj-cli-"));
const projVs = fs.mkdtempSync(path.join(os.tmpdir(), "ta-loop-proj-vs-"));
const outDir = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : dataDir;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const S_CLI = "e2e00001-0000-4000-8000-00000000c1cd";
const S_VS = "e2e00002-0000-4000-8000-0000000000e5";
const tCli = path.join(dataDir, "cli.jsonl");
const tVs = path.join(dataDir, "vs.jsonl");
const vsSubagentDir = path.join(dataDir, "vs", "subagents"); // activityMtimeMs が見る <sessionId>/subagents/
const vsAgentFile = path.join(vsSubagentDir, "agent-e2e.jsonl");

const openRecords = (cwd) => [
  { type: "user", message: { role: "user", content: "月次レポートを作って" }, cwd, timestamp: new Date().toISOString() },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "assign-eval-loop-generator" } }] }, timestamp: new Date().toISOString() },
];
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
fs.writeFileSync(tCli, jsonl(openRecords(projCli)));
fs.writeFileSync(tVs, jsonl(openRecords(projVs)));

function writeRegistry(name, entry) {
  fs.writeFileSync(path.join(sessionsDir, `${name}.json`), JSON.stringify(entry));
}
const cliEntry = (status) => ({ pid: process.pid, sessionId: S_CLI, cwd: projCli, startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status, statusUpdatedAt: Date.now() });
writeRegistry("cli", cliEntry("busy"));
writeRegistry("vs", { pid: process.pid, sessionId: S_VS, cwd: projVs, startedAt: Date.now(), kind: "interactive", entrypoint: "claude-vscode" });

function setMtime(p, epochMs) {
  fs.utimesSync(p, new Date(epochMs), new Date(epochMs));
}

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: EVENT_PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false }, customStatuses: [], showUnlinked: true }, null, 2)
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        { id: "p-cli", name: "loop-cli", path: projCli, clickTarget: "cursor", registeredAt: new Date().toISOString() },
        { id: "p-vs", name: "loop-vscode", path: projVs, clickTarget: "cursor", registeredAt: new Date().toISOString() },
      ],
    },
    null,
    2
  )
);

const child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    TERMINAL_APP_DATA_DIR: dataDir,
    TERMINAL_APP_SESSIONS_DIR: sessionsDir,
    TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS),
    TERMINAL_APP_TRANSCRIPT_STALE_MS: String(STALE_HARD_MS), // 一時ディレクトリにはウィンドウが無いため、短い側の閾値も HARD と同じにする
    TERMINAL_APP_TRANSCRIPT_STALE_HARD_MS: String(STALE_HARD_MS),
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
async function inject(event, cwd, transcriptPath) {
  const res = await fetch(`http://127.0.0.1:${EVENT_PORT}/terminal-app/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, transcript_path: transcriptPath, ...event }),
  });
  return res.status;
}
const injectCli = (event) => inject({ session_id: S_CLI, ...event }, projCli, tCli);
const injectVs = (event) => inject({ session_id: S_VS, ...event }, projVs, tVs);

/** 2 タイルの見え方（状態と作業テキスト） */
async function view() {
  return evaluate(`window.terminalApp.getSnapshot().then(s => ({
    cli: s.sessions['p-cli'] ? { state: s.sessions['p-cli'].state, work: s.sessions['p-cli'].workText ?? null } : null,
    vs: s.sessions['p-vs'] ? { state: s.sessions['p-vs'].state, work: s.sessions['p-vs'].workText ?? null } : null,
  }))`);
}
const logFile = () => {
  const dir = path.join(dataDir, "logs");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".log")) : [];
  return files.length > 0 ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
};
const logHas = (...parts) => logFile().split("\n").some((l) => parts.every((p) => l.includes(p)));

try {
  await sleep(1200);

  // ---- (a) 登録簿 status=busy: block された Stop 相当 ----
  check("(a) 注入 UserPromptSubmit（cli）", await injectCli({ hook_event_name: "UserPromptSubmit", prompt: "月次レポートを作って" }), 204);
  await sleep(500);
  check("(a) 実行中", (await view()).cli, { state: "running", work: "月次レポートを作って" });
  check("(a) 注入 Stop（cli。登録簿は busy のまま）", await injectCli({ hook_event_name: "Stop" }), 204);
  await sleep(500);
  check("(a) Stop 直後はいったん完了", (await view()).cli.state, "done");
  await sleep(RECHECK_WAIT_MS);
  await shot("01-cli-resumed-from-done.png");
  check("(a) 前倒し判定で実行中へ戻る（登録簿 busy）", (await view()).cli, { state: "running", work: "月次レポートを作って" });
  check("(a) ログ: 完了から実行中へ復帰（登録簿 status=busy）", logHas("完了から実行中へ復帰", S_CLI, "登録簿 status=busy"), true);

  writeRegistry("cli", cliEntry("idle"));
  check("(a) 注入 Stop（cli。登録簿 idle = 本当の完了）", await injectCli({ hook_event_name: "Stop" }), 204);
  await sleep(RECHECK_WAIT_MS + SWEEP_MS);
  check("(a) idle なら完了のまま", (await view()).cli.state, "done");

  // ---- (b) status 無し（Cursor 起動相当）: transcript の block 痕跡 ----
  check("(b) 注入 UserPromptSubmit（vscode）", await injectVs({ hook_event_name: "UserPromptSubmit", prompt: "ループを回して" }), 204);
  await sleep(500);
  check("(b) 注入 Stop（vscode）", await injectVs({ hook_event_name: "Stop" }), 204);
  await sleep(500);
  check("(b) Stop 直後はいったん完了", (await view()).vs.state, "done");
  // Stop hook が block → Claude Code が stop_hook_summary{preventedContinuation:true} を書いて続行
  fs.appendFileSync(
    tVs,
    jsonl([
      { type: "system", subtype: "stop_hook_summary", preventedContinuation: true, stopReason: BLOCK_REASON, timestamp: new Date().toISOString() },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "続行します" }] }, timestamp: new Date().toISOString() },
    ])
  );
  await sleep(RECHECK_WAIT_MS);
  await shot("02-vscode-resumed-by-blocked-stop.png");
  check("(b) block 痕跡で実行中へ戻り、作業テキストが block 理由のラベル", (await view()).vs, { state: "running", work: "[Eval-loop iteration 1/4 | RESUME 1/3]" });
  check("(b) ログ: Stop hook が続行を指示", logHas("完了から実行中へ復帰", S_VS, "Stop hook が続行を指示"), true);

  // 本当の完了: 通常の summary + turn_duration を書いてから Stop
  fs.appendFileSync(
    tVs,
    jsonl([
      { type: "system", subtype: "stop_hook_summary", preventedContinuation: false, stopReason: "", timestamp: new Date().toISOString() },
      { type: "system", subtype: "turn_duration", timestamp: new Date().toISOString() },
    ])
  );
  check("(b) 注入 Stop（vscode。正常終端あり）", await injectVs({ hook_event_name: "Stop" }), 204);
  await sleep(RECHECK_WAIT_MS + SWEEP_MS);
  check("(b) 正常終端なら完了のまま", (await view()).vs.state, "done");

  // ---- (c) 同期 fork の再現: 本体 transcript が止まる ----
  writeRegistry("cli", cliEntry("busy"));
  check("(c) 注入 UserPromptSubmit（cli。fork 開始相当）", await injectCli({ hook_event_name: "UserPromptSubmit", prompt: "generator を fork" }), 204);
  await sleep(300);
  setMtime(tCli, Date.now() - 60_000); // 本体 transcript は 60 秒前から無更新（HARD 20 秒を大きく超える）
  await sleep(SWEEP_MS * 2 + 1000);
  check("(c) 本体 transcript が古くても登録簿 busy なら切断しない", (await view()).cli.state, "running");

  fs.appendFileSync(tVs, jsonl(openRecords(projVs))); // 新しいターン（open 形状）
  check("(c) 注入 UserPromptSubmit（vscode。fork 開始相当）", await injectVs({ hook_event_name: "UserPromptSubmit", prompt: "generator を fork" }), 204);
  await sleep(300);
  fs.mkdirSync(vsSubagentDir, { recursive: true });
  fs.writeFileSync(vsAgentFile, jsonl([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fork 作業中" }] } }]));
  setMtime(tVs, Date.now() - 60_000); // 本体は止まっているが subagent 記録は今
  await sleep(SWEEP_MS * 2 + 1000);
  check("(c) status 無しでも subagent 記録が新しければ切断しない", (await view()).vs.state, "running");

  setMtime(vsAgentFile, Date.now() - 60_000); // subagent 記録も止まった → 切断
  await sleep(SWEEP_MS * 2 + 1000);
  await shot("03-vscode-disconnected.png");
  check("(c) 本体も subagent も古ければ切断", (await view()).vs.state, "disconnected");
  check("(c) ログ: 切断検知", logHas("切断検知", S_VS), true);

  fs.appendFileSync(vsAgentFile, jsonl([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "再開" }] } }])); // 更新再開
  await sleep(SWEEP_MS * 2 + 1000);
  await shot("04-vscode-resumed-from-disconnected.png");
  check("(c) subagent 記録の更新で切断から実行中へ戻る", (await view()).vs.state, "running");
  check("(c) ログ: 切断から実行中へ復帰（transcript 更新）", logHas("切断から実行中へ復帰", S_VS, "subagent 記録"), true);
  check("(c) cli 側は最後まで実行中のまま", (await view()).cli.state, "running");

  fs.writeFileSync(path.join(outDir, "app.log"), logFile());
  fs.writeFileSync(
    path.join(outDir, "result.json"),
    JSON.stringify({ failures, sessions: { cli: S_CLI, vscode: S_VS }, sweepMs: SWEEP_MS, staleHardMs: STALE_HARD_MS, at: new Date().toISOString() }, null, 2)
  );
} finally {
  try {
    await Promise.race([send("Browser.close"), sleep(1000)]);
  } catch {
    /* 既に閉じている */
  }
  ws.close();
  await sleep(500);
  if (child.exitCode === null) child.kill();
  fs.rmSync(projCli, { recursive: true, force: true });
  fs.rmSync(projVs, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`NG: ${failures.length} 件の不一致`);
  process.exit(1);
}
console.log(`すべて期待どおり（出力: ${outDir}）`);
