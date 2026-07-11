/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
/**
 * ⑤ ウィンドウ制御（design.md 7 章 / REQ-05, REQ-06）。
 * koffi（N-API ベース FFI）で user32.dll / kernel32.dll を呼ぶ。
 * - 対象探索: プロセス exe 名 ＋ ウィンドウタイトルにプロジェクト folder 名（大文字小文字非区別）。
 *   複数一致時は Z オーダー最前面（EnumWindows は Z 順で列挙される）
 * - 前面化: IsIconic → ShowWindow(SW_RESTORE) → SetForegroundWindow。
 *   失敗時フォールバック: AttachThreadInput → ALT キー送出（design.md 7.2）
 * - koffi がロードできない環境でも本体を落とさない（失敗を FocusOutcome で返す）
 */
import * as path from "path";
import type { ClickTarget } from "../shared/types";

export interface FocusOutcome {
  ok: boolean;
  message?: string;
}

export interface TopLevelWindow {
  title: string;
  exe: string;
}

const SW_RESTORE = 9;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** clickTarget → 対象プロセス exe 名（design.md 7.1） */
const TARGET_EXES: Record<ClickTarget, string[]> = {
  cursor: ["cursor.exe"],
  terminal: [
    "windowsterminal.exe",
    "conhost.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "mintty.exe",
  ],
};

interface Win32Api {
  koffi: any;
  EnumWindowsProc: any;
  EnumWindows: any;
  IsWindowVisible: any;
  GetWindowTextW: any;
  GetWindowThreadProcessId: any;
  IsIconic: any;
  ShowWindow: any;
  SetForegroundWindow: any;
  GetForegroundWindow: any;
  AttachThreadInput: any;
  KeybdEvent: any;
  OpenProcess: any;
  QueryFullProcessImageNameW: any;
  CloseHandle: any;
  GetCurrentThreadId: any;
}

let cached: Win32Api | null | undefined;

function loadApi(): Win32Api | null {
  if (cached !== undefined) return cached;
  if (process.platform !== "win32") {
    cached = null;
    return cached;
  }
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)");
    cached = {
      koffi,
      EnumWindowsProc,
      EnumWindows: user32.func("bool __stdcall EnumWindows(EnumWindowsProc *proc, intptr_t lParam)"),
      IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(void *hwnd)"),
      GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *str, int nMaxCount)"),
      GetWindowThreadProcessId: user32.func(
        "uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)"
      ),
      IsIconic: user32.func("bool __stdcall IsIconic(void *hwnd)"),
      ShowWindow: user32.func("bool __stdcall ShowWindow(void *hwnd, int nCmdShow)"),
      SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(void *hwnd)"),
      GetForegroundWindow: user32.func("void *__stdcall GetForegroundWindow()"),
      AttachThreadInput: user32.func("bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)"),
      KeybdEvent: user32.func("void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, size_t dwExtraInfo)"),
      OpenProcess: kernel32.func("void *__stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
      QueryFullProcessImageNameW: kernel32.func(
        "bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)"
      ),
      CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *h)"),
      GetCurrentThreadId: kernel32.func("uint32_t __stdcall GetCurrentThreadId()"),
    };
  } catch (e) {
    console.error(`window-control: koffi のロードに失敗しました: ${String(e)}`);
    cached = null;
  }
  return cached;
}

export function isAvailable(): boolean {
  return loadApi() !== null;
}

function decodeUtf16(arr: Uint16Array, len: number): string {
  return String.fromCharCode(...Array.from(arr.subarray(0, len)));
}

function getWindowTitle(api: Win32Api, hwnd: any): string {
  const buf = new Uint16Array(512);
  const len = api.GetWindowTextW(hwnd, buf, buf.length) as number;
  return len > 0 ? decodeUtf16(buf, len) : "";
}

function getProcessExe(api: Win32Api, hwnd: any): string {
  const pidBuf = new Uint32Array(1);
  api.GetWindowThreadProcessId(hwnd, pidBuf);
  const pid = pidBuf[0];
  if (pid === 0) return "";
  const h = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (h === null) return "";
  try {
    const nameBuf = new Uint16Array(1024);
    const sizeBuf = new Uint32Array([nameBuf.length]);
    const ok = api.QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf) as boolean;
    if (!ok) return "";
    return path.basename(decodeUtf16(nameBuf, sizeBuf[0])).toLowerCase();
  } finally {
    api.CloseHandle(h);
  }
}

interface EnumResult {
  hwnd: any;
  title: string;
  exe: string;
}

/** 可視トップレベルウィンドウを Z オーダー順（手前から）で列挙する */
function enumWindows(api: Win32Api): EnumResult[] {
  const results: EnumResult[] = [];
  const cb = api.koffi.register((hwnd: any, _lParam: unknown) => {
    try {
      if (!api.IsWindowVisible(hwnd)) return true;
      const title = getWindowTitle(api, hwnd);
      if (title === "") return true;
      results.push({ hwnd, title, exe: getProcessExe(api, hwnd) });
    } catch {
      /* 個別ウィンドウの取得失敗は列挙を止めない */
    }
    return true;
  }, api.koffi.pointer(api.EnumWindowsProc));
  try {
    api.EnumWindows(cb, 0);
  } finally {
    api.koffi.unregister(cb);
  }
  return results;
}

/** smoke 検証・デバッグ用: 可視トップレベルウィンドウの一覧（タイトル・プロセス exe 名） */
export function listTopLevelWindows(): TopLevelWindow[] {
  const api = loadApi();
  if (api === null) return [];
  return enumWindows(api).map((w) => ({ title: w.title, exe: w.exe }));
}

/**
 * 対象プロジェクトのウィンドウが一覧に存在するか（切断検知の補助シグナル。260712_2）。
 * 探索条件は focusProjectWindow と同一（exe 名 ＋ タイトルに folder 名。design.md 7.1）。
 * タイトル一致はヒューリスティックのため偽陰性がある（タブ切替でタイトルが変わる等）—
 * 呼び出し側（liveness-monitor）は「消失」を単独の切断根拠にしないこと。
 */
export function hasWindowFor(target: ClickTarget, folderName: string, windows: readonly TopLevelWindow[]): boolean {
  const wanted = TARGET_EXES[target];
  const needle = folderName.toLowerCase();
  return windows.some((w) => wanted.includes(w.exe) && w.title.toLowerCase().includes(needle));
}

function isForeground(api: Win32Api, hwnd: any): boolean {
  try {
    const fg = api.GetForegroundWindow();
    if (fg === null || hwnd === null) return false;
    return String(api.koffi.address(fg)) === String(api.koffi.address(hwnd));
  } catch {
    return false;
  }
}

/**
 * クリック → 前面化（design.md 3.2(c) / 7 章）。
 * folderName = プロジェクトのフォルダ basename（タイトル一致はヒューリスティック。design.md 7.1）
 */
export function focusProjectWindow(target: ClickTarget, folderName: string): FocusOutcome {
  const api = loadApi();
  if (api === null) {
    return { ok: false, message: "Win32 API を利用できません（koffi 未ロード）" };
  }
  try {
    const wanted = TARGET_EXES[target];
    const needle = folderName.toLowerCase();
    // EnumWindows は Z 順（手前から）のため、最初の一致 = Z オーダー最前面（design.md 7.1）
    const found = enumWindows(api).find(
      (w) => wanted.includes(w.exe) && w.title.toLowerCase().includes(needle)
    );
    if (found === undefined) {
      return { ok: false, message: `ウィンドウが見つかりません（${folderName} / ${target}）` };
    }
    return bringToForeground(api, found.hwnd);
  } catch (e) {
    return { ok: false, message: `前面化に失敗しました: ${String(e)}` };
  }
}

/** design.md 7.2 の手順: SW_RESTORE → SetForegroundWindow → AttachThreadInput → ALT 送出 */
function bringToForeground(api: Win32Api, hwnd: any): FocusOutcome {
  if (api.IsIconic(hwnd)) {
    api.ShowWindow(hwnd, SW_RESTORE); // 最小化なら復元（AC-09）
  }
  api.SetForegroundWindow(hwnd);
  if (isForeground(api, hwnd)) return { ok: true };

  // フォールバック 1: AttachThreadInput で対象スレッドの入力に接続して再試行
  const pidBuf = new Uint32Array(1);
  const targetThread = api.GetWindowThreadProcessId(hwnd, pidBuf) as number;
  const currentThread = api.GetCurrentThreadId() as number;
  if (targetThread !== 0 && targetThread !== currentThread) {
    api.AttachThreadInput(currentThread, targetThread, true);
    try {
      api.SetForegroundWindow(hwnd);
    } finally {
      api.AttachThreadInput(currentThread, targetThread, false);
    }
    if (isForeground(api, hwnd)) return { ok: true };
  }

  // フォールバック 2: ALT キー送出でフォアグラウンドロックを解除して再試行
  api.KeybdEvent(VK_MENU, 0, 0, 0);
  api.SetForegroundWindow(hwnd);
  api.KeybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  if (isForeground(api, hwnd)) return { ok: true };

  return { ok: false, message: "前面化に失敗しました（フォアグラウンド制約）" };
}
