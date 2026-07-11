// V-09（クリックで前面化・最小化からの復元）の実ウィンドウ自動検証（6 章 #8 / #9 の実測化）。
// 検証用の実ターミナルウィンドウ（cmd。Windows 11 の既定ターミナル委任下では Windows Terminal、
// 委任なしではクラシックコンソール）を新規に開き、アプリ本体と同じ window-control
// （dist/main/window-control.js の focusProjectWindow）で
//   (1) 前面化できること（#8）
//   (2) 最小化した状態からでも復元＋前面化できること（#9）
// を GetForegroundWindow / IsIconic の実測で確認する。
// 後片付けは内側の cmd.exe プロセスのみを kill する（Windows Terminal は全ウィンドウ共有の
// 単一プロセスのため、WT プロセス自体を kill するとユーザーの他ウィンドウを巻き込む）。
// 注意: 実行中は一時的にフォーカスが検証用ウィンドウへ移る（終了時に元へ戻す）。
//
// 使い方: npm run build 後に node scripts/verify-foreground.mjs <出力ディレクトリ>
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = resolve(process.argv[2] ?? join(root, "verify-out"));
mkdirSync(outDir, { recursive: true });
const resultLog = join(outDir, "foreground-results.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(line);
  appendFileSync(resultLog, line + "\n", "utf8");
}
writeFileSync(resultLog, `# V-09 前面化・最小化復元の実測（${new Date().toISOString()}）\n`, "utf8");

const wc = require(join(root, "dist", "main", "window-control.js"));
const koffi = require("koffi");
const user32 = koffi.load("user32.dll");
const EnumWindowsProc = koffi.proto("bool __stdcall VerifyEnumProc(void *hwnd, intptr_t lParam)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(VerifyEnumProc *proc, intptr_t lParam)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *str, int nMaxCount)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hwnd)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void *hwnd)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hwnd, int nCmdShow)");
const IsIconic = user32.func("bool __stdcall IsIconic(void *hwnd)");
const SW_MINIMIZE = 6;

/** タイトルが prefix で始まる可視トップレベルウィンドウの hwnd を返す（委任先によりタイトル末尾が揺れるため前方一致） */
function findHwndByTitlePrefix(prefix) {
  let found = null;
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true;
    const buf = new Uint16Array(512);
    const len = GetWindowTextW(hwnd, buf, buf.length);
    const title = len > 0 ? String.fromCharCode(...Array.from(buf.subarray(0, len))) : "";
    if (title.startsWith(prefix)) {
      found = hwnd;
      return false; // 発見したら列挙終了
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found;
}

const sameHwnd = (a, b) => a !== null && b !== null && String(koffi.address(a)) === String(koffi.address(b));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const TITLE = "ta-v09-target-window";
const prevFg = GetForegroundWindow(); // 終了時にフォーカスを戻すため保存

// Start-Process で新規コンソールを開き、内側の cmd.exe の PID を控える（後片付け用）
const cmdPid = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", `(Start-Process -FilePath cmd.exe -ArgumentList '/k','title ${TITLE}' -PassThru).Id`],
  { encoding: "utf8" }
).trim();

let hwnd = null;
for (let i = 0; i < 20 && hwnd === null; i++) {
  await sleep(300);
  hwnd = findHwndByTitlePrefix(TITLE);
}

try {
  if (hwnd === null) {
    check("検証用コンソールウィンドウの起動", false, "ウィンドウが見つからない");
  } else {
    const entry = wc.listTopLevelWindows().find((w) => w.title.startsWith(TITLE));
    log(`検証用ウィンドウ: title=${entry?.title ?? TITLE} exe=${entry?.exe ?? "?"}（terminal 対象 exe 群のいずれかであること）`);

    // (1) #8: タイルクリックと同じ経路（focusProjectWindow）で前面化できる
    const o1 = wc.focusProjectWindow("terminal", "ta-v09-target");
    await sleep(400);
    check("前面化 #8: focusProjectWindow が成功を返す", o1.ok === true, o1.message);
    check("前面化 #8: GetForegroundWindow が対象ウィンドウ", sameHwnd(GetForegroundWindow(), hwnd));

    // (2) #9: 最小化した状態から復元＋前面化できる
    ShowWindow(hwnd, SW_MINIMIZE);
    await sleep(500);
    check("最小化: IsIconic = true（前提の成立確認）", IsIconic(hwnd) === true);
    const o2 = wc.focusProjectWindow("terminal", "ta-v09-target");
    await sleep(400);
    check("復元 #9: focusProjectWindow が成功を返す", o2.ok === true, o2.message);
    check("復元 #9: 最小化が解除された（IsIconic = false）", IsIconic(hwnd) === false);
    check("復元 #9: GetForegroundWindow が対象ウィンドウ", sameHwnd(GetForegroundWindow(), hwnd));

    // 存在しない対象は失敗を返す（例外にならない）ことの再確認（win32-smoke と同枠）
    const o3 = wc.focusProjectWindow("terminal", "__no_such_window__");
    check("不一致対象: ok=false を返し例外にならない", o3.ok === false, o3.message);
  }
} finally {
  // 後片付け: 内側の cmd.exe のみ kill（コンソールが閉じ、ホスト側ウィンドウも自動で閉じる）
  try {
    execFileSync("taskkill", ["/PID", cmdPid, "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* 既に終了していれば無視 */
  }
  if (prevFg !== null) SetForegroundWindow(prevFg); // フォーカスを元のウィンドウへ（ベストエフォート）
}

const failed = checks.filter((c) => !c.ok);
log(`## 結果: ${checks.length - failed.length}/${checks.length} PASS${failed.length ? ` — FAIL: ${failed.map((c) => c.name).join(" / ")}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;
