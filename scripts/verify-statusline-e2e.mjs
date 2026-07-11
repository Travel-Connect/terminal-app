/**
 * 260712_3 案A E2E 検証: 実 Electron アプリで statusLine 転送を通す。
 * 1) 起動時追補で登録済みプロジェクトの settings.json に statusLine 転送が設定される
 * 2) statusline JSON を POST → レスポンス本文が整形テキスト（= ターミナル表示になる文字列）
 * 3) タイルの実行中ステータス行に「経過時間 · ↓ 70.5k tokens · thinking xhigh」が出る（capture）
 *
 * 使い方: npm run build 後に node scripts/verify-statusline-e2e.mjs
 * 専用ポート・一時ディレクトリを使うため、実稼働アプリ（既定 41321）と並走できる。
 */
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 42190;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-sl-e2e-"));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-sl-proj-"));
const capture = path.join(dataDir, "capture-statusline.png");

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false } }, null, 2)
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify(
    { version: 1, projects: [{ id: "p-sl", name: "sl-e2e", path: projDir, clickTarget: "terminal", registeredAt: new Date().toISOString() }] },
    null,
    2
  )
);

const child = spawn("npx.cmd", ["electron", ".", `--capture=${capture}`, "--capture-delay=7000"], {
  cwd: ROOT,
  env: { ...process.env, TERMINAL_APP_DATA_DIR: dataDir },
  stdio: "ignore",
  shell: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 実 hook / statusLine コマンドと同じ curl.exe 転送で POST する
 * （verify-injection.mjs と同方式。statusline は応答本文がターミナル表示になるため本文も取る）。
 * サーバ未起動時は curl が非 0 終了 → execFileSync が throw（呼び出し側でリトライ）。
 */
function post(pathName, body) {
  const out = execFileSync(
    "curl.exe",
    ["-s", "-m", "2", "-w", "\\n%{http_code}", "-X", "POST", `http://127.0.0.1:${PORT}${pathName}`,
     "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { encoding: "utf8", input: Buffer.from(JSON.stringify(body), "utf8") }
  );
  const nl = out.lastIndexOf("\n");
  return { status: Number(out.slice(nl + 1).trim()), text: out.slice(0, nl) };
}

await sleep(2500);
let up = null;
for (let i = 0; i < 10; i++) {
  try {
    up = post("/terminal-app/event", {
      hook_event_name: "UserPromptSubmit",
      session_id: "sl-e2e-s1",
      cwd: projDir,
      prompt: "statusLine 転送の E2E 検証",
    });
    break;
  } catch {
    await sleep(500);
  }
}
console.log(`POST UserPromptSubmit -> HTTP ${up?.status}`);

// 公式 Full JSON schema と同形の statusline ペイロード
const sl = post("/terminal-app/statusline", {
  cwd: projDir,
  session_id: "sl-e2e-s1",
  transcript_path: path.join(dataDir, "t.jsonl"),
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  workspace: { current_dir: projDir, project_dir: projDir, added_dirs: [] },
  version: "2.1.207",
  cost: { total_cost_usd: 0.5, total_duration_ms: 1204000 },
  context_window: {
    total_input_tokens: 155000,
    total_output_tokens: 70500,
    context_window_size: 200000,
    used_percentage: 78,
    remaining_percentage: 22,
    current_usage: { input_tokens: 8500, output_tokens: 1200 },
  },
  exceeds_200k_tokens: false,
  effort: { level: "xhigh" },
  thinking: { enabled: true },
});
console.log(`POST statusline -> HTTP ${sl.status} body="${sl.text}"`);

await new Promise((resolve) => child.on("exit", resolve));

const settings = JSON.parse(fs.readFileSync(path.join(projDir, ".claude", "settings.json"), "utf8"));
const slConf = settings.statusLine;
const checks = [
  ["statusline レスポンス = 整形テキスト", sl.status === 200 && sl.text === "↓ 70.5k tokens · thinking xhigh"],
  ["起動時追補で statusLine 転送を設定", slConf?.type === "command" && String(slConf?.command).includes("/terminal-app/statusline")],
  ["hooks も追補済み（TaskCreated 含む）", ["Stop", "Notification", "UserPromptSubmit", "TaskCreated"].every((e) => Array.isArray(settings.hooks?.[e]))],
  ["capture PNG 生成", fs.existsSync(capture)],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
  if (!pass) ok = false;
}
console.log(`capture: ${capture}`);
process.exit(ok ? 0 : 1);
