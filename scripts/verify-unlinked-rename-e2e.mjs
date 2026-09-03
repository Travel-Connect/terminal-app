/* global fetch, WebSocket */
/**
 * 260903 E2E 検証: 実 Electron（--demo）を remote-debugging（CDP）で操作し、
 * (1) 未接続タイル（260903_1）の灰色表示・ステータスバーのトグルで非表示・config.json への保持
 * (2) 表示名の変更（260903_2）のダイアログ → 保存 → projects.json 永続化 → タイル反映、
 *     上限超過の拒否、空入力でフォルダ名へ復帰
 * を実 IPC 往復で通し、スクリーンショットと JSON で裏取りする。
 *
 * 使い方: npm run build 後に node scripts/verify-unlinked-rename-e2e.mjs [出力先ディレクトリ]
 * 専用ポート・一時 dataDir を使うため実稼働アプリ（既定 41321）と並走できる。
 * 期待と食い違う結果があれば非 0 で終了する。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42195;
const CDP_PORT = 9333;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-unlinked-e2e-"));
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
  [".", "--demo", "--view=settings", `--remote-debugging-port=${CDP_PORT}`],
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

try {
  await sleep(800);

  // --- 表示名の変更（260903_2） ---
  await evaluate(`(() => { const v = document.querySelector('#view-settings'); v.scrollTop = v.scrollHeight; return true; })()`);
  await sleep(300);
  await shot("01-settings-project-rows.png");
  check("設定画面の ✎ ボタン（折りたたみ前 5 行）", await evaluate(`document.querySelectorAll('#project-list .btn-edit').length`), 5);

  await evaluate(`document.querySelector('#project-list .btn-edit').click()`);
  await sleep(300);
  check(
    "ダイアログが現在名・フォルダ付きで開きフォーカスされる",
    await evaluate(`({ hidden: document.querySelector('#rename-dialog').hidden, value: document.querySelector('#rename-input').value, focused: document.activeElement === document.querySelector('#rename-input') })`),
    { hidden: false, value: "在庫管理-app", focused: true }
  );
  await shot("02-rename-dialog.png");

  await evaluate(`(() => { document.querySelector('#rename-input').value = '在庫管理（本番）'; document.querySelector('#rename-form').requestSubmit(); return true; })()`);
  await sleep(700);
  check(
    "保存でダイアログが閉じ、行名とステータスバーに反映",
    await evaluate(`({ dialogHidden: document.querySelector('#rename-dialog').hidden, rowName: document.querySelector('#project-list .project-name').textContent, status: document.querySelector('#status-message').textContent })`),
    { dialogHidden: true, rowName: "在庫管理（本番）", status: "表示名を変更しました: 在庫管理-app → 在庫管理（本番）" }
  );
  check("projects.json に永続化（path は不変）", { name: readJson("projects.json").projects[0].name, path: readJson("projects.json").projects[0].path }, { name: "在庫管理（本番）", path: "C:\\dev\\demo\\在庫管理-app" });

  await evaluate(`document.querySelector('#project-list .btn-edit').click()`);
  await sleep(200);
  await evaluate(`(() => { const i = document.querySelector('#rename-input'); i.removeAttribute('maxlength'); i.value = 'あ'.repeat(41); document.querySelector('#rename-form').requestSubmit(); return true; })()`);
  await sleep(600);
  check(
    "41 文字は拒否され、ダイアログは開いたまま",
    await evaluate(`({ dialogHidden: document.querySelector('#rename-dialog').hidden, status: document.querySelector('#status-message').textContent })`),
    { dialogHidden: false, status: "表示名は 40 文字以内にしてください" }
  );
  await shot("03-rename-too-long.png");
  await evaluate(`document.querySelector('#rename-cancel').click()`);
  await sleep(200);

  await evaluate(`document.querySelector('#project-list .btn-edit').click()`);
  await sleep(200);
  await evaluate(`(() => { document.querySelector('#rename-input').value = '   '; document.querySelector('#rename-form').requestSubmit(); return true; })()`);
  await sleep(600);
  check("空入力はフォルダ名へ戻る", await evaluate(`document.querySelector('#project-list .project-name').textContent`), "在庫管理-app");

  await evaluate(`document.querySelector('#project-list .btn-edit').click()`);
  await sleep(200);
  await evaluate(`(() => { document.querySelector('#rename-input').value = '在庫管理（本番）'; document.querySelector('#rename-form').requestSubmit(); return true; })()`);
  await sleep(600);
  await evaluate(`document.querySelector('#btn-back').click()`);
  await sleep(300);
  await shot("04-main-renamed-tile.png");
  check("タイル名に反映", await evaluate(`document.querySelector('#tile-grid .tile .tile-name').textContent`), "在庫管理（本番）");

  // --- 未接続タイル（260903_1） ---
  check(
    "未接続 2 件が灰色（実行中の問い合わせbot は除外）・全 12 タイル表示・トグル ON",
    await evaluate(`({ label: document.querySelector('#unlinked-label').textContent, checked: document.querySelector('#unlinked-check').checked, visible: [...document.querySelectorAll('#tile-grid .tile')].filter(t => !t.hidden).length, unlinked: [...document.querySelectorAll('#tile-grid .tile.is-unlinked')].map(t => t.querySelector('.tile-name').textContent) })`),
    { label: "未接続を表示（2）", checked: true, visible: 12, unlinked: ["商品ページ作成-app", "売上レポート-app"] }
  );
  check(
    "未接続タイルのツールチップに復帰導線",
    (await evaluate(`document.querySelector('#tile-grid .tile.is-unlinked').title`)).includes("「立ち上げる」"),
    true
  );
  await evaluate(`document.querySelector('#unlinked-check').click()`);
  await sleep(600);
  check(
    "トグル OFF で未接続 2 件が消え 10 タイル表示",
    await evaluate(`({ label: document.querySelector('#unlinked-label').textContent, checked: document.querySelector('#unlinked-check').checked, visible: [...document.querySelectorAll('#tile-grid .tile')].filter(t => !t.hidden).length })`),
    { label: "未接続を表示（2）", checked: false, visible: 10 }
  );
  await shot("05-main-unlinked-hidden.png");
  check("config.json に showUnlinked=false が保持", readJson("config.json").showUnlinked, false);
} finally {
  // Browser.close は応答前にプロセスが落ちて promise が未解決のままになるため await しない
  send("Browser.close").catch(() => {});
  await sleep(800);
  if (child.exitCode === null) child.kill();
  ws.close();
}

console.log(failures.length === 0 ? `ALL OK (出力: ${outDir})` : `FAILED: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
