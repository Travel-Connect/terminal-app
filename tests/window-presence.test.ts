/**
 * 未接続タイル（260903_1）: 「クリックで開く対象アプリのウィンドウが今あるか」の判定（純関数部分）。
 * 判定条件は前面化・切断検知と同じ hasWindowFor（exe 名＋タイトルにフォルダ名）を使う。
 * EnumWindows の結果は TopLevelWindow[] として注入するため koffi 不要で検証できる。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { computeWindowPresence, presenceDiff, presenceEquals, WINDOW_POLL_INTERVAL_MS } from "../src/main/window-presence";
import { matchesProjectWindow } from "../src/main/window-control";

function proj(id: string, dir: string, clickTarget: Project["clickTarget"] = "cursor"): Project {
  return { id, name: id, path: dir, clickTarget, registeredAt: "2026-09-03T00:00:00.000Z" };
}

const windows = [
  { title: "index.ts - terminal-app - Cursor", exe: "cursor.exe" },
  { title: "PowerShell - zaico-kanri-app", exe: "windowsterminal.exe" },
  { title: "obsidian-vault - Obsidian v1.6", exe: "obsidian.exe" },
];

describe("computeWindowPresence（260903_1）", () => {
  it("Cursor 対象のプロジェクトは cursor.exe のタイトルにフォルダ名があれば接続あり", () => {
    const result = computeWindowPresence([proj("p1", "C:/Users/hppym/dev/terminal-app")], windows);
    expect(result).toEqual({ p1: true });
  });

  it("フォルダがターミナルでしか開かれていない Cursor 対象プロジェクトは未接続（対象アプリ不一致）", () => {
    const result = computeWindowPresence([proj("p2", "C:/Users/hppym/dev/zaico-kanri-app", "cursor")], windows);
    expect(result).toEqual({ p2: false });
  });

  it("ターミナル対象のプロジェクトは Windows Terminal のタイトル一致で接続あり", () => {
    const result = computeWindowPresence([proj("p2", "C:/Users/hppym/dev/zaico-kanri-app", "terminal")], windows);
    expect(result).toEqual({ p2: true });
  });

  it("対象外アプリ（Obsidian 等）でしか開かれていないフォルダは未接続", () => {
    const result = computeWindowPresence([proj("p3", "C:/Users/hppym/dev/obsidian-vault")], windows);
    expect(result).toEqual({ p3: false });
  });

  it("タイトル一致は大文字小文字を区別しない", () => {
    const result = computeWindowPresence(
      [proj("p1", "C:/Users/hppym/dev/Terminal-App")],
      [{ title: "README.md - TERMINAL-APP - Cursor", exe: "cursor.exe" }]
    );
    expect(result).toEqual({ p1: true });
  });

  it("Windows 形式のパス（バックスラッシュ）でもフォルダ名を取り出せる", () => {
    const result = computeWindowPresence([proj("p1", "C:\\Users\\hppym\\dev\\terminal-app")], windows);
    expect(result).toEqual({ p1: true });
  });

  it("ウィンドウが 1 つも無ければ全プロジェクトが未接続、プロジェクトが無ければ空", () => {
    expect(computeWindowPresence([proj("a", "C:/x/a"), proj("b", "C:/x/b", "terminal")], [])).toEqual({ a: false, b: false });
    expect(computeWindowPresence([], windows)).toEqual({});
  });

  it("workspace 名で開いた Cursor はフォルダ名がタイトルに無くても検出する", () => {
    const project = { ...proj("p1", "C:/dev/api"), workspacePath: "C:/workspaces/Team.code-workspace" };
    const window = { title: "index.ts — Team (Workspace) — Cursor", exe: "C:\\Program Files\\cursor\\Cursor.exe", className: "Chrome_WidgetWin_2" };
    expect(computeWindowPresence([project], [window])).toEqual({ p1: true });
    expect(matchesProjectWindow("cursor", "api", window, project.workspacePath)).toBe(true);
    expect(computeWindowPresence([{ ...project, workspacePath: undefined }], [window])).toEqual({ p1: false });
  });

  it("Chromium のクラス名や Cursor を含むタイトルだけで別アプリを拾わない", () => {
    const project = { ...proj("p1", "C:/dev/api"), workspacePath: "C:/workspaces/Team.code-workspace" };
    const window = { title: "api — Team — Cursor", exe: "chrome.exe", className: "Chrome_WidgetWin_1" };
    expect(computeWindowPresence([project], [window])).toEqual({ p1: false });
    expect(matchesProjectWindow("cursor", "", { title: "other — Cursor", exe: "cursor.exe" })).toBe(false);
  });

  it("ターミナルは workspace 名を流用せず対象のフォルダ名で検出する", () => {
    const project = { ...proj("p1", "C:/dev/api", "terminal"), workspacePath: "C:/workspaces/Team.code-workspace" };
    expect(computeWindowPresence([project], [{ title: "Team", exe: "WindowsTerminal.exe" }])).toEqual({ p1: false });
  });

  it("Cursor のタイトルは末尾「Cursor」直前のセグメント完全一致（260916_5）: 短い名前が他プロジェクトの窓に部分一致しない", () => {
    const dev = proj("dev", "C:/dev");
    const others = [
      { title: "dev-server.ts - webdashboard-app - Cursor", exe: "cursor.exe" },
      { title: "device.md - Pricefluctuation-app - Cursor", exe: "cursor.exe" },
      { title: "Cursor Agents", exe: "cursor.exe" }, // Agents 表示の固定タイトル（フォルダ名なし）
      { title: "Settings - Cursor", exe: "cursor.exe" },
    ];
    expect(computeWindowPresence([dev], others)).toEqual({ dev: false });
    expect(computeWindowPresence([dev], [{ title: "dev - Cursor", exe: "cursor.exe" }])).toEqual({ dev: true });
    expect(computeWindowPresence([dev], [{ title: "● CLAUDE.md - dev - Cursor", exe: "cursor.exe" }])).toEqual({ dev: true });
    expect(computeWindowPresence([dev], [{ title: "notes - draft.md - dev - Cursor", exe: "cursor.exe" }])).toEqual({ dev: true });
  });

  it("フォルダ名に \" - \" を含んでも末尾一致で検出する", () => {
    const p = proj("p1", "C:/work/OneDrive - Company/proj - 2026");
    expect(computeWindowPresence([p], [{ title: "a.md - proj - 2026 - Cursor", exe: "cursor.exe" }])).toEqual({ p1: true });
    expect(computeWindowPresence([p], [{ title: "a.md - 2026 - Cursor", exe: "cursor.exe" }])).toEqual({ p1: false });
  });

  it("タイトルで見つからなくても、Cursor の windowsState がそのフォルダを開いていれば接続扱い（Agents 表示の窓。260916_5）", () => {
    const p = proj("p1", "C:/dev/sunrest-rankget-script");
    const agents = [{ title: "Cursor Agents", exe: "cursor.exe" }];
    const open = [{ folder: "c:\\dev\\sunrest-rankget-script", glassMode: true }];
    expect(computeWindowPresence([p], agents)).toEqual({ p1: false });
    expect(computeWindowPresence([p], agents, open)).toEqual({ p1: true });
    // cursor.exe の窓が 1 つも無ければ windowsState（永続スナップショット）は信じない
    expect(computeWindowPresence([p], [{ title: "PowerShell", exe: "windowsterminal.exe" }], open)).toEqual({ p1: false });
    // ターミナル対象には使わない
    expect(computeWindowPresence([proj("p2", "C:/dev/sunrest-rankget-script", "terminal")], agents, open)).toEqual({ p2: false });
  });
});

describe("presenceEquals / presenceDiff（260903_1）", () => {
  it("同じ内容なら等しい（キー順は問わない）", () => {
    expect(presenceEquals({ a: true, b: false }, { b: false, a: true })).toBe(true);
  });

  it("値が違う・キー集合が違うと等しくない", () => {
    expect(presenceEquals({ a: true }, { a: false })).toBe(false);
    expect(presenceEquals({ a: true }, { a: true, b: true })).toBe(false);
    expect(presenceEquals({ a: true, b: true }, { a: true })).toBe(false);
  });

  it("presenceDiff は値が変わった／新たに現れた id だけを返す（消えた id は返さない）", () => {
    const diff = presenceDiff({ a: true, b: false, gone: true }, { a: true, b: true, c: false });
    expect(diff).toEqual([
      { id: "b", present: true },
      { id: "c", present: false },
    ]);
  });
});

describe("WINDOW_POLL_INTERVAL_MS", () => {
  it("既定は 5 秒（env 未設定時）", () => {
    expect(WINDOW_POLL_INTERVAL_MS).toBe(5_000);
  });
});
