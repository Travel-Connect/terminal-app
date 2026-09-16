/* global fetch, WebSocket */
/**
 * 260904_1 ライブ検証: 実 Electron（非デモ・専用 dataDir・専用ポート）に実 hook 形式のイベントを注入し、
 * (a) #3 同じプロジェクトに 2 セッション → 分割タイル（splitSessions に 2 本）
 * (b) #3 Claude Code の実登録簿（~/.claude/sessions）に無いセッションは 2 回の掃引で終了と確定 →
 *     切断へ遷移 → 同じプロジェクトに生存があるので記録ごと破棄 → 分割が解ける
 * (c) #2 確認待ち → transcript 更新（許可後の作業再開に相当）→ 掃引で「実行中」へ復帰
 * を、実際に動いている claude セッションの ID（登録簿から拾う）と架空 ID で通す。
 *
 * 使い方: npm run build 後に node scripts/verify-liveness-registry-e2e.mjs [出力先ディレクトリ]
 * 登録簿に生きている claude が 1 本も無い環境では (b)(c) を実行できず非 0 で終了する。
 * 掃引間隔は env で 2 秒に短縮する（既定 15 秒）。実稼働アプリ（既定 41321）と並走できる。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42197;
const CDP_PORT = 9335;
const SWEEP_MS = 2000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-liveness-e2e-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-liveness-proj-"));
const outDir = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : dataDir;
fs.mkdirSync(outDir, { recursive: true });
const transcriptPath = path.join(dataDir, "alive.jsonl");
fs.writeFileSync(transcriptPath, '{"type":"user","cwd":"x"}\n');

// 実登録簿から「生きている」セッションを 1 本拾う（status の無い claude-vscode 起動を優先 = transcript 規則の確認用）
const registryDir = path.join(os.homedir(), ".claude", "sessions");
function alivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
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
const aliveEntry = entries.find((e) => e.status === undefined) ?? entries[0];
if (aliveEntry === undefined) {
  console.error("NG: 登録簿に生きている claude セッションが無いため検証できません");
  process.exit(1);
}
const ALIVE = aliveEntry.sessionId;
const DEAD = "00000000-dead-4000-8000-000000000001";
console.log(`生存セッション（登録簿）: ${ALIVE} (pid=${aliveEntry.pid}, status=${aliveEntry.status ?? "-"})`);

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: EVENT_PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false }, customStatuses: [], showUnlinked: true }, null, 2)
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify({ version: 1, projects: [{ id: "p-live", name: "liveness-proj", path: projectDir, clickTarget: "cursor", registeredAt: new Date().toISOString() }] }, null, 2)
);

const child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: { ...process.env, TERMINAL_APP_DATA_DIR: dataDir, TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS) },
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
async function inject(event) {
  const res = await fetch(`http://127.0.0.1:${EVENT_PORT}/terminal-app/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projectDir, transcript_path: transcriptPath, ...event }),
  });
  return res.status;
}
/** タイルの見え方（分割の有無・各セッションの状態） */
async function view() {
  return evaluate(`window.terminalApp.getSnapshot().then(s => ({
    tiles: [...document.querySelectorAll('.tile')].map(t => (t.querySelector('.tile-seq').hidden ? '' : t.querySelector('.tile-seq').textContent) + [...t.classList].find(c => c.startsWith('state-'))),
    split: (s.splitSessions['p-live'] ?? []).map(v => v.sessionId + ':' + v.state),
    display: s.sessions['p-live'] ? s.sessions['p-live'].sessionId + ':' + s.sessions['p-live'].state : null,
    counts: document.querySelector('#status-counts').textContent,
  }))`);
}
const logFile = () => {
  const dir = path.join(dataDir, "logs");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".log")) : [];
  return files.length > 0 ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
};

try {
  await sleep(1200);

  // (a) 2 セッション → 分割
  check("注入 UserPromptSubmit（生存）", await inject({ hook_event_name: "UserPromptSubmit", session_id: ALIVE, prompt: "本物のセッション" }), 204);
  check("注入 UserPromptSubmit（架空 = 登録簿に無い）", await inject({ hook_event_name: "UserPromptSubmit", session_id: DEAD, prompt: "架空のセッション" }), 204);
  await sleep(600);
  await shot("01-split-two-sessions.png");
  // この時点では両方「実行中」で生死未判定 → 1 タイル表示用の代表（display）は従来規則どおり最終イベントが新しい方（架空）
  check("(a) 分割タイル 2 本（①② とも実行中。起動順 = 生存 → 架空）", await view(), {
    tiles: ["①state-running", "②state-running"],
    split: [`${ALIVE}:running`, `${DEAD}:running`],
    display: `${DEAD}:running`,
    counts: "2実行中 / 2セッション",
  });

  // (b) 登録簿に一度も載らないセッションは、実行中の間は登録簿を根拠に終了させない（260916_2: eval-loop の子 `claude -p` 等）
  await sleep(SWEEP_MS * 3 + 500);
  await shot("02-never-registered-still-running.png");
  check("(b-1) 架空（未登録簿）セッションは実行中の間は殺されず、分割 2 本のまま", await view(), {
    tiles: ["①state-running", "②state-running"],
    split: [`${ALIVE}:running`, `${DEAD}:running`],
    display: `${DEAD}:running`,
    counts: "2実行中 / 2セッション",
  });
  const log0 = logFile();
  check("(b-1) ログ: 実行中の未登録簿セッションに終了確認・切断が出ていない", {
    dead: log0.includes(`セッション終了を確認（登録簿にプロセスなし）: session=${DEAD}`),
    disconnected: log0.includes(`実行中のまま終了 → 切断表示: session=${DEAD}`),
  }, { dead: false, disconnected: false });
  // 実行中でなくなれば（Stop）従来どおり 2 回の掃引で終了確定 → 同じプロジェクトに生存があるので破棄 → 分割が解ける
  check("注入 Stop（架空）", await inject({ hook_event_name: "Stop", session_id: DEAD }), 204);
  await sleep(SWEEP_MS * 3 + 500);
  await shot("02-dead-pruned.png");
  check("(b-2) Stop 後の架空セッションは破棄され 1 タイルに戻る（生存セッションは実行中のまま）", await view(), {
    tiles: ["state-running"],
    split: [],
    display: `${ALIVE}:running`,
    counts: "1実行中 / 1セッション",
  });
  const log1 = logFile();
  check("(b-2) ログ: 終了確認 → 破棄（切断表示は出ない）", {
    dead: log1.includes(`セッション終了を確認（登録簿にプロセスなし）: session=${DEAD}`),
    disconnected: log1.includes(`実行中のまま終了 → 切断表示: session=${DEAD}`),
    pruned: log1.includes(`終了済みセッションの記録を破棄（同じプロジェクトに生存あり）: ${DEAD}`),
    aliveUntouched: !log1.includes(`セッション終了を確認（登録簿にプロセスなし）: session=${ALIVE}`),
  }, { dead: true, disconnected: false, pruned: true, aliveUntouched: true });

  // (c) 確認待ち → transcript 更新 → 実行中へ復帰
  check("注入 Notification（権限確認）", await inject({ hook_event_name: "Notification", session_id: ALIVE, message: "Claude needs your permission to use Bash" }), 204);
  await sleep(600);
  check("(c) 確認待ちになる", (await view()).display, `${ALIVE}:confirm`);
  await shot("03-confirm.png");
  // 許可 → ツール実行結果が transcript に書かれる、を模擬（通知から 3 秒以上あとに更新）
  await sleep(3500);
  fs.appendFileSync(transcriptPath, '{"type":"user","toolUseResult":"ok"}\n');
  // 確認待ちから 5 秒以上経ってからの掃引で復帰する
  await sleep(SWEEP_MS * 2 + 2500);
  await shot("04-resumed-running.png");
  check("(c) 実行中へ復帰（許可後の作業再開）", (await view()).display, `${ALIVE}:running`);
  const log2 = logFile();
  const resumeLine = log2.split("\n").find((l) => l.includes("確認待ちから復帰") && l.includes(ALIVE)) ?? "";
  check("(c) ログ: 確認待ちから復帰の記録あり", resumeLine !== "", true);
  console.log(`  復帰ログ: ${resumeLine.trim()}`);

  fs.writeFileSync(path.join(outDir, "app.log"), log2);
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ failures, alive: ALIVE, aliveEntrypoint: aliveEntry.entrypoint, dead: DEAD, sweepMs: SWEEP_MS, at: new Date().toISOString() }, null, 2));
} finally {
  try {
    await Promise.race([send("Browser.close"), sleep(1000)]);
  } catch {
    /* 既に閉じている */
  }
  ws.close();
  await sleep(500);
  if (child.exitCode === null) child.kill();
  fs.rmSync(projectDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`NG: ${failures.length} 件の不一致`);
  process.exit(1);
}
console.log(`すべて期待どおり（出力: ${outDir}）`);
