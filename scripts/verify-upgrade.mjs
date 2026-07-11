// 起動時追補（design.md 4.2 / OPEN-04 案 A）の実測検証。
// 旧 2 イベント（Stop / Notification）構成の settings.json を持つサンドボックスプロジェクトを
// 一時ディレクトリに用意し、実モード（非デモ）のアプリを一時データディレクトリで起動して
//   (1) 起動時追補で UserPromptSubmit だけが append されること（before/after を証跡保存）
//   (2) curl で UserPromptSubmit を実 POST → タイルが「実行中」（スピナー＋経過時間）になること
// を確認する。実 %APPDATA% と実プロジェクトの settings.json には一切触れない。
//
// 使い方: node scripts/verify-upgrade.mjs <出力ディレクトリ>
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(process.argv[2] ?? join(root, "verify-out"));
mkdirSync(outDir, { recursive: true });

const electronPath = require("electron");
const resultLog = join(outDir, "upgrade-results.log");
const PORT = 41321;
const HOOK_COMMAND =
  `curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:${PORT}/terminal-app/event` +
  ` -H "Content-Type: application/json" --data-binary @-`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(line);
  appendFileSync(resultLog, line + "\n", "utf8");
}

writeFileSync(resultLog, `# 起動時追補（旧 2 イベント → 3 イベント）検証（${new Date().toISOString()}）\n`, "utf8");

// 1) サンドボックス: 旧 2 イベント構成の settings.json を持つ一時プロジェクトを作る
//    （他キー＋'terminal-app' をパスに含む他者 hook も混ぜて非破壊を確認する）
const sandboxRoot = mkdtempSync(join(tmpdir(), "ta-upgrade-"));
const projectDir = join(sandboxRoot, "sandbox-hook-test");
mkdirSync(join(projectDir, ".claude"), { recursive: true });
const markerEntry = () => ({ hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 5 }] });
const beforeSettings = {
  permissions: { deny: ["Read(.env)"] },
  model: "opus",
  hooks: {
    Stop: [
      { matcher: "", hooks: [{ type: "command", command: "node C:\\Users\\hppym\\dev\\terminal-app\\scripts\\my-notify.js" }] },
      markerEntry(),
    ],
    Notification: [markerEntry()],
  },
};
const settingsPath = join(projectDir, ".claude", "settings.json");
writeFileSync(settingsPath, JSON.stringify(beforeSettings, null, 2) + "\n", "utf8");
copyFileSync(settingsPath, join(outDir, "upgrade-before.settings.json"));

// 2) 一時データディレクトリ: 上記プロジェクトを登録済みとして起動させる（実 %APPDATA% 非接触）
const dataDir = mkdtempSync(join(tmpdir(), "ta-upgrade-data-"));
writeFileSync(
  join(dataDir, "projects.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        { id: "p-up01", name: "sandbox-hook-test", path: projectDir, clickTarget: "cursor", registeredAt: new Date().toISOString() },
      ],
    },
    null,
    2
  ) + "\n",
  "utf8"
);

// 3) 実モード（非デモ）で起動。--capture で「実行中」タイルのスクリーンショットを保存して自動終了
const capturePng = join(outDir, "app-upgrade-running.png");
const child = spawn(electronPath, [".", `--capture=${capturePng}`, "--capture-delay=8000", "--theme=dark"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, TERMINAL_APP_DATA_DIR: dataDir },
});
let appOut = "";
child.stdout.on("data", (d) => (appOut += d.toString()));
child.stderr.on("data", (d) => (appOut += d.toString()));

for (let i = 0; i < 100 && !appOut.includes("window shown"); i++) {
  await sleep(300);
}
if (!appOut.includes("window shown")) log("警告: window shown を検出できないまま続行します");
await sleep(800);

// 4) 起動時追補の after を採取・検査
copyFileSync(settingsPath, join(outDir, "upgrade-after.settings.json"));
const after = JSON.parse(readFileSync(settingsPath, "utf8"));
const sameStop = JSON.stringify(after.hooks.Stop) === JSON.stringify(beforeSettings.hooks.Stop);
const sameNotification = JSON.stringify(after.hooks.Notification) === JSON.stringify(beforeSettings.hooks.Notification);
const sameOtherKeys =
  JSON.stringify(after.permissions) === JSON.stringify(beforeSettings.permissions) && after.model === beforeSettings.model;
const upsArr = after.hooks.UserPromptSubmit;
const upsAdded = Array.isArray(upsArr) && upsArr.length === 1 && JSON.stringify(upsArr).includes("/terminal-app/event");
log("## 起動時追補の before/after 検査");
log(`Stop 既設エントリ（他者 hook 含む）が無変更: ${sameStop}`);
log(`Notification 既設エントリが無変更: ${sameNotification}`);
log(`他キー（permissions / model）が無変更: ${sameOtherKeys}`);
log(`UserPromptSubmit が 1 件だけ追記された（マーカー = /terminal-app/event）: ${upsAdded}`);

// 5) UserPromptSubmit を実 POST（実 hook と同じ stdin 転送）→ タイルが「実行中」へ
function postJson(body) {
  try {
    return execFileSync(
      "curl.exe",
      ["-s", "-o", "NUL", "-w", "%{http_code}", "-m", "2", "-X", "POST", `http://127.0.0.1:${PORT}/terminal-app/event`, "-H", "Content-Type: application/json", "--data-binary", "@-"],
      { encoding: "utf8", input: Buffer.from(body, "utf8") }
    ).trim();
  } catch (e) {
    return `curl-exit=${e.status}`;
  }
}
log("## UserPromptSubmit 擬似注入（プロンプト送信 → 実行中）");
log(
  `UserPromptSubmit(sandbox-hook-test 待機→実行中): ${postJson(
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-upgrade-01", cwd: projectDir })
  )}`
);

// 6) アプリ終了（スクリーンショット保存）を待って結果を記録
const exitCode = await new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
writeFileSync(join(outDir, "run-upgrade.log"), appOut, "utf8");
log(`## アプリ終了コード: ${exitCode} / スクリーンショット: ${capturePng}`);
log("## 関連ログ抜粋（追補・受信・描画レイテンシ）");
appOut
  .split(/\r?\n/)
  .filter((l) => l.includes("hooks を追補") || l.includes("event 受信") || l.includes("ui-latency") || l.includes("window shown"))
  .forEach((l) => log(l));

// 7) 一時ディレクトリを片付ける（証跡は outDir に残る）
rmSync(sandboxRoot, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
log("## 一時サンドボックス・一時データディレクトリを削除済み（実環境への影響なし）");
