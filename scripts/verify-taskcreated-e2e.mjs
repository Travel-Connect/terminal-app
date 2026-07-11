/**
 * 260712_3 E2E 検証: 実 Electron アプリで「TaskCreated 受信 → タイルに task_subject 表示」を通す。
 * あわせて起動時追補（既存プロジェクトの hooks へ TaskCreated が append されること）も確認する。
 *
 * 使い方: npm run build 後に node scripts/verify-taskcreated-e2e.mjs
 * 専用ポート・一時ディレクトリを使うため、実稼働アプリ（既定 41321）と並走できる。
 */
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 42189;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-task-e2e-"));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-task-proj-"));
const capture = path.join(dataDir, "capture-taskcreated.png");

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
        { id: "p-task", name: "task-e2e", path: projDir, clickTarget: "terminal", registeredAt: new Date().toISOString() },
      ],
    },
    null,
    2
  )
);
// 旧 3 イベント構成の settings.json を用意 → 起動時追補で TaskCreated が append されるはず
const curl = `curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:${PORT}/terminal-app/event -H "Content-Type: application/json" --data-binary @-`;
const entry = { hooks: [{ type: "command", command: curl, timeout: 5 }] };
fs.mkdirSync(path.join(projDir, ".claude"), { recursive: true });
fs.writeFileSync(
  path.join(projDir, ".claude", "settings.json"),
  JSON.stringify({ hooks: { Stop: [entry], Notification: [entry], UserPromptSubmit: [entry] } }, null, 2)
);

const child = spawn("npx.cmd", ["electron", ".", `--capture=${capture}`, "--capture-delay=7000"], {
  cwd: ROOT,
  env: { ...process.env, TERMINAL_APP_DATA_DIR: dataDir },
  stdio: "ignore",
  shell: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 実 hook コマンドと同じ curl.exe 転送で POST する（verify-injection.mjs と同方式）。
 * サーバ未起動時は curl が非 0 終了 → execFileSync が throw（呼び出し側でリトライ）。
 */
function post(body) {
  const out = execFileSync(
    "curl.exe",
    ["-s", "-o", "NUL", "-m", "2", "-w", "%{http_code}", "-X", "POST", `http://127.0.0.1:${PORT}/terminal-app/event`,
     "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { encoding: "utf8", input: Buffer.from(JSON.stringify(body), "utf8") }
  );
  return Number(out.trim());
}

await sleep(2500);
let s1 = 0;
for (let i = 0; i < 10; i++) {
  try {
    // 実測 payload（2026-07-12 の実 claude 2.1.207 ダンプ）と同形
    s1 = post({
      session_id: "task-e2e-s1",
      transcript_path: path.join(dataDir, "t.jsonl"),
      cwd: projDir,
      prompt_id: "e2e-prompt",
      hook_event_name: "TaskCreated",
      task_id: "1",
      task_subject: "フォーマット紐付けを実装",
      task_description: "260712_3 E2E",
    });
    break;
  } catch {
    await sleep(500);
  }
}
console.log(`POST TaskCreated -> HTTP ${s1}`);

await new Promise((resolve) => child.on("exit", resolve));

const log = fs.readFileSync(path.join(dataDir, "logs", "app.log"), "utf8");
const settings = JSON.parse(fs.readFileSync(path.join(projDir, ".claude", "settings.json"), "utf8"));
const taskHook = settings.hooks?.TaskCreated?.some(
  (e) => Array.isArray(e.hooks) && e.hooks.some((h) => String(h.command).includes("/terminal-app/event"))
);
const checks = [
  ["TaskCreated 受信 → 実行中", /event 受信: TaskCreated → running \(project=p-task, session=task-e2e-s1\)/.test(log)],
  ["起動時追補で hooks に TaskCreated 追記", taskHook === true],
  ["既存 3 イベントのエントリは維持", ["Stop", "Notification", "UserPromptSubmit"].every((e) => Array.isArray(settings.hooks?.[e]))],
  ["capture PNG 生成", fs.existsSync(capture)],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
  if (!pass) ok = false;
}
console.log(`capture: ${capture}`);
process.exit(ok ? 0 : 1);
