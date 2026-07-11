/**
 * 260712_3 案A: statusLine 転送設定のマージ・除去のテスト。
 * statusLine は hooks と違い単一値のため「ユーザー設定があれば絶対に触らない」が最重要仕様。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStatusLineCommand,
  mergeStatusLine,
  removeStatusLine,
  settingsPathFor,
  statusLineIsOurs,
} from "../src/main/hooks-manager";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-sl-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf8")) as Record<string, unknown>;
}

describe("statusLineIsOurs", () => {
  it("転送 URL パスを含む command のみ自アプリ分と判定する", () => {
    expect(statusLineIsOurs({ type: "command", command: buildStatusLineCommand(41321) })).toBe(true);
    expect(statusLineIsOurs({ type: "command", command: "~/.claude/statusline.sh" })).toBe(false);
    expect(statusLineIsOurs(undefined)).toBe(false);
    expect(statusLineIsOurs(null)).toBe(false);
  });
});

describe("mergeStatusLine", () => {
  it("statusLine が無ければ転送コマンドを設定する", () => {
    const result = mergeStatusLine(dir, 41321);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const sl = readSettings().statusLine as { type: string; command: string };
    expect(sl.type).toBe("command");
    expect(sl.command).toContain("/terminal-app/statusline");
  });

  it("ユーザー自身の statusLine があれば一切触らない（skipped）", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const original = { statusLine: { type: "command", command: "~/.claude/my-statusline.sh", padding: 2 } };
    fs.writeFileSync(settingsPathFor(dir), JSON.stringify(original));
    const result = mergeStatusLine(dir, 41321);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(readSettings()).toEqual(original); // 1 バイトも変えない
  });

  it("自アプリ分が同一ポートで既にあれば no-op（冪等）", () => {
    mergeStatusLine(dir, 41321);
    const result = mergeStatusLine(dir, 41321);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.skipped).toBeUndefined();
  });

  it("自アプリ分が旧ポートなら現在のポートへ置換する（ポート変更の追従）", () => {
    mergeStatusLine(dir, 41321);
    const result = mergeStatusLine(dir, 50000);
    expect(result.changed).toBe(true);
    const sl = readSettings().statusLine as { command: string };
    expect(sl.command).toContain(":50000/terminal-app/statusline");
  });

  it("hooks 等の他キーは保存時も維持される", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] }, permissions: { allow: ["Bash(ls)"] } };
    fs.writeFileSync(settingsPathFor(dir), JSON.stringify(original));
    mergeStatusLine(dir, 41321);
    const after = readSettings();
    expect(after.hooks).toEqual(original.hooks);
    expect(after.permissions).toEqual(original.permissions);
  });
});

describe("removeStatusLine", () => {
  it("自アプリ分のみ削除する", () => {
    mergeStatusLine(dir, 41321);
    const result = removeStatusLine(dir);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(readSettings().statusLine).toBeUndefined();
  });

  it("ユーザー自身の statusLine は削除しない", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const original = { statusLine: { type: "command", command: "~/.claude/my-statusline.sh" } };
    fs.writeFileSync(settingsPathFor(dir), JSON.stringify(original));
    const result = removeStatusLine(dir);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(readSettings()).toEqual(original);
  });

  it("settings.json が無ければ no-op", () => {
    const result = removeStatusLine(dir);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });
});
