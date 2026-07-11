// verification.md 3.4（擬似イベント注入）・3.7（V-19: 127.0.0.1 バインド確認）の自動実行。
// デモモードのアプリを起動し、curl.exe で受信サーバへ実 POST して
// HTTP ステータス・netstat 抜粋・注入後スクリーンショット・アプリログを証跡として残す。
//
// 使い方: node scripts/verify-injection.mjs <出力ディレクトリ>
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(process.argv[2] ?? join(root, "verify-out"));
mkdirSync(outDir, { recursive: true });

const electronPath = require("electron"); // 素の Node からは electron.exe のパスが返る
const capturePng = join(outDir, "app-demo-injected.png");
const appLog = join(outDir, "run-demo-injected.log");
const resultLog = join(outDir, "injection-results.log");

const PORT = 41321;
const URL_EVENT = `http://127.0.0.1:${PORT}/terminal-app/event`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(args, input) {
  try {
    return execFileSync("curl.exe", ["-s", "-o", "NUL", "-w", "%{http_code}", "-m", "2", ...args], {
      encoding: "utf8",
      input, // stdin 経由（undefined なら未使用）
    }).trim();
  } catch (e) {
    return `curl-exit=${e.status}`;
  }
}

/**
 * 実 hook と同じ形で送る: JSON は stdin から --data-binary @- で転送する
 * （コマンドライン引数経由だと Windows の ANSI 変換で日本語パスが化けるため。
 *   design.md 4.1 の hook コマンドも stdin 転送方式）。
 */
function postJson(body) {
  return curl(
    ["-X", "POST", URL_EVENT, "-H", "Content-Type: application/json", "--data-binary", "@-"],
    Buffer.from(body, "utf8")
  );
}

function log(line) {
  console.log(line);
  appendFileSync(resultLog, line + "\n", "utf8");
}

writeFileSync(resultLog, `# 擬似イベント注入・バインド確認（${new Date().toISOString()}）\n`, "utf8");

// 1) デモアプリを起動（注入時間を確保するため capture-delay=8s。終了時に自動でスクリーンショット保存）
const child = spawn(electronPath, [".", "--demo", "--theme=dark", `--capture=${capturePng}`, "--capture-delay=8000"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let appOut = "";
child.stdout.on("data", (d) => (appOut += d.toString()));
child.stderr.on("data", (d) => (appOut += d.toString()));

// ウィンドウ表示（= レンダラー購読開始後）まで待ってから注入する。
// 受信→描画のレイテンシ計測（NFR-01）を実運用と同じ条件にするため。
for (let i = 0; i < 100 && !appOut.includes("window shown"); i++) {
  await sleep(300);
}
if (!appOut.includes("window shown")) {
  log("警告: window shown を検出できないまま注入を開始します");
}
await sleep(1200);

// 2) V-19: バインド確認（netstat で 41321 が 127.0.0.1 のみで LISTEN していること）
const netstat = execFileSync("netstat", ["-ano"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((l) => l.includes(`:${PORT}`));
log("## netstat（ポート 41321 の行のみ）");
netstat.forEach((l) => log(l.trim()));

// 3) verification.md 3.4 の擬似イベント注入（デモプロジェクトの cwd に一致させる）
log("## 擬似イベント注入（HTTP ステータス）");
log(`Stop(棚卸し-app 実行中→完了): ${postJson(JSON.stringify({ hook_event_name: "Stop", session_id: "s-inject-01", cwd: "C:\\dev\\demo\\棚卸し-app" }))}`);
log(`Notification(配送追跡-app →確認待ち): ${postJson(JSON.stringify({ hook_event_name: "Notification", session_id: "s-inject-02", cwd: "C:\\dev\\demo\\配送追跡-app\\sub", message: "Claude needs your permission to use Bash" }))}`);
log(`SessionEnd reason=other(問い合わせbot →エラー): ${postJson(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-inject-03", cwd: "C:\\dev\\demo\\問い合わせbot", reason: "other" }))}`);
log(`UserPromptSubmit(在庫管理-app 完了→実行中。OPEN-04 案 A / task.md 改善要求): ${postJson(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-inject-05", cwd: "C:\\dev\\demo\\在庫管理-app" }))}`);
log(`不正 JSON（400 で破棄されること）: ${postJson("{ broken json !!")}`);
log(`未登録 cwd（204 受理・状態は変えず破棄）: ${postJson(JSON.stringify({ hook_event_name: "Stop", session_id: "s-inject-04", cwd: "D:\\not\\registered" }))}`);
log(`未知イベント名（400）: ${postJson(JSON.stringify({ hook_event_name: "Nope", session_id: "s", cwd: "c" }))}`);
log(`別パス /other への POST（404）: ${curl(["-X", "POST", `http://127.0.0.1:${PORT}/other`, "--data-binary", "{}"])}`);
log(`GET /terminal-app/event（405）: ${curl([URL_EVENT])}`);

// 4) アプリの終了（スクリーンショット保存）を待つ
const exitCode = await new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
writeFileSync(appLog, appOut, "utf8");
log(`## アプリ終了コード: ${exitCode} / スクリーンショット: ${existsSync(capturePng) ? "保存済み" : "なし"}`);

// 5) NFR-01 の受信→描画のログ差分（ui-latency）を抜粋
log("## ui-latency（受信→描画完了のログ差分。NFR-01 / V-04 の計測方式）");
appOut
  .split(/\r?\n/)
  .filter((l) => l.includes("ui-latency") || l.includes("event 受信") || l.includes("event 破棄"))
  .forEach((l) => log(l));
