/**
 * 260922_2: Jev 判定の材料を transcript から取り出す関数のテスト（session-scan.ts）。
 * - lastAssistantTextFrom: 最後の assistant 返答（同じ message.id の text を古い順に連結。thinking は含めない）
 * - lastToolUseFrom: 最後の tool_use（名前 + JSON 化した input。長い引数は切り詰め）
 * - recentStepsFrom: 直近の手順を古い順に（tool_use / tool_result(is_error) / text。メタレコードは除外）
 * レコードの形状は 2026-09-22 の実 transcript（本セッション）で確認したもの。
 * ファイル版（*Of）は一時 JSONL で 1 回だけ通す。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastAssistantTextFrom, lastAssistantTextOf, lastToolUseFrom, lastToolUseOf, recentStepsFrom, recentStepsOf } from "../src/main/session-scan";

const assistant = (id: string, content: unknown[]): Record<string, unknown> => ({ type: "assistant", message: { id, role: "assistant", content } });
const userText = (text: string): Record<string, unknown> => ({ type: "user", message: { role: "user", content: text } });
const toolResult = (text: string, isError = false): Record<string, unknown> => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text, is_error: isError }] },
});
const system = (subtype: string): Record<string, unknown> => ({ type: "system", subtype });

// 「古い順」に書いて、関数へは「新しい順」（tailRecords の返却順）で渡す
const newestFirst = (oldestFirst: Record<string, unknown>[]): Record<string, unknown>[] => [...oldestFirst].reverse();

describe("lastAssistantTextFrom", () => {
  it("最後の返答の text を返す。同じ message.id に分かれた text は古い順に連結し、thinking は含めない", () => {
    const records = newestFirst([
      userText("依頼"),
      assistant("m1", [{ type: "thinking", thinking: "…" }]),
      assistant("m1", [{ type: "text", text: "前半。" }]),
      assistant("m1", [{ type: "text", text: "どちらにしますか？" }]),
      system("stop_hook_summary"),
      system("turn_duration"),
    ]);
    expect(lastAssistantTextFrom(records)).toBe("前半。\nどちらにしますか？");
  });

  it("別の message.id の返答は混ぜない。assistant が無ければ undefined", () => {
    const records = newestFirst([assistant("m0", [{ type: "text", text: "古い返答" }]), toolResult("ok"), assistant("m1", [{ type: "text", text: "新しい返答" }])]);
    expect(lastAssistantTextFrom(records)).toBe("新しい返答");
    expect(lastAssistantTextFrom(newestFirst([userText("依頼")]))).toBeUndefined();
    expect(lastAssistantTextFrom(newestFirst([assistant("m1", [{ type: "tool_use", name: "Bash", input: {} }])]))).toBeUndefined();
  });
});

describe("lastToolUseFrom", () => {
  it("最後の tool_use の名前と JSON 化した input を返す。長い input は切り詰める", () => {
    const records = newestFirst([
      assistant("m1", [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }]),
      toolResult("..."),
      assistant("m2", [{ type: "text", text: "実行します" }, { type: "tool_use", name: "Bash", input: { command: "rm -rf dist" } }]),
    ]);
    expect(lastToolUseFrom(records)).toEqual({ name: "Bash", input: '{"command":"rm -rf dist"}' });
    const long = lastToolUseFrom(newestFirst([assistant("m3", [{ type: "tool_use", name: "Write", input: { content: "x".repeat(100) } }])]), 20);
    expect(long?.name).toBe("Write");
    expect(long?.input.length).toBe(21); // 20 文字 + …
  });

  it("tool_use が無ければ undefined", () => {
    expect(lastToolUseFrom(newestFirst([assistant("m1", [{ type: "text", text: "done" }]), userText("x")]))).toBeUndefined();
  });
});

describe("recentStepsFrom", () => {
  it("tool_use / tool_result / text を古い順に返し、is_error を保持し、メタ・system は除外する", () => {
    const records = newestFirst([
      userText("依頼"),
      assistant("m1", [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }]),
      toolResult("FAIL 1 test", true),
      { type: "user", isMeta: true, message: { role: "user", content: [{ type: "tool_result", content: "meta" }] } },
      system("local_command"),
      assistant("m2", [{ type: "text", text: "もう一度 試します" }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }]),
      toolResult("FAIL 1 test", true),
    ]);
    const steps = recentStepsFrom(records);
    expect(steps.map((s) => s.kind)).toEqual(["tool_use", "tool_result", "text", "tool_use", "tool_result"]);
    expect(steps[0].text).toBe('Bash {"command":"npm test"}');
    expect(steps[1]).toEqual({ kind: "tool_result", text: "FAIL 1 test", error: true });
    expect(steps[2].text).toBe("もう一度 試します");
  });

  it("maxSteps で新しい側から数えて打ち切り、抜粋は excerptChars で切り詰める", () => {
    const records = newestFirst([
      assistant("m1", [{ type: "tool_use", name: "A", input: {} }]),
      toolResult("r1"),
      assistant("m2", [{ type: "tool_use", name: "B", input: {} }]),
      toolResult("y".repeat(50)),
    ]);
    const steps = recentStepsFrom(records, 2, 10);
    expect(steps.map((s) => s.kind)).toEqual(["tool_use", "tool_result"]);
    expect(steps[0].text).toBe("B {}");
    expect(steps[1].text).toBe(`${"y".repeat(10)}…`);
  });

  it("tool_result の content がブロック配列でも text を連結する", () => {
    const rec = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] } };
    expect(recentStepsFrom([rec])).toEqual([{ kind: "tool_result", text: "a b", error: false }]);
  });
});

describe("ファイル版（*Of）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-app-jev-scan-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("JSONL の末尾から読み、壊れた行は飛ばす。無いファイルは空扱い", () => {
    const file = path.join(dir, "s.jsonl");
    const lines = [
      JSON.stringify(userText("依頼")),
      JSON.stringify(assistant("m1", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }])),
      "{broken",
      JSON.stringify(toolResult("a b")),
      JSON.stringify(assistant("m2", [{ type: "text", text: "終わりました。次はどうしますか？" }])),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    expect(lastAssistantTextOf(file)).toBe("終わりました。次はどうしますか？");
    expect(lastToolUseOf(file)).toEqual({ name: "Bash", input: '{"command":"ls"}' });
    expect(recentStepsOf(file).map((s) => s.kind)).toEqual(["tool_use", "tool_result", "text"]);
    const missing = path.join(dir, "none.jsonl");
    expect(lastAssistantTextOf(missing)).toBeUndefined();
    expect(lastToolUseOf(missing)).toBeUndefined();
    expect(recentStepsOf(missing)).toEqual([]);
  });
});
