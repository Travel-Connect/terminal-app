/**
 * 立ち上げ（260717_1）: 閉じていた Cursor / ターミナルをプロジェクトフォルダ付きで起動する。
 * 前面化（window-control）は既存ウィンドウの探索のみで、対象アプリが閉じていると
 * 「ウィンドウが見つかりません」で終わる — その場面からの手動復帰導線（タイル右クリック →「立ち上げる」）。
 * - cursor: `Cursor.exe --new-window <projectPath>`。インストール先は PATH の `resources\app\bin`
 *   エントリから逆算 → 既定パス（%LOCALAPPDATA%\Programs\cursor / %ProgramFiles%\cursor）の順で解決
 * - terminal: `wt.exe -d <projectPath>`（Windows Terminal。PATH → WindowsApps エイリアスの順で解決）
 * 解決ロジックは resolveLaunchCommand に分離し、env と存在確認を注入してテスト可能にする
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ClickTarget } from "../shared/types";

export interface LaunchOutcome {
  ok: boolean;
  message?: string;
}

export interface LaunchCommand {
  exe: string;
  args: string[];
}

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
}

/** PATH エントリを分割する（空要素は除く） */
function pathDirs(env: ResolveDeps["env"]): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d !== "");
}

/**
 * Cursor の実行ファイルを解決する。
 * PATH には CLI（cursor.cmd）の bin ディレクトリが載るため、そこから 3 階層上の
 * Cursor.exe を導出する（ユーザーが実際に使っているインストールを最優先にする狙い）。
 */
function cursorCandidates(deps: ResolveDeps): string[] {
  const fromPath = pathDirs(deps.env).flatMap((d) => {
    const direct = path.join(d, "Cursor.exe");
    return /[\\/]resources[\\/]app[\\/]bin[\\/]?$/i.test(d)
      ? [path.join(d, "..", "..", "..", "Cursor.exe"), direct]
      : [direct];
  });
  const fixed = [
    deps.env.LOCALAPPDATA !== undefined ? path.join(deps.env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe") : null,
    deps.env.ProgramFiles !== undefined ? path.join(deps.env.ProgramFiles, "cursor", "Cursor.exe") : null,
    deps.env["ProgramFiles(x86)"] !== undefined ? path.join(deps.env["ProgramFiles(x86)"], "cursor", "Cursor.exe") : null,
  ].filter((p): p is string => p !== null);
  return [...fromPath, ...fixed];
}

/** Windows Terminal（wt.exe）を解決する。PATH 走査 → WindowsApps の実行エイリアスの順 */
function terminalCandidates(deps: ResolveDeps): string[] {
  const fromPath = pathDirs(deps.env).map((d) => path.join(d, "wt.exe"));
  const alias =
    deps.env.LOCALAPPDATA !== undefined
      ? [path.join(deps.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe")]
      : [];
  return [...fromPath, ...alias];
}

/**
 * clickTarget → 起動コマンド（exe と引数）の解決。見つからなければ null。
 * 候補はすべて deps.exists で実在確認する（PATH に残った古いエントリを拾わない）
 */
export interface LaunchOptions {
  /**
   * false のとき Cursor を `--new-window` 無しで起動する（260916_5）: 既に開いているフォルダなら Cursor が
   * 既存ウィンドウを前面化する（タイトルで見つけられない Agents 表示の窓の前面化に使う）
   */
  newWindow?: boolean;
}

export function resolveLaunchCommand(
  target: ClickTarget,
  projectPath: string,
  deps: ResolveDeps,
  opts: LaunchOptions = {}
): LaunchCommand | null {
  if (target === "cursor") {
    const exe = cursorCandidates(deps).find(deps.exists);
    if (exe === undefined) return null;
    return { exe, args: opts.newWindow === false ? [projectPath] : ["--new-window", projectPath] };
  }
  const exe = terminalCandidates(deps).find(deps.exists);
  return exe !== undefined ? { exe, args: ["-d", projectPath] } : null;
}

/**
 * 実在確認は lstat で行う（stat 追従の existsSync だと WindowsApps の実行エイリアス
 * = アプリ実行エイリアスの reparse point で false になり、wt.exe を見落とす）
 */
function fileExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 対象アプリをプロジェクトフォルダ付きで起動する（detach して本アプリと生存を切り離す）。
 * 起動の成否 = spawn の受理まで（アプリ側の初期化失敗までは追わない）
 */
export async function launchProjectApp(
  target: ClickTarget,
  projectPath: string,
  workspacePath?: string,
  opts: LaunchOptions = {}
): Promise<LaunchOutcome> {
  const cmd = resolveLaunchCommand(
    target,
    target === "cursor" ? workspacePath ?? projectPath : projectPath,
    { env: process.env, exists: fileExists },
    opts
  );
  if (cmd === null) {
    return {
      ok: false,
      message:
        target === "cursor"
          ? "Cursor が見つかりません（Cursor.exe を解決できませんでした）"
          : "Windows Terminal（wt.exe）が見つかりません",
    };
  }
  // IDE 内から本アプリを起動した場合も、子アプリを Node モードや元の IDE の cwd へ誘導しない。
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["ELECTRON_RUN_AS_NODE", "VSCODE_CWD", "VSCODE_IPC_HOOK_CLI"].includes(key.toUpperCase())) delete env[key];
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.exe, cmd.args, { detached: true, stdio: "ignore", cwd: projectPath, env });
      child.once("error", (e) => resolve({ ok: false, message: `立ち上げに失敗しました: ${String(e)}` }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, message: `立ち上げに失敗しました: ${String(e)}` });
    }
  });
}
