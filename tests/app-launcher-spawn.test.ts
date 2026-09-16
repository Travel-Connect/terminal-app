import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchProjectApp } from "../src/main/app-launcher";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("fs", () => ({ lstatSync: vi.fn() }));

const PROJECT = "C:\\dev\\project with spaces";
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PATH", "C:\\Tools\\Cursor");
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  vi.stubEnv("VSCODE_CWD", "C:\\dev\\different-project");
  vi.stubEnv("VSCODE_IPC_HOOK_CLI", "test-ide-pipe");
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  vi.mocked(fs.lstatSync).mockImplementation(() => ({}) as fs.Stats);
});

afterEach(() => vi.unstubAllEnvs());

function spawnOptions(): SpawnOptions {
  return vi.mocked(spawn).mock.calls[0][2] as SpawnOptions;
}

describe("launchProjectApp", () => {
  it("指定プロジェクトの cwd で Cursor を起動し親の IDE 環境だけを除去する", async () => {
    const pending = launchProjectApp("cursor", PROJECT);
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(["--new-window", PROJECT]);
    const options = spawnOptions();
    expect(options.cwd).toBe(PROJECT);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(options.env === process.env).toBe(false);
    expect(options.env?.PATH).toBe("C:\\Tools\\Cursor");
    for (const key of ["ELECTRON_RUN_AS_NODE", "VSCODE_CWD", "VSCODE_IPC_HOOK_CLI"]) {
      expect(options.env?.[key]).toBeUndefined();
    }
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(process.env.VSCODE_CWD).toBe("C:\\dev\\different-project");
    expect(process.env.VSCODE_IPC_HOOK_CLI).toBe("test-ide-pipe");
    expect(child.unref).not.toHaveBeenCalled();
    child.emit("spawn");
    expect(await pending).toEqual({ ok: true });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("ワークスペースを開く場合も cwd は登録プロジェクトのままにする", async () => {
    const workspace = "C:\\workspaces\\team.code-workspace";
    const pending = launchProjectApp("cursor", PROJECT, workspace);
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(["--new-window", workspace]);
    expect(spawnOptions().cwd).toBe(PROJECT);
    child.emit("spawn");
    expect((await pending).ok).toBe(true);
  });

  it("ターミナルにはワークスペースではなくプロジェクトのディレクトリを渡す", async () => {
    const pending = launchProjectApp("terminal", PROJECT, "C:\\workspaces\\team.code-workspace");
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(["-d", PROJECT]);
    expect(spawnOptions().cwd).toBe(PROJECT);
    child.emit("spawn");
    expect((await pending).ok).toBe(true);
  });

  it("非同期の spawn error を成功として返さず捕捉する", async () => {
    const pending = launchProjectApp("cursor", PROJECT);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("error", new Error("spawn ENOENT"));
    expect(await pending).toEqual({ ok: false, message: "立ち上げに失敗しました: Error: spawn ENOENT" });
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("同期の spawn 失敗も結果に変換する", async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("invalid cwd"); });
    expect(await launchProjectApp("cursor", PROJECT)).toEqual({
      ok: false, message: "立ち上げに失敗しました: Error: invalid cwd",
    });
  });

  it("実行ファイルが見つからなければ spawn しない", async () => {
    vi.mocked(fs.lstatSync).mockImplementation(() => { throw new Error("ENOENT"); });
    expect((await launchProjectApp("cursor", PROJECT)).ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
