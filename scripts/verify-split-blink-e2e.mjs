/* global fetch, WebSocket */
/**
 * 260904_1 E2E 検証: 実 Electron（--demo-count=16）を remote-debugging（CDP）で操作し、
 * (1) #1 手動ステータスのバッジが名前の下の行にあり、名前が 1 行いっぱい使えること
 * (2) #2 確認待ちタイルの光・アイコンが青（--accent）で点滅アニメーション（blink 1s）になっていること
 * (3) #3 同じプロジェクトの 2 セッションが「①②」付きの分割タイルになり、隣接して並ぶこと
 *     ＋ ステータスバーの件数が表示タイル基準（17 セッション）になること
 * (4) 設定画面にウィンドウ位置の一括ボタンがあること
 * を DOM と computed style で裏取りし、スクリーンショットを残す。
 *
 * 使い方: npm run build 後に node scripts/verify-split-blink-e2e.mjs [出力先ディレクトリ]
 * 専用ポート・一時 dataDir を使うため実稼働アプリ（既定 41321）と並走できる。
 * 期待と食い違う結果があれば非 0 で終了する。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42196;
const CDP_PORT = 9334;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-split-e2e-"));
const outDir = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : dataDir;
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify(
    { version: 1, port: EVENT_PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false }, customStatuses: ["作業中", "レビュー待ち", "保留"], showUnlinked: true },
    null,
    2
  )
);

const child = spawn(
  path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
  [".", "--demo-count=16", `--remote-debugging-port=${CDP_PORT}`],
  { cwd: ROOT, env: { ...process.env, TERMINAL_APP_DATA_DIR: dataDir }, stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK " : "NG "} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期待 ${JSON.stringify(expected)})`}`);
  if (!ok) failures.push(label);
}

async function getPageTarget() {
  for (let i = 0; i < 20; i++) {
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
  const p = path.join(outDir, name);
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log(`shot: ${p}`);
}

try {
  await sleep(900);
  await shot("01-main-split-blink-badge.png");

  // (1) #1 バッジは名前の下の行（バッジの上端が名前の下端以上）。名前は行いっぱい（バッジと横並びでない）
  check(
    "#1 バッジ付きタイルで、バッジが名前の下の行に置かれる（商品登録-app）",
    await evaluate(`(() => {
      const tile = [...document.querySelectorAll('.tile')].find(t => t.querySelector('.tile-name').textContent === '商品登録-app');
      const name = tile.querySelector('.tile-name').getBoundingClientRect();
      const badge = tile.querySelector('.tile-badge').getBoundingClientRect();
      return { badgeText: tile.querySelector('.tile-badge').textContent, badgeBelowName: badge.top >= name.bottom - 1, nameNotTruncated: tile.querySelector('.tile-name').scrollWidth <= tile.querySelector('.tile-name').clientWidth };
    })()`),
    { badgeText: "作業中", badgeBelowName: true, nameNotTruncated: true }
  );

  // (2) #2 確認待ち = 青の点滅（光とアイコンに blink アニメーション。色はアクセント #60a5fa）
  check(
    "#2 確認待ちタイルの光は青で blink 1s、アイコンも blink、状態文字は青",
    await evaluate(`(() => {
      const tile = document.querySelector('.tile.state-confirm');
      const glow = getComputedStyle(tile.querySelector('.tile-glow'));
      const icon = getComputedStyle(tile.querySelector('.tile-icon'));
      const status = getComputedStyle(tile.querySelector('.tile-status'));
      return { glowAnim: glow.animationName, glowDur: glow.animationDuration, glowBg: glow.backgroundColor, iconAnim: icon.animationName, iconColor: icon.color, statusColor: status.color };
    })()`),
    { glowAnim: "blink", glowDur: "1s", glowBg: "rgb(96, 165, 250)", iconAnim: "blink", iconColor: "rgb(96, 165, 250)", statusColor: "rgb(96, 165, 250)" }
  );
  check(
    "#2 完了タイルは従来どおり緑の呼吸（breath 2.4s）のまま",
    await evaluate(`(() => { const g = getComputedStyle(document.querySelector('.tile.state-done .tile-glow')); return { anim: g.animationName, dur: g.animationDuration }; })()`),
    { anim: "breath", dur: "2.4s" }
  );

  // (3) #3 分割タイル: 棚割り-app が ①（確認待ち）②（実行中）の 2 タイルになり、DOM 上で隣接する
  check(
    "#3 棚割り-app が ①② の 2 タイルに分かれ、隣接して並ぶ",
    await evaluate(`(() => {
      const tiles = [...document.querySelectorAll('.tile')];
      const idx = tiles.map((t, i) => [t, i]).filter(([t]) => t.querySelector('.tile-name').textContent === '棚割り-app');
      return {
        count: idx.length,
        adjacent: idx.length === 2 && idx[1][1] - idx[0][1] === 1,
        seqs: idx.map(([t]) => t.querySelector('.tile-seq').textContent),
        states: idx.map(([t]) => [...t.classList].find(c => c.startsWith('state-'))),
        works: idx.map(([t]) => t.querySelector('.tile-work').textContent),
        badges: idx.map(([t]) => t.querySelector('.tile-badge').textContent),
        sessionIds: idx.map(([t]) => t.dataset.sessionId),
        split: idx.every(([t]) => t.classList.contains('is-split')),
      };
    })()`),
    { count: 2, adjacent: true, seqs: ["①", "②"], states: ["state-confirm", "state-running"], works: ["棚割り表の再計算をして", "テストを全部通して"], badges: ["作業中", "作業中"], sessionIds: ["s-demo-14", "s-demo-14-2"], split: true }
  );
  check(
    "通常タイルには番号が無く、全タイル数は 16 プロジェクト + 分割 1 = 17",
    await evaluate(`({ tiles: document.querySelectorAll('.tile').length, seqShown: [...document.querySelectorAll('.tile-seq')].filter(e => !e.hidden).length })`),
    { tiles: 17, seqShown: 2 }
  );
  // 16 プロジェクト中 15 にセッション（監査ログ-app は待機）＋ 分割の 2 本目（実行中）= 16 セッション
  // （従来のプロジェクト基準なら「8実行中 … / 15セッション」になる）
  check(
    "ステータスバーの件数は表示タイル基準（分割の 2 本を両方数え、待機タイルは数えない）",
    await evaluate(`document.querySelector('#status-counts').textContent`),
    "9実行中 3完了 2確認待ち 2エラー / 16セッション"
  );

  // (4) 設定画面のウィンドウ位置ボタン
  await evaluate(`document.querySelector('#btn-settings').click()`);
  await sleep(400);
  await evaluate(`(() => { const v = document.querySelector('#view-settings'); v.scrollTop = 260; return true; })()`);
  await sleep(300);
  await shot("02-settings-window-bounds.png");
  check(
    "設定画面に「全プロジェクトの今の位置を記憶」「全プロジェクトを記憶した位置へ戻す」がある",
    await evaluate(`[document.querySelector('#btn-save-all-bounds').textContent, document.querySelector('#btn-restore-all-bounds').textContent]`),
    ["全プロジェクトの今の位置を記憶", "全プロジェクトを記憶した位置へ戻す"]
  );
  // デモ（実ウィンドウなし）で一括記憶を押すと「記憶できるウィンドウがありませんでした」相当のメッセージになる（IPC 往復の確認）
  await evaluate(`document.querySelector('#btn-save-all-bounds').click()`);
  await sleep(1500);
  check(
    "一括記憶の IPC 往復（デモは対象ウィンドウ無し → 0 件のメッセージ）",
    await evaluate(`document.querySelector('#status-message').textContent.startsWith('ウィンドウ位置を記憶: 0 件')`),
    true
  );

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ failures, dataDir, at: new Date().toISOString() }, null, 2));
} finally {
  try {
    // Browser.close は応答前にプロセスが落ちて解決しないことがあるため、待ちは 1 秒まで
    await Promise.race([send("Browser.close"), sleep(1000)]);
  } catch {
    /* 既に閉じている */
  }
  ws.close();
  await sleep(500);
  if (child.exitCode === null) child.kill();
}

if (failures.length > 0) {
  console.error(`NG: ${failures.length} 件の不一致`);
  process.exit(1);
}
console.log("すべて期待どおり");
