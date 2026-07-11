// 実 Claude Code セッション（claude -p）による hooks 実発火の end-to-end 自動検証。
// 対象はこれまで手動枠だった:
//   #4  実セッションの Stop 発火 → 「完了」（V-04）
//   #5  実セッションの UserPromptSubmit 発火 → 「実行中」（OPEN-04 案 A の実発火）
//   #12 再起動後の登録保持・状態は「待機」へ（V-01 後半 / T-10）
//   #15 アプリ未起動でも実セッションが無害に完走する（V-14）
//
// 一時サンドボックスプロジェクトを専用ポートで登録し、実 claude プロセス（ヘッドレス -p）を
// その cwd で走らせ、hooks（アプリが起動時追補で整備した実コマンド）の実発火 → 受信 →
// タイル状態遷移 → 描画レイテンシまでを通しで実測する。
// 実 %APPDATA%・実プロジェクト・実稼働アプリ（既定ポート 41321）には一切触れない
// （一時ディレクトリ＋専用ポートを使い、実稼働インスタンスと共存できる。
//   共存には config.json の port が受信サーバへ反映されることが前提 — bug-audit #14 の修正）。
//
// 使い方: npm run build 後に
//   node scripts/verify-real-session.mjs <出力ディレクトリ> [--port=41999] [--model=haiku]
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

function argValue(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const PORT = Number(argValue("port", "41999")); // 実稼働の 41321 と衝突しない専用ポート
const MODEL = argValue("model", "haiku"); // 実測は速い haiku を既定にする

const electronPath = require("electron");
const resultLog = join(outDir, "real-session-results.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(line);
  appendFileSync(resultLog, line + "\n", "utf8");
}
writeFileSync(resultLog, `# 実 Claude Code セッション検証（${new Date().toISOString()} / port=${PORT} / model=${MODEL}）\n`, "utf8");

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- サンドボックス: 空 settings.json のプロジェクト＋登録済みデータディレクトリ ----
const sandboxRoot = mkdtempSync(join(tmpdir(), "ta-real-"));
const projectDir = join(sandboxRoot, "sandbox-real-session");
mkdirSync(join(projectDir, ".claude"), { recursive: true });
const settingsPath = join(projectDir, ".claude", "settings.json");
writeFileSync(settingsPath, "{}\n", "utf8");

const dataDir = mkdtempSync(join(tmpdir(), "ta-real-data-"));
writeFileSync(
  join(dataDir, "projects.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        { id: "p-real1", name: "sandbox-real-session", path: projectDir, clickTarget: "terminal", registeredAt: new Date().toISOString() },
      ],
    },
    null,
    2
  ) + "\n",
  "utf8"
);
writeFileSync(
  join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: PORT, theme: "auto", alwaysOnTopDefault: false, notifySound: { enabled: false } }, null, 2) + "\n",
  "utf8"
);

/** 実モードのアプリを一時データディレクトリで起動する（--capture で自動終了） */
function startApp(capturePng, delayMs) {
  const child = spawn(electronPath, [".", `--capture=${capturePng}`, `--capture-delay=${delayMs}`, "--theme=dark"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERMINAL_APP_DATA_DIR: dataDir },
  });
  const state = { child, out: "", exited: false, exitCode: null };
  child.stdout.on("data", (d) => (state.out += d.toString()));
  child.stderr.on("data", (d) => (state.out += d.toString()));
  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
  });
  // ウォッチドッグ: キャプチャ予定時刻から 60 秒過ぎても終了しなければ強制終了する
  // （環境要因でハングしてもスクリプト全体が固まらないようにする保険）
  setTimeout(() => {
    if (state.exited) return;
    log(`警告: アプリが期限内に終了しないため強制終了します（ウォッチドッグ発動）`);
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 既に終了していれば無視 */
    }
  }, delayMs + 60_000).unref();
  return state;
}

/** アプリの終了を待つ（既に終了していれば即座に返る） */
function waitExit(state) {
  return state.exited ? Promise.resolve(state.exitCode) : new Promise((r) => state.child.on("exit", (code) => r(code)));
}

async function waitFor(state, needle, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state.out.includes(needle)) return true;
    await sleep(250);
  }
  return false;
}

/** 実 claude をサンドボックス cwd でヘッドレス実行し、所要時間と exit code を実測する */
function runClaude(prompt, label) {
  return new Promise((resolveRun) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE")) delete env[key]; // 入れ子セッション由来の環境変数を持ち込まない
    }
    const started = Date.now();
    // claude は npm の .cmd シムのため Windows では shell 経由で起動する（プロンプトは ASCII に限定）
    const child = spawn("claude", ["-p", prompt, "--model", MODEL], {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env,
    });
    let out = "";
    let exited = false;
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    // タイムアウト保険（120 秒）。unref 済みのためプロセス終了を妨げない
    setTimeout(() => {
      if (exited) return;
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* 既に終了していれば無視 */
      }
    }, 120_000).unref();
    child.on("exit", (code) => {
      exited = true;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log(`${label}: exit=${code} / 所要=${seconds}s / 出力=${JSON.stringify(out.trim().slice(0, 120))}`);
      resolveRun({ code, seconds: Number(seconds), out });
    });
  });
}

/**
 * settings.json へ整備された hook コマンド文字列そのものを cmd 経由で実行し、
 * hooks 実行系と同じく stdin へイベント JSON を流す。戻り値は exit code と所要秒。
 */
function runHookCommand(command, payload) {
  const started = Date.now();
  let code = 0;
  try {
    execFileSync("cmd.exe", ["/d", "/s", "/c", command], { input: Buffer.from(JSON.stringify(payload), "utf8"), stdio: ["pipe", "ignore", "ignore"] });
  } catch (e) {
    code = e.status ?? -1;
  }
  return { code, seconds: Number(((Date.now() - started) / 1000).toFixed(2)) };
}

// ---- Phase 1: アプリ起動 → 起動時追補で空 settings.json に 3 イベントの hooks が入る ----
log("## Phase 1: アプリ起動と hooks 自動整備（起動時追補）");
copyFileSync(settingsPath, join(outDir, "real-settings-before.json"));
const donePng = join(outDir, "app-real-session-done.png");
const app1 = startApp(donePng, 45_000);
const shown = await waitFor(app1, "window shown", 30_000);
check("アプリ起動（window shown）", shown);
await sleep(800);
copyFileSync(settingsPath, join(outDir, "real-settings-after-merge.json"));
const merged = JSON.parse(readFileSync(settingsPath, "utf8"));
const marker = `:${PORT}/terminal-app/event`;
const hooksOk = ["Stop", "Notification", "UserPromptSubmit"].every(
  (ev) => Array.isArray(merged.hooks?.[ev]) && JSON.stringify(merged.hooks[ev]).includes(marker)
);
check("起動時追補: 空 settings.json へ 3 イベントの hooks（専用ポート宛て）が整備された", hooksOk);
const hookCommand = merged.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? "";
log(`整備された hook コマンド: ${hookCommand}`);

// ---- Phase 2: 実 claude -p セッションの hooks 実発火 → 実行中 → 完了（#5 / #4） ----
log("## Phase 2: 実 claude -p セッションの hooks 実発火（#4 / #5 の実測）");
const run1 = await runClaude("Reply with exactly this single word: done", "claude 実行(アプリ稼働中)");
check("実セッションが正常終了した（exit 0）", run1.code === 0);
const gotRunning = await waitFor(app1, "UserPromptSubmit → running", 10_000);
check("実発火: UserPromptSubmit を受信しタイルが「実行中」へ（#5 / OPEN-04 案 A）", gotRunning);
const gotDone = await waitFor(app1, "Stop → done", 10_000);
check("実発火: Stop を受信しタイルが「完了」へ（#4 / V-04）", gotDone);

const app1Exit = await waitExit(app1);
writeFileSync(join(outDir, "run-real-session.log"), app1.out, "utf8");
log(`アプリ終了コード: ${app1Exit} / 完了タイルのスクリーンショット: ${donePng}`);
const latencies = [...app1.out.matchAll(/ui-latency: 受信→描画完了 (\d+)ms/g)].map((m) => Number(m[1]));
check(
  "受信→描画レイテンシが全件 1000ms 以内（NFR-01）",
  latencies.length > 0 && latencies.every((n) => n <= 1000),
  `実測=${latencies.join(",")}ms`
);
log("### アプリログ抜粋（追補・受信・描画レイテンシ）");
app1.out
  .split(/\r?\n/)
  .filter((l) => l.includes("hooks を追補") || l.includes("event 受信") || l.includes("ui-latency") || l.includes("window shown"))
  .forEach((l) => log(l));

// ---- Phase 3: 再起動 → 登録は保持・状態は「待機」へ戻る（#12 / T-10） ----
log("## Phase 3: 再起動後の登録保持と揮発（#12 / T-10）");
const restartPng = join(outDir, "app-real-restart-waiting.png");
const app2 = startApp(restartPng, 5_000);
await waitFor(app2, "window shown", 30_000);
const app2Exit = await waitExit(app2);
writeFileSync(join(outDir, "run-real-restart.log"), app2.out, "utf8");
const persisted = JSON.parse(readFileSync(join(dataDir, "projects.json"), "utf8"));
check("再起動後も登録プロジェクトが保持されている（V-01 後半）", persisted.projects?.length === 1);
check(
  "再起動後にセッション状態を持ち越していない（T-10: 受信 0 件 = タイルは「待機」表示）",
  app2Exit === 0 && !app2.out.includes("event 受信"),
  `スクリーンショット: ${restartPng}`
);

// ---- Phase 4: アプリ未起動時の無害性（#15 / V-14） ----
log("## Phase 4: アプリ未起動時の無害性（#15 / V-14）");
const dead = runHookCommand(hookCommand, { hook_event_name: "Stop", session_id: "s-noapp-01", cwd: projectDir });
check(
  "アプリ未起動時の実 hook コマンドは短時間で打ち切られ非ブロック（exit != 0・ブロック用 exit 2 でない・5 秒以内）",
  dead.code !== 0 && dead.code !== 2 && dead.seconds <= 5,
  `exit=${dead.code} / 所要=${dead.seconds}s（curl -m 2 による打ち切り）`
);
const run2 = await runClaude("Reply with exactly this single word: ok", "claude 実行(アプリ停止中)");
check("アプリ未起動でも実セッションが完走する（exit 0・エラー表示なし）", run2.code === 0);
log(`参考: アプリ稼働中 ${run1.seconds}s ⇔ 未起動 ${run2.seconds}s`);

// ---- 後片付けと判定 ----
rmSync(sandboxRoot, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
log("## 一時サンドボックス・一時データディレクトリを削除済み（実環境への影響なし）");
const failed = checks.filter((c) => !c.ok);
log(`## 結果: ${checks.length - failed.length}/${checks.length} PASS${failed.length ? ` — FAIL: ${failed.map((c) => c.name).join(" / ")}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;
