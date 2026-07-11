/**
 * hooks-manager の単体テスト（verification.md V-02 / V-03, spec.md AC-02 / AC-03, NFR-03）。
 * 「既存 hooks を壊さない」「不正 JSON は一切書き込まない」「冪等」「自アプリ分のみ除去」を固める。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupPathFor,
  buildHookCommand,
  mergeHooks,
  removeHooks,
  settingsPathFor,
} from "../src/main/hooks-manager";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-hooks-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf8"));
}

function writeSettings(content: string): void {
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(settingsPathFor(dir), content, "utf8");
}

describe("mergeHooks（V-02 / AC-02: 登録時の hooks 自動追記）", () => {
  it(".claude が無い場合は {} から開始し Stop / Notification を追記する（design.md 4.2 手順1）", () => {
    const result = mergeHooks(dir, 41321);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const settings = readSettings();
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }>>;
    for (const evt of ["Stop", "Notification"]) {
      expect(hooks[evt]).toHaveLength(1);
      const cmd = hooks[evt][0].hooks[0];
      expect(cmd.type).toBe("command");
      expect(cmd.timeout).toBe(5);
      expect(cmd.command).toBe(buildHookCommand(41321));
      expect(cmd.command).toContain("terminal-app"); // 識別マーカー（design.md 4.1）
      expect(cmd.command).toContain("http://127.0.0.1:41321/terminal-app/event");
      expect(cmd.command).toContain("-m 2"); // NFR-02: 短タイムアウト
    }
  });

  it("既存 hooks・他の設定キーを一切変更せずに追記する（V-02 手順3(b) / NFR-03）", () => {
    const original = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo existing-dummy" }] }],
      },
      model: "opus",
    };
    writeSettings(JSON.stringify(original, null, 2));
    const result = mergeHooks(dir, 41321);
    expect(result.ok).toBe(true);
    const settings = readSettings();
    // 既存キーが原文のまま
    expect(settings.permissions).toEqual(original.permissions);
    expect(settings.model).toBe("opus");
    const hooks = settings.hooks as Record<string, unknown[]>;
    // 既存ダミー hook が先頭のまま（順序含め変更しない）
    expect(hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Notification).toHaveLength(1);
  });

  it("バックアップ settings.json.terminal-app.bak を作成する（design.md 4.2 手順3）", () => {
    const raw = JSON.stringify({ hooks: {} }, null, 2);
    writeSettings(raw);
    mergeHooks(dir, 41321);
    expect(fs.existsSync(backupPathFor(dir))).toBe(true);
    expect(fs.readFileSync(backupPathFor(dir), "utf8")).toBe(raw); // 変更前の原文
  });

  it("不正 JSON は一切書き込まず中断する（V-02 手順3(c) / design.md 4.2 手順2）", () => {
    const broken = "{ this is not json";
    writeSettings(broken);
    const result = mergeHooks(dir, 41321);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // ファイルはバイト単位で無変更・バックアップも作らない
    expect(fs.readFileSync(settingsPathFor(dir), "utf8")).toBe(broken);
    expect(fs.existsSync(backupPathFor(dir))).toBe(false);
  });

  it("再登録しても重複追記しない（冪等性。V-02 手順4）", () => {
    mergeHooks(dir, 41321);
    const after1 = fs.readFileSync(settingsPathFor(dir), "utf8");
    const result2 = mergeHooks(dir, 41321);
    expect(result2.ok).toBe(true);
    expect(result2.changed).toBe(false); // 2 回目は書き込み自体が発生しない
    expect(fs.readFileSync(settingsPathFor(dir), "utf8")).toBe(after1);
  });

  it("ポート変更時は自アプリ分のみ現在のコマンドへ置き換える（design.md 3.3）", () => {
    writeSettings(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] },
      })
    );
    mergeHooks(dir, 41321);
    mergeHooks(dir, 50000);
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(2); // 既存 1 + 自アプリ 1（重複しない）
    expect(hooks.Stop[0].hooks[0].command).toBe("echo keep-me");
    expect(hooks.Stop[1].hooks[0].command).toContain(":50000/");
    expect(hooks.Notification).toHaveLength(1);
    expect(hooks.Notification[0].hooks[0].command).toContain(":50000/");
  });
});

describe("removeHooks（V-03 / AC-03: 登録解除で自アプリ分のみ除去）", () => {
  it("自アプリのエントリのみ除去し、他は登録前と完全一致する（verification.md 3.5）", () => {
    const original = {
      permissions: { deny: ["Read(.env)"] },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo existing-dummy" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "echo guard" }] }],
      },
    };
    writeSettings(JSON.stringify(original, null, 2));
    mergeHooks(dir, 41321);
    const result = removeHooks(dir);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    // 登録前と deep equal（diff 相当の確認）
    expect(readSettings()).toEqual(original);
  });

  it("空になった配列・hooks キーは削除して痕跡を残さない（design.md 4.2 除去手順2）", () => {
    mergeHooks(dir, 41321); // {} から追記 → 自アプリ分のみの状態
    const result = removeHooks(dir);
    expect(result.ok).toBe(true);
    const settings = readSettings();
    expect(settings).not.toHaveProperty("hooks");
  });

  it("settings.json が無い場合は何もしないで成功する", () => {
    const result = removeHooks(dir);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("不正 JSON は中断して手動対応を促す（書き込まない）", () => {
    const broken = "{ broken json !";
    writeSettings(broken);
    const result = removeHooks(dir);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(settingsPathFor(dir), "utf8")).toBe(broken);
  });

  it("マーカーなし（他者の hooks のみ）の場合は変更しない", () => {
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } };
    writeSettings(JSON.stringify(original, null, 2));
    const result = removeHooks(dir);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(readSettings()).toEqual(original);
  });
});
