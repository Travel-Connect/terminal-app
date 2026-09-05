/* global fetch, WebSocket */
/**
 * 260906_1 E2E 検証: 実 Electron（--demo）を remote-debugging（CDP）で操作し、
 * (1) 自動整列ボタン（#1）— 接続中のタイルが先頭（左上）へ、未接続が後ろへ。projects.json の配列順に永続化。
 *     2 回目の押下は「すでに整列済み」
 * (2) タイルの D&D 並べ替え（#2）— 合成 DragEvent で dragstart → dragover（挿入位置の目印）→ drop。
 *     手前／直後の両方向、永続化、内部ドラッグ中は登録用オーバーレイが出ないこと、
 *     フォルダの外部ドロップ（登録）は従来どおりオーバーレイが出ること
 * を実 IPC 往復で通し、スクリーンショットと JSON で裏取りする。
 *
 * 使い方: npm run build 後に node scripts/verify-arrange-e2e.mjs [出力先ディレクトリ]
 * 専用ポート・一時 dataDir を使うため実稼働アプリ（既定 41321）と並走できる。
 * 期待と食い違う結果があれば非 0 で終了する。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42197;
const CDP_PORT = 9335;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-arrange-e2e-"));
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
  [".", "--demo", `--remote-debugging-port=${CDP_PORT}`],
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
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));

/** 画面上のタイル順（hidden を含む DOM 順）を id の配列で返す */
const ORDER_EXPR = `[...document.querySelectorAll('#tile-grid .tile')].map(t => t.dataset.id)`;
const savedOrder = () => readJson("projects.json").projects.map((p) => p.id);
const STATUS_EXPR = `document.querySelector('#status-message').textContent`;

/**
 * 合成 DragEvent でタイル fromId をタイル toId の手前（side='before'）／直後（'after'）へ落とす。
 * 実ドラッグと同じ順（dragstart → dragenter → dragover → drop → dragend）で発火させ、
 * 途中（dragover 後）の目印とオーバーレイの状態を返す。ドロップは 'skipDrop' で省略できる（目印の撮影用）
 */
function dragExpr(fromId, toId, side, skipDrop = false) {
  return `(() => {
    const src = document.querySelector('#tile-grid .tile[data-id="${fromId}"]');
    const dst = document.querySelector('#tile-grid .tile[data-id="${toId}"]');
    const dt = new DataTransfer();
    const r = dst.getBoundingClientRect();
    const x = ${side === "before" ? "r.left + 4" : "r.right - 4"};
    const y = r.top + r.height / 2;
    const ev = (type, extra = {}) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y, ...extra });
    src.dispatchEvent(ev('dragstart'));
    dst.dispatchEvent(ev('dragenter'));
    dst.dispatchEvent(ev('dragover'));
    const mid = {
      types: [...dt.types],
      srcDragging: src.classList.contains('is-dragging'),
      marker: dst.classList.contains('drop-before') ? 'before' : dst.classList.contains('drop-after') ? 'after' : 'none',
      overlayHidden: document.querySelector('#drop-overlay').hidden,
    };
    if (!${skipDrop}) {
      dst.dispatchEvent(ev('drop'));
      src.dispatchEvent(ev('dragend'));
    }
    return mid;
  })()`;
}

try {
  await sleep(800);
  const initial = await evaluate(ORDER_EXPR);
  check("初期の並びは登録順（demo-01〜12）", initial, Array.from({ length: 12 }, (_, i) => `demo-${String(i + 1).padStart(2, "0")}`));
  check("タイルはドラッグ可能（draggable）", await evaluate(`[...document.querySelectorAll('#tile-grid .tile')].every(t => t.draggable)`), true);
  check(
    "タイトルバーに自動整列ボタン",
    await evaluate(`({ exists: !!document.querySelector('#btn-arrange'), title: document.querySelector('#btn-arrange')?.title })`),
    { exists: true, title: "自動整列（接続中のタイルを左上へ。タイルはドラッグでも並べ替えられます）" }
  );
  await shot("01-main-before.png");

  // --- 自動整列（#1）。デモの未接続 = 商品ページ作成-app(demo-04, 完了) と 売上レポート-app(demo-07, エラー)。
  //     問い合わせbot(demo-11) はウィンドウ無しでも実行中なので接続中扱い ---
  await evaluate(`document.querySelector('#btn-arrange').click()`);
  await sleep(700);
  const arranged = ["demo-01", "demo-02", "demo-03", "demo-05", "demo-06", "demo-08", "demo-09", "demo-10", "demo-11", "demo-12", "demo-04", "demo-07"];
  check("自動整列: 接続中 10 件が先頭、未接続 2 件が末尾（グループ内の相対順は維持）", await evaluate(ORDER_EXPR), arranged);
  check("自動整列: 末尾 2 件は灰色（未接続）タイル", await evaluate(`[...document.querySelectorAll('#tile-grid .tile')].slice(-2).map(t => t.classList.contains('is-unlinked'))`), [true, true]);
  check("自動整列: ステータスバーの案内", await evaluate(STATUS_EXPR), "自動整列しました: 接続中 10 件を左上へ・未接続 2 件を後ろへ");
  check("自動整列: projects.json の配列順に永続化", savedOrder(), arranged);
  await shot("02-main-arranged.png");

  await evaluate(`document.querySelector('#btn-arrange').click()`);
  await sleep(400);
  check("自動整列を再度押しても順序は変わらず「整列済み」の案内", { order: await evaluate(ORDER_EXPR), status: await evaluate(STATUS_EXPR) }, { order: arranged, status: "すでに整列済みです（接続中 10 件が先頭）" });

  // --- D&D 並べ替え（#2）: 目印の撮影（ドロップせず dragend で片付け） ---
  const mid = await evaluate(dragExpr("demo-07", "demo-01", "before", true));
  check("D&D 中: 内部 MIME が載り、ドラッグ元は薄く、ドロップ先の手前に目印、登録用オーバーレイは出ない", mid, {
    types: ["application/x-terminal-app-tile"],
    srcDragging: true,
    marker: "before",
    overlayHidden: true,
  });
  await shot("03-main-drag-marker.png");
  await evaluate(`(() => { const src = document.querySelector('#tile-grid .tile[data-id="demo-07"]'); src.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true; })()`);
  check(
    "dragend で目印とドラッグ状態が片付く（ドロップせず離した場合）",
    await evaluate(`({ dragging: document.querySelectorAll('#tile-grid .tile.is-dragging').length, markers: document.querySelectorAll('#tile-grid .tile.drop-before, #tile-grid .tile.drop-after').length })`),
    { dragging: 0, markers: 0 }
  );

  // 末尾（未接続 demo-07）を先頭 demo-01 の手前へ
  await evaluate(dragExpr("demo-07", "demo-01", "before"));
  await sleep(700);
  const afterFront = ["demo-07", "demo-01", "demo-02", "demo-03", "demo-05", "demo-06", "demo-08", "demo-09", "demo-10", "demo-11", "demo-12", "demo-04"];
  check("D&D: 末尾のタイルを先頭タイルの手前へ", await evaluate(ORDER_EXPR), afterFront);
  check("D&D: projects.json に永続化", savedOrder(), afterFront);
  await shot("04-main-after-drop-front.png");

  // 先頭 demo-07 を demo-03 の直後へ（右方向の移動）
  await evaluate(dragExpr("demo-07", "demo-03", "after"));
  await sleep(700);
  const afterRight = ["demo-01", "demo-02", "demo-03", "demo-07", "demo-05", "demo-06", "demo-08", "demo-09", "demo-10", "demo-11", "demo-12", "demo-04"];
  check("D&D: 先頭のタイルを 3 番目の直後へ（右方向）", await evaluate(ORDER_EXPR), afterRight);
  check("D&D: projects.json に永続化（右方向）", savedOrder(), afterRight);
  await shot("05-main-after-drop-right.png");

  // 自分自身へのドロップは何も起きない
  await evaluate(dragExpr("demo-05", "demo-05", "after"));
  await sleep(400);
  check("D&D: 自分自身へのドロップは順序を変えない", await evaluate(ORDER_EXPR), afterRight);
  check(
    "D&D 後: ドラッグ状態・目印が残らない",
    await evaluate(`({ dragging: document.querySelectorAll('#tile-grid .tile.is-dragging').length, markers: document.querySelectorAll('#tile-grid .tile.drop-before, #tile-grid .tile.drop-after').length })`),
    { dragging: 0, markers: 0 }
  );

  // 回帰: フォルダの外部ドロップ（登録）は従来どおりオーバーレイが出る
  check(
    "回帰: ファイルを伴う外部ドラッグではオーバーレイが出て、dragleave で消える",
    await evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.txt'));
      const grid = document.querySelector('#tile-grid');
      grid.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const shown = !document.querySelector('#drop-overlay').hidden;
      grid.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { shown, hiddenAfter: document.querySelector('#drop-overlay').hidden };
    })()`),
    { shown: true, hiddenAfter: true }
  );

  // 再起動相当: 新しい ProjectStore が同じ順で読むこと（projects.json の順 = 表示順）は project-store-reorder.test.ts で担保
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ failures, dataDir, at: new Date().toISOString() }, null, 2));
} finally {
  // Browser.close は応答前にプロセスが落ちて promise が未解決のままになるため await しない
  send("Browser.close").catch(() => {});
  await sleep(800);
  if (child.exitCode === null) child.kill();
  ws.close();
}

console.log(failures.length === 0 ? `ALL OK (出力: ${outDir})` : `FAILED: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
