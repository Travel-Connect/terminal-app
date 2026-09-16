/**
 * Cursor が自分で書くウィンドウ状態（260916_5）: `%APPDATA%\Cursor\User\globalStorage\storage.json` の
 * `windowsState.openedWindows[]`（folder = file URI、workspace.configPath、uiState.glassMode）。
 *
 * 背景: Cursor 3.x の Agents（Glass）表示の窓はタイトルが固定文字列「Cursor Agents」でフォルダ名を含まない
 * （2026-09-16 実測。`resources\app\out\main.js` に `VA="Cursor Agents"`）。タイトル一致だけに頼ると、その窓の
 * プロジェクトは前面化・未接続判定・位置復元がすべて外れる。ここで読む「開いているフォルダ」を第二の根拠にする:
 * - 未接続判定: タイトルで見つからなくても、Cursor が「開いている」と記録していれば接続扱い
 * - 前面化: タイトルで見つからなければ `Cursor.exe <folder>`（--new-window 無し）を起動し、Cursor 自身に
 *   既存ウィンドウの前面化を任せる（VS Code 系は既に開いているフォルダを既存ウィンドウへ集約する）
 * storage.json は Cursor がウィンドウの開閉・終了時に書く永続スナップショットで、閉じた直後は古いことがある。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { normalizePath } from "./state-store";

export interface CursorOpenWindow {
  /** フォルダで開いた窓のローカルパス（file URI をデコード済み） */
  folder?: string;
  /** .code-workspace で開いた窓の workspace ファイルのパス */
  workspacePath?: string;
  /** Agents（Glass）表示か */
  glassMode: boolean;
}

export function cursorStorageJsonPath(appData: string | undefined = process.env.APPDATA): string {
  const base = appData !== undefined && appData.trim() !== "" ? appData : path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "Cursor", "User", "globalStorage", "storage.json");
}

function localPathOfUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return undefined; // vscode-remote:// 等は対象外
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/** storage.json の本文 → 開いている窓の一覧（壊れている・形が違うときは空） */
export function parseCursorWindowsState(text: string): CursorOpenWindow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== "object") return [];
  const ws = (raw as Record<string, unknown>).windowsState;
  if (ws === null || typeof ws !== "object") return [];
  const opened = (ws as Record<string, unknown>).openedWindows;
  if (!Array.isArray(opened)) return [];
  const out: CursorOpenWindow[] = [];
  for (const w of opened) {
    if (w === null || typeof w !== "object") continue;
    const rec = w as Record<string, unknown>;
    const folder = localPathOfUri(rec.folder);
    const workspace = rec.workspace;
    const workspacePath =
      workspace !== null && typeof workspace === "object" ? localPathOfUri((workspace as Record<string, unknown>).configPath) : undefined;
    if (folder === undefined && workspacePath === undefined) continue;
    const ui = rec.uiState;
    const glassMode = ui !== null && typeof ui === "object" && (ui as Record<string, unknown>).glassMode === true;
    const entry: CursorOpenWindow = { glassMode };
    if (folder !== undefined) entry.folder = folder;
    if (workspacePath !== undefined) entry.workspacePath = workspacePath;
    out.push(entry);
  }
  return out;
}

let cache: { file: string; mtimeMs: number; size: number; windows: CursorOpenWindow[] } | null = null;

/** storage.json を読む（mtime とサイズが同じ間はキャッシュ）。無い・読めないときは空 */
export function readCursorOpenWindows(file: string = cursorStorageJsonPath()): CursorOpenWindow[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  if (cache !== null && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.windows;
  let windows: CursorOpenWindow[];
  try {
    windows = parseCursorWindowsState(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, windows };
  return windows;
}

/** テスト用: キャッシュを捨てる */
export function resetCursorStateCache(): void {
  cache = null;
}

/** プロジェクト（フォルダ、または関連付けた workspace）を開いている Cursor の窓 */
export function findCursorOpenWindow(
  projectPath: string,
  windows: readonly CursorOpenWindow[],
  workspacePath?: string
): CursorOpenWindow | undefined {
  const projectN = normalizePath(path.resolve(projectPath));
  const wsN = workspacePath !== undefined ? normalizePath(path.resolve(workspacePath)) : undefined;
  return windows.find(
    (w) =>
      (w.folder !== undefined && normalizePath(path.resolve(w.folder)) === projectN) ||
      (wsN !== undefined && w.workspacePath !== undefined && normalizePath(path.resolve(w.workspacePath)) === wsN)
  );
}
