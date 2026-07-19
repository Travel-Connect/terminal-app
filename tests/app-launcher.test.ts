/**
 * 立ち上げ（260717_1）の解決ロジック検証。
 * resolveLaunchCommand は env と存在確認を注入できるため、実環境に依存せずに
 * 「どのインストールを・どの引数で起動するか」を確認する。
 */
import * as path from "path";
import { describe, expect, it } from "vitest";
import { resolveLaunchCommand, type ResolveDeps } from "../src/main/app-launcher";

const PROJECT = "C:\\Users\\me\\dev\\my-app";

function deps(env: ResolveDeps["env"], existing: string[]): ResolveDeps {
  const set = new Set(existing.map((p) => path.normalize(p).toLowerCase()));
  return { env, exists: (p) => set.has(path.normalize(p).toLowerCase()) };
}

describe("resolveLaunchCommand: cursor", () => {
  it("PATH の cursor bin エントリから Cursor.exe を導出する（最優先）", () => {
    const bin = "C:\\Program Files\\cursor\\resources\\app\\bin";
    const exe = "C:\\Program Files\\cursor\\Cursor.exe";
    const localExe = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    const d = deps(
      {
        PATH: ["C:\\Windows", bin].join(path.delimiter),
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      [exe, localExe] // 両方実在しても PATH 由来を優先する
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(exe));
    expect(cmd!.args).toEqual([PROJECT]);
  });

  it("PATH に cursor bin が無ければ %LOCALAPPDATA%\\Programs\\cursor へフォールバックする", () => {
    const localExe = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    const d = deps(
      { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      [localExe]
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(localExe));
  });

  it("%ProgramFiles%\\cursor もフォールバック候補になる", () => {
    const pfExe = "C:\\Program Files\\cursor\\Cursor.exe";
    const d = deps(
      { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
      [pfExe]
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(pfExe));
  });

  it("PATH の bin エントリが実在しない Cursor.exe を指すなら拾わない（exists で除外）", () => {
    const bin = "C:\\old\\cursor\\resources\\app\\bin"; // アンインストール後に残った PATH エントリ
    const localExe = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    const d = deps(
      { PATH: bin, LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      [localExe]
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(localExe));
  });

  it("どの候補も実在しなければ null（呼び出し側がエラーメッセージにする）", () => {
    const d = deps({ PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, []);
    expect(resolveLaunchCommand("cursor", PROJECT, d)).toBeNull();
  });
});

describe("resolveLaunchCommand: terminal", () => {
  it("PATH 上の wt.exe を -d <projectPath> 付きで解決する", () => {
    const wtDir = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps";
    const d = deps(
      { PATH: ["C:\\Windows", wtDir].join(path.delimiter) },
      [path.join(wtDir, "wt.exe")]
    );
    const cmd = resolveLaunchCommand("terminal", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(path.join(wtDir, "wt.exe")));
    expect(cmd!.args).toEqual(["-d", PROJECT]);
  });

  it("PATH に無くても %LOCALAPPDATA%\\Microsoft\\WindowsApps のエイリアスを拾う", () => {
    const alias = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const d = deps(
      { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      [alias]
    );
    const cmd = resolveLaunchCommand("terminal", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(alias));
  });

  it("wt.exe が見つからなければ null", () => {
    const d = deps({ PATH: "C:\\Windows" }, []);
    expect(resolveLaunchCommand("terminal", PROJECT, d)).toBeNull();
  });
});
