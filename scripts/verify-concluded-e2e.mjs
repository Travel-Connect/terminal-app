/**
 * 260712_4 E2E 検証: 実 Electron アプリで「Stop 欠落 → 終了検知 → タイル完了」を通す。
 *
 * 背景バグ: 割り込み（Esc）では Stop hook が発火せず、「実行中」のまま取り残される。
 * 手順:
 * 1. 一時プロジェクトと「ターン完了形状」の transcript（… assistant → stop_hook_summary → turn_duration）
 *    を用意し、mtime を 30 秒前に設定（CONCLUDED_MIN_AGE 超・切断 STALE 未満）
 * 2. env で掃引間隔と終了検知の最小経過を短縮（INTERVAL=1s / CONCLUDED_MIN_AGE=1s）して --capture 起動
 * 3. UserPromptSubmit を POST → タイルが「実行中」
 * 4. 数秒で終了検知が走り「完了」へ降格（切断にはならない）
 * 5. capture PNG とログ（event 受信 / 終了検知 / 切断検知なし）を検証
 *
 * 使い方: npm run build 後に node scripts/verify-concluded-e2e.mjs
 * 専用ポート・一時ディレクトリを使うため、実稼働アプリ（既定 41321）と並走できる。
 */
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 42187;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-concl-data-"));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-concl-proj-"));
const transcript = path.join(dataDir, "concluded-transcript.jsonl");
const capture = path.join(dataDir, "capture-concluded.png");

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false } }, null, 2)
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        { id: "p-concl", name: "e2e-concluded", path: projDir, clickTarget: "terminal", registeredAt: new Date().toISOString() },
      ],
    },
    null,
    2
  )
);

// ターン完了形状の transcript（2026-07-12 実測: 最終 assistant の後に stop_hook_summary → turn_duration）
const records = [
  { type: "user", message: { role: "user", content: "割り込みで Stop が来ないケースの検証" }, cwd: projDir, sessionId: "e2e-concl-s1" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "できました" }] }, cwd: projDir },
  { type: "system", subtype: "stop_hook_summary", cwd: projDir },
  { type: "system", subtype: "turn_duration", cwd: projDir },
];
fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
const old = new Date(Date.now() - 30_000);
fs.utimesSync(transcript, old, old); // 30 秒前から未更新 = CONCLUDED_MIN_AGE(1s) 超・切断 STALE(180s) 未満

const child = spawn(
  "npx.cmd",
  ["electron", ".", `--capture=${capture}`, "--capture-delay=9000"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      TERMINAL_APP_DATA_DIR: dataDir,
      TERMINAL_APP_LIVENESS_INTERVAL_MS: "1000",
      TERMINAL_APP_CONCLUDED_MIN_AGE_MS: "1000",
    },
    stdio: "ignore",
    shell: true,
  }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 実 hook コマンドと同じ curl.exe 転送で POST する（verify-injection.mjs と同方式）。
 * サーバ未起動時は curl が非 0 終了 → execFileSync が throw（呼び出し側でリトライ）。
 */
function postEvent() {
  const body = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "e2e-concl-s1",
    cwd: projDir,
    transcript_path: transcript,
    prompt: "終了検知の E2E 検証プロンプト",
  });
  const out = execFileSync(
    "curl.exe",
    ["-s", "-o", "NUL", "-m", "2", "-w", "%{http_code}", "-X", "POST", `http://127.0.0.1:${PORT}/terminal-app/event`,
     "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { encoding: "utf8", input: Buffer.from(body, "utf8") }
  );
  return Number(out.trim());
}

await sleep(2500); // 起動＋listen 待ち
let status = 0;
for (let i = 0; i < 10; i++) {
  try {
    status = postEvent();
    break;
  } catch {
    await sleep(500);
  }
}
console.log(`POST UserPromptSubmit -> HTTP ${status}`);

await new Promise((resolve) => child.on("exit", resolve));

const log = fs.readFileSync(path.join(dataDir, "logs", "app.log"), "utf8");
const checks = [
  ["イベント受信（実行中へ）", /event 受信: UserPromptSubmit → running \(project=p-concl, session=e2e-concl-s1\)/.test(log)],
  ["終了検知ログ（Stop 欠落 → 完了）", /終了検知: e2e-concluded \(session=e2e-concl-s1\)/.test(log)],
  ["切断とは誤判定しない", !/切断検知: e2e-concluded/.test(log)],
  ["capture PNG 生成", fs.existsSync(capture)],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
  if (!pass) ok = false;
}
console.log(`capture: ${capture}`);
console.log(`dataDir: ${dataDir}`);
process.exit(ok ? 0 : 1);
