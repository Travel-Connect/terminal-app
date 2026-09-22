/* global fetch, WebSocket */
/**
 * 260922_7 ライブ検証: 再起動をまたいで表示が続くか（専用 dataDir・専用ポートの実 Electron）。
 *
 * (1) 実 hook 形式のイベントで「確認待ち（権限確認）」と「実行中」を作る
 * (2) アプリを終了 → sessions.json が書かれる
 * (3) 同じ dataDir で起動し直す → 確認待ちのタイルが確認待ちのまま復元される（続きから確認できる）
 * (4) 2 本目は保存後に transcript を進めておき、復元時に終端分類で作り直されることを確認する
 * (5) 登録簿に居ないセッション（架空 ID）は復元されない（閉じたターミナルの残骸を復活させない）
 *
 * 使い方: npm run build 後に node scripts/verify-session-snapshot-e2e.mjs [出力先ディレクトリ]
 * 実稼働アプリ（既定 41321）と並走できる。実 %APPDATA% と実 hooks には触れない。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42198;
const CDP_PORT = 9336;
const SWEEP_MS = 60_000; // 掃引で状態が動かないよう長めにする（本検証は保存・復元だけを見る）

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-snap-e2e-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-snap-proj-"));
const outDir = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : dataDir;
fs.mkdirSync(outDir, { recursive: true });

// 生きている claude セッションの ID を登録簿から 2 本借りる（復元対象は「生きているもの」に限るため）
const registryDir = path.join(os.homedir(), ".claude", "sessions");
const alivePid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const entries = fs.existsSync(registryDir)
  ? fs
      .readdirSync(registryDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(registryDir, n), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null && typeof e.pid === "number" && typeof e.sessionId === "string" && alivePid(e.pid))
  : [];
if (entries.length < 2) {
  console.error("NG: 登録簿に生きている claude セッションが 2 本以上必要です");
  process.exit(1);
}
const CONFIRM_SID = entries[0].sessionId;
const MOVED_SID = entries[1].sessionId;
const GHOST_SID = "00000000-ghost-4000-8000-000000000001";
console.log(`確認待ちに使うセッション: ${CONFIRM_SID}\n進行させるセッション: ${MOVED_SID}`);

const confirmTranscript = path.join(dataDir, "confirm.jsonl");
const movedTranscript = path.join(dataDir, "moved.jsonl");
fs.writeFileSync(confirmTranscript, '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"Bash","input":{}}]}}\n');
fs.writeFileSync(movedTranscript, '{"type":"user","message":{"role":"user","content":"作業を続けて"}}\n');

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify(
    { version: 1, port: EVENT_PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false }, customStatuses: [], showUnlinked: true },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify(
    { version: 1, projects: [{ id: "p-snap", name: "snapshot-proj", path: projectDir, clickTarget: "cursor", registeredAt: new Date().toISOString() }] },
    null,
    2
  )
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK " : "NG "} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期待 ${JSON.stringify(expected)})`}`);
  if (!ok) failures.push(label);
}

function launch() {
  return spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      TERMINAL_APP_DATA_DIR: dataDir,
      TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS),
      TERMINAL_APP_JEV: "off", // 判定は本検証の対象外（保存・復元だけを見る）
    },
    stdio: "ignore",
  });
}

async function connect() {
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      page = list.find((t) => t.type === "page" && String(t.url).includes("index.html"));
    } catch {
      /* 起動待ち */
    }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("CDP の page ターゲットが見つかりません（起動失敗？）");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return {
    ws,
    send,
    async evaluate(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`renderer で例外: ${r.exceptionDetails.text}`);
      return r.result.value;
    },
    async shot(name) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, "base64"));
      console.log(`shot: ${path.join(outDir, name)}`);
    },
  };
}

const VIEW = `(async () => {
  const s = await window.terminalApp.getSnapshot();
  const list = (s.splitSessions['p-snap'] ?? [s.sessions['p-snap']]).filter(Boolean);
  return list.map(v => v.sessionId.slice(0,8) + ':' + v.state + (v.confirmKind ? '/' + v.confirmKind : '') + (v.dangerText ? '/' + v.dangerText : '')).sort();
})()`;

function post(payload) {
  return fetch(`http://127.0.0.1:${EVENT_PORT}/terminal-app/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.text());
}

// ---- 1 回目の起動: 確認待ち・実行中・架空セッションを作る ----
let child = launch();
let cdp = await connect();

await post({ hook_event_name: "UserPromptSubmit", session_id: CONFIRM_SID, cwd: projectDir, prompt: "dist を作り直して", transcript_path: confirmTranscript });
await post({
  hook_event_name: "Notification",
  session_id: CONFIRM_SID,
  cwd: projectDir,
  message: "Claude needs your permission to use Bash",
  transcript_path: confirmTranscript,
});
await post({ hook_event_name: "UserPromptSubmit", session_id: MOVED_SID, cwd: projectDir, prompt: "作業を続けて", transcript_path: movedTranscript });
await post({ hook_event_name: "UserPromptSubmit", session_id: GHOST_SID, cwd: projectDir, prompt: "閉じたターミナル", transcript_path: movedTranscript });
await sleep(1000);
check("(1) 終了前: 確認待ち・実行中・架空の 3 本", await cdp.evaluate(VIEW), [
  `${CONFIRM_SID.slice(0, 8)}:confirm/permission`,
  `${GHOST_SID.slice(0, 8)}:running`,
  `${MOVED_SID.slice(0, 8)}:running`,
].sort());
await cdp.shot("01-before-restart.png");

// 保存を確実に書かせてから終了する（will-quit で書き切る）
await sleep(3500);
cdp.ws.close();
child.kill();
await sleep(2000);

const savedPath = path.join(dataDir, "sessions.json");
const saved = fs.existsSync(savedPath) ? JSON.parse(fs.readFileSync(savedPath, "utf8")) : null;
check("(2) sessions.json が書かれている", saved !== null && saved.version === 1 && saved.sessions.length >= 2, true);

// 2 本目だけ保存後に transcript を進める（= 作業が進んだ扱い）
await sleep(1100);
fs.appendFileSync(movedTranscript, '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"続きです"}]}}\n');

// ---- 2 回目の起動: 復元を確認 ----
child = launch();
cdp = await connect();
await sleep(2500);
const after = await cdp.evaluate(VIEW);
check("(3) 確認待ちは確認待ちのまま復元される", after.includes(`${CONFIRM_SID.slice(0, 8)}:confirm/permission`), true);
check("(4) 進んだセッションは実行中で作り直される", after.includes(`${MOVED_SID.slice(0, 8)}:running`), true);
check("(5) 登録簿に居ない架空セッションは復元されない", after.some((v) => v.startsWith(GHOST_SID.slice(0, 8))), false);
await cdp.shot("02-after-restart.png");

const logPath = path.join(dataDir, "logs", "app.log");
const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
check("(6) 復元のログが残る", /前回の表示を復元: 保存 \d+ 件 → 取り込み \d+ 件/.test(log), true);

fs.writeFileSync(
  path.join(outDir, "result.json"),
  JSON.stringify({ at: new Date().toISOString(), confirmSid: CONFIRM_SID, movedSid: MOVED_SID, after, failures }, null, 2)
);
cdp.ws.close();
child.kill();
await sleep(500);
console.log(failures.length === 0 ? "ALL OK" : `NG: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
