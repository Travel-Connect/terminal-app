/**
 * 260916_5: Cursor の windowsState（storage.json）から「開いているフォルダ」を読む。
 * Agents（Glass）表示の窓はタイトルが「Cursor Agents」固定でフォルダ名を含まないため、タイトル一致の第二の根拠にする。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cursorStorageJsonPath,
  findCursorOpenWindow,
  parseCursorWindowsState,
  readCursorOpenWindows,
  resetCursorStateCache,
} from "../src/main/cursor-state";

/** 実測（2026-09-16、Cursor 3.15.6）の形。長いフィールドは省略 */
const REAL = {
  windowsState: {
    lastActiveWindow: { folder: "file:///c%3A/dev", uiState: { mode: 0 } },
    openedWindows: [
      { folder: "file:///c%3A/dev/terminal-app", uiState: { mode: 0, x: 403, y: 431, width: 1281, height: 801 } },
      { folder: "file:///c%3A/dev/sunrest-rankget-script", uiState: { mode: 1, glassMode: true } },
      { folder: "file:///c%3A/Users/tckam/OneDrive%20-%20%E3%83%88%E3%83%A9%E3%83%99%E3%83%AB/%E5%9C%A8%E5%BA%AB", uiState: { mode: 0 } },
      { workspace: { id: "abc", configPath: "file:///c%3A/workspaces/Team.code-workspace" }, uiState: { mode: 0 } },
      { folder: "vscode-remote://ssh-remote%2Bhost/home/me/proj", uiState: { mode: 0 } },
      { uiState: { mode: 0 } },
      null,
    ],
    lastNonExtensionWindowWasOpenOnShutdown: true,
  },
};

describe("parseCursorWindowsState", () => {
  it("folder（file URI）と workspace.configPath をローカルパスへ、glassMode を読む。リモート URI・folder 無しは除く", () => {
    expect(parseCursorWindowsState(JSON.stringify(REAL))).toEqual([
      { folder: "c:\\dev\\terminal-app", glassMode: false },
      { folder: "c:\\dev\\sunrest-rankget-script", glassMode: true },
      { folder: "c:\\Users\\tckam\\OneDrive - トラベル\\在庫", glassMode: false },
      { workspacePath: "c:\\workspaces\\Team.code-workspace", glassMode: false },
    ]);
  });

  it("壊れた JSON・形が違うものは空", () => {
    expect(parseCursorWindowsState("{ nope")).toEqual([]);
    expect(parseCursorWindowsState("null")).toEqual([]);
    expect(parseCursorWindowsState(JSON.stringify({ windowsState: { openedWindows: "x" } }))).toEqual([]);
    expect(parseCursorWindowsState(JSON.stringify({}))).toEqual([]);
  });
});

describe("findCursorOpenWindow", () => {
  const windows = parseCursorWindowsState(JSON.stringify(REAL));

  it("フォルダの大文字小文字・区切り・末尾区切りの違いを無視して一致する", () => {
    expect(findCursorOpenWindow("C:\\dev\\SUNREST-rankget-script\\", windows)?.glassMode).toBe(true);
    expect(findCursorOpenWindow("c:/dev/terminal-app", windows)?.glassMode).toBe(false);
    expect(findCursorOpenWindow("C:\\dev\\other", windows)).toBeUndefined();
    expect(findCursorOpenWindow("C:\\dev", windows)).toBeUndefined(); // 親フォルダは別の窓
  });

  it("workspace の関連付けがあれば workspace ファイルでも一致する", () => {
    expect(findCursorOpenWindow("C:\\dev\\api", windows, "C:/workspaces/team.code-workspace")).toBeDefined();
    expect(findCursorOpenWindow("C:\\dev\\api", windows)).toBeUndefined();
  });
});

describe("readCursorOpenWindows（ファイル）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-cursor-state-"));
    resetCursorStateCache();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("既定パスは %APPDATA%\\Cursor\\User\\globalStorage\\storage.json", () => {
    expect(cursorStorageJsonPath("C:\\Users\\me\\AppData\\Roaming")).toBe("C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage\\storage.json");
  });

  it("無い・壊れているときは空。書き換えれば（mtime/サイズが変われば）読み直す", () => {
    const file = path.join(dir, "storage.json");
    expect(readCursorOpenWindows(file)).toEqual([]);
    fs.writeFileSync(file, "{ broken");
    expect(readCursorOpenWindows(file)).toEqual([]);
    fs.writeFileSync(file, JSON.stringify(REAL));
    expect(readCursorOpenWindows(file)).toHaveLength(4);
    fs.writeFileSync(file, JSON.stringify({ windowsState: { openedWindows: [{ folder: "file:///d%3A/x" }] } }));
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(file, t, t);
    expect(readCursorOpenWindows(file)).toEqual([{ folder: "d:\\x", glassMode: false }]);
  });
});
