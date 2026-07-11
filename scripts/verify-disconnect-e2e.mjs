/**
 * 260712_2 E2E 検証: 実 Electron アプリで「切断検知 → タイル切断表示 → ログ」を通す。
 *
 * 手順:
 * 1. 一時データディレクトリ（config/projects）と一時プロジェクト・古い mtime の transcript を用意
 * 2. env で閾値を短縮（INTERVAL=1s / STALE=3s / HARD=6s）して --capture 起動
 * 3. 起動後に UserPromptSubmit を POST → タイルが「実行中」
 * 4. transcript は 60 秒前から未更新・ウィンドウ不存在 → 数秒で「切断」へ遷移
 * 5. capture PNG とログ（event 受信 / 切断検知）を検証
 *
 * 使い方: npm run build 後に node scripts/verify-disconnect-e2e.mjs
 * 専用ポート・一時ディレクトリを使うため、実稼働アプリ（既定 41321）と並走できる。
 */
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 42188;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-e2e-data-"));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-e2e-proj-"));
const transcript = path.join(dataDir, "fake-transcript.jsonl");
const capture = path.join(dataDir, "capture-disconnect.png");

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
        {
          id: "p-e2e",
          name: "e2e-disconnect",
          path: projDir,
          clickTarget: "terminal",
          registeredAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2
  )
);
fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd: projDir, sessionId: "e2e-s1" }) + "\n");
const old = new Date(Date.now() - 60_000);
fs.utimesSync(transcript, old, old); // 60 秒前から未更新 = STALE(3s) を最初の掃引から超過

const child = spawn(
  "npx.cmd",
  ["electron", ".", `--capture=${capture}`, "--capture-delay=9000"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      TERMINAL_APP_DATA_DIR: dataDir,
      TERMINAL_APP_LIVENESS_INTERVAL_MS: "1000",
      TERMINAL_APP_TRANSCRIPT_STALE_MS: "3000",
      TERMINAL_APP_TRANSCRIPT_STALE_HARD_MS: "6000",
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
    session_id: "e2e-s1",
    cwd: projDir,
    transcript_path: transcript,
    prompt: "切断検知の E2E 検証プロンプト",
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
  ["イベント受信（実行中へ）", /event 受信: UserPromptSubmit → running \(project=p-e2e, session=e2e-s1\)/.test(log)],
  ["切断検知ログ", /切断検知: e2e-disconnect \(session=e2e-s1\)/.test(log)],
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
