/**
 * hooks-manager の OPEN-04 案 A 採用（2026-07-11）に伴う追加テスト。
 * 要件対応:
 * - design.md 4.1 / 4.5: 追記断片が Stop / Notification / UserPromptSubmit の 3 イベントであること
 * - design.md 4.2「起動時追補」: 旧 2 イベント構成の settings.json に不足イベント
 *   （UserPromptSubmit）だけが append され、再登録なしで改善が行き渡ること（criteria: 追補/アップグレード）
 * - design.md 4.1 マーカー厳格化: 判定を command の URL パス `/terminal-app/event` 一致とし、
 *   ユーザー自身の hook コマンドが 'terminal-app' をパスに含んでも誤除去・誤置換しないこと
 *   （前ループ evaluator 指摘の誤除去ハザード対策）
 * - FL5: バックアップ・アトミック・冪等・他者エントリ非破壊が 3 イベント構成でも維持されること
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupPathFor,
  buildHookCommand,
  entryHasMarker,
  HOOK_EVENTS,
  mergeHooks,
  removeHooks,
  settingsPathFor,
} from "../src/main/hooks-manager";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-hooks-open04-"));
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

/** 旧バージョン（2 イベント構成）が追記した settings.json を再現する */
function oldTwoEventSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const entry = { hooks: [{ type: "command", command: buildHookCommand(41321), timeout: 5 }] };
  return {
    ...extra,
    hooks: {
      Stop: [structuredClone(entry)],
      Notification: [structuredClone(entry)],
    },
  };
}

/** ユーザー自身の hook（command に 'terminal-app' をパスとして含むが、送信 URL ではない） */
const USER_HOOK_WITH_REPO_PATH = {
  matcher: "",
  hooks: [{ type: "command", command: "node C:\\Users\\hppym\\dev\\terminal-app\\scripts\\my-notify.js" }],
};

describe("3 イベント構成のマージ/除去（design.md 4.1 / 4.2、OPEN-04 案 A）", () => {
  it("HOOK_EVENTS が Stop / Notification / UserPromptSubmit の 3 イベントである（design.md 4.1）", () => {
    expect([...HOOK_EVENTS]).toEqual(["Stop", "Notification", "UserPromptSubmit"]);
  });

  it("空の状態から 3 イベントすべてにマーカー付きエントリを追記する（design.md 4.1）", () => {
    const result = mergeHooks(dir, 41321);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }>>;
    for (const evt of ["Stop", "Notification", "UserPromptSubmit"]) {
      expect(hooks[evt]).toHaveLength(1);
      const cmd = hooks[evt][0].hooks[0];
      expect(cmd.type).toBe("command");
      expect(cmd.timeout).toBe(5);
      expect(cmd.command).toContain("http://127.0.0.1:41321/terminal-app/event"); // マーカー = URL パス
    }
  });

  it("3 イベント追記後の除去で自アプリ分がすべて消え、登録前と完全一致する（design.md 4.2 / FL5）", () => {
    const original = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user-own-prompt-hook" }] }],
      },
    };
    writeSettings(JSON.stringify(original, null, 2));
    mergeHooks(dir, 41321);
    const removed = removeHooks(dir);
    expect(removed.ok).toBe(true);
    expect(removed.changed).toBe(true);
    // ユーザー自身の UserPromptSubmit hook・他キーは登録前と deep equal
    expect(readSettings()).toEqual(original);
  });

  it("3 イベント構成でも冪等（2 回目のマージは書き込みなし）", () => {
    mergeHooks(dir, 41321);
    const after1 = fs.readFileSync(settingsPathFor(dir), "utf8");
    const result2 = mergeHooks(dir, 41321);
    expect(result2.ok).toBe(true);
    expect(result2.changed).toBe(false);
    expect(fs.readFileSync(settingsPathFor(dir), "utf8")).toBe(after1);
  });
});

describe("旧 2 イベント設定からの追補（アップグレード。design.md 4.2 起動時追補 / criteria 追補経路）", () => {
  it("不足している UserPromptSubmit のみ append し、既設の Stop / Notification エントリは変更しない", () => {
    const before = oldTwoEventSettings({ permissions: { deny: ["Read(.env)"] }, model: "opus" });
    writeSettings(JSON.stringify(before, null, 2));

    const result = mergeHooks(dir, 41321); // 起動時追補は登録時マージと同一経路（index.ts）
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const after = readSettings();
    const afterHooks = after.hooks as Record<string, unknown[]>;
    const beforeHooks = before.hooks as Record<string, unknown[]>;
    // 既設 2 イベントは 1 バイトも壊れない（deep equal・件数据え置き）
    expect(afterHooks.Stop).toEqual(beforeHooks.Stop);
    expect(afterHooks.Notification).toEqual(beforeHooks.Notification);
    // UserPromptSubmit だけが新規に 1 件追加される
    expect(afterHooks.UserPromptSubmit).toHaveLength(1);
    expect(JSON.stringify(afterHooks.UserPromptSubmit)).toContain("/terminal-app/event");
    // 他キーも無傷
    expect(after.permissions).toEqual(before.permissions);
    expect(after.model).toBe("opus");
    // 追補時もバックアップが作られる（変更前の原文）
    expect(fs.readFileSync(backupPathFor(dir), "utf8")).toBe(JSON.stringify(before, null, 2));
  });

  it("追補は冪等（2 回目は書き込みなし）", () => {
    writeSettings(JSON.stringify(oldTwoEventSettings(), null, 2));
    mergeHooks(dir, 41321);
    const after1 = fs.readFileSync(settingsPathFor(dir), "utf8");
    const result2 = mergeHooks(dir, 41321);
    expect(result2.changed).toBe(false);
    expect(fs.readFileSync(settingsPathFor(dir), "utf8")).toBe(after1);
  });

  it("旧 2 イベント構成に他者エントリが混在していても、他者分は順序含めそのまま維持される", () => {
    const before = oldTwoEventSettings();
    (before.hooks as Record<string, unknown[]>).Stop.unshift({
      matcher: "",
      hooks: [{ type: "command", command: "echo existing-dummy" }],
    });
    writeSettings(JSON.stringify(before, null, 2));
    mergeHooks(dir, 41321);
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop[0].hooks[0].command).toBe("echo existing-dummy"); // 先頭のまま
    expect(hooks.UserPromptSubmit).toHaveLength(1);
  });
});

describe("マーカー厳格化: 'terminal-app' をパスに含む他者 command の非破壊（design.md 4.1 改訂 / FL5）", () => {
  it("entryHasMarker は URL パス /terminal-app/event を含む command のみ自アプリ扱いする", () => {
    expect(entryHasMarker({ hooks: [{ type: "command", command: buildHookCommand(41321) }] })).toBe(true);
    // 'terminal-app' を含むだけの他者 command は自アプリ扱いしない（旧判定からの厳格化）
    expect(entryHasMarker(USER_HOOK_WITH_REPO_PATH)).toBe(false);
    expect(entryHasMarker({ hooks: [{ type: "command", command: "echo terminal-app" }] })).toBe(false);
  });

  it("マージ時: 'terminal-app' をパスに含む他者エントリを置換せず、自アプリ分を append する", () => {
    const original = { hooks: { Stop: [structuredClone(USER_HOOK_WITH_REPO_PATH)] } };
    writeSettings(JSON.stringify(original, null, 2));
    mergeHooks(dir, 41321);
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Stop).toHaveLength(2); // 他者 1 + 自アプリ 1（旧判定なら他者分が置換・消失していた）
    expect(hooks.Stop[0]).toEqual(USER_HOOK_WITH_REPO_PATH);
    expect(hooks.Stop[1].hooks[0].command).toBe(buildHookCommand(41321));
  });

  it("除去時: 'terminal-app' をパスに含む他者エントリは無傷で残り、自アプリ分のみ消える", () => {
    const original = {
      hooks: {
        Stop: [structuredClone(USER_HOOK_WITH_REPO_PATH)],
        UserPromptSubmit: [structuredClone(USER_HOOK_WITH_REPO_PATH)],
      },
    };
    writeSettings(JSON.stringify(original, null, 2));
    mergeHooks(dir, 41321); // 3 イベントへ自アプリ分を追記
    const removed = removeHooks(dir);
    expect(removed.ok).toBe(true);
    expect(removed.changed).toBe(true);
    // 他者エントリ（terminal-app をパスに含む）が 3 イベントすべてで登録前と完全一致
    expect(readSettings()).toEqual(original);
  });
});
