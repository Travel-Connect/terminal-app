/**
 * 260712_4: transcript 終端分類（classifyTurnEnd）と scanLiveSessions の turnEnd 付与のテスト。
 *
 * 背景バグ: 割り込み（Esc）では Stop hook が発火せず「実行中」から抜ける経路がない。
 * さらに再接続（reviveSession）が終了済みセッションまで無条件に「実行中」で復元していた。
 * 終端分類は 2026-07-12 の実 transcript 実測形状に基づく:
 * - 正常完了: ... assistant(text) → system{stop_hook_summary} → system{turn_duration} [→ system{local_command} 等]
 * - 割り込み: ... user(text="[Request interrupted by user for tool use]")
 * - 実行中:   ... user(tool_result) / assistant(...) が終端側
 * - 末尾には permission-mode / mode / ai-title / last-prompt / attachment / queue-operation 等の
 *   メタレコードが混ざるため、判定は user / assistant / system{stop_hook_summary,turn_duration} のみで行い
 *   他はスキップする。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTurnEnd, scanLiveSessions, transcriptDirFor } from "../src/main/session-scan";

const PROJECT = "C:\\dev\\terminal-app";

// ---- classifyTurnEnd（レコード配列は「新しい順」= tailRecords の返却順） ----

const stopHookSummary = { type: "system", subtype: "stop_hook_summary" };
const turnDuration = { type: "system", subtype: "turn_duration" };
const localCommand = { type: "system", subtype: "local_command" };
const assistantText = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "できました" }] } };
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } };
const userPrompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const interrupted = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
};

describe("classifyTurnEnd（終端分類。入力は新しい順）", () => {
  it("stop_hook_summary / turn_duration が終端側にあれば concluded", () => {
    expect(classifyTurnEnd([turnDuration, stopHookSummary, assistantText])).toBe("concluded");
    expect(classifyTurnEnd([stopHookSummary, assistantText])).toBe("concluded");
  });

  it("完了後の local_command・メタレコードはスキップして concluded（実測: 完了後に /コマンド実行）", () => {
    expect(classifyTurnEnd([localCommand, localCommand, turnDuration, stopHookSummary, assistantText])).toBe("concluded");
    expect(
      classifyTurnEnd([
        { type: "permission-mode" },
        { type: "mode" },
        { type: "ai-title" },
        { type: "last-prompt" },
        turnDuration,
        stopHookSummary,
      ])
    ).toBe("concluded");
  });

  it("割り込みマーカー（[Request interrupted…]）は concluded（Stop は発火しないがターンは終わっている）", () => {
    expect(classifyTurnEnd([interrupted, toolResult, assistantText])).toBe("concluded");
  });

  it("tool_result が終端 = ターン進行中 → open（応答生成中は transcript がこの形で止まる）", () => {
    expect(classifyTurnEnd([{ type: "attachment" }, toolResult, assistantText])).toBe("open");
  });

  it("assistant が終端 = ターン進行中（ツール実行直前・生成直後）→ open", () => {
    expect(classifyTurnEnd([assistantText, toolResult])).toBe("open");
  });

  it("通常のユーザープロンプトが終端 = ターン開始直後 → open", () => {
    expect(classifyTurnEnd([userPrompt("続きをやって"), turnDuration, stopHookSummary])).toBe("open");
  });

  it("判定材料が無ければ unknown（安全側 = 完了扱いしない）", () => {
    expect(classifyTurnEnd([])).toBe("unknown");
    expect(classifyTurnEnd([{ type: "queue-operation" }, { type: "summary" }])).toBe("unknown");
  });
});

// ---- scanLiveSessions が turnEnd を付与する ----

let home: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ta-turnend-home-"));
  dir = transcriptDirFor(PROJECT, home);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeTranscript(name: string, records: Array<Record<string, unknown>>, ageMs: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

const cwdUser = (text: string): Record<string, unknown> => ({
  type: "user",
  message: { role: "user", content: text },
  cwd: PROJECT,
  sessionId: "x",
});

describe("scanLiveSessions の turnEnd 付与", () => {
  it("完了形状の transcript は turnEnd=concluded で返る", () => {
    writeTranscript("s-done.jsonl", [cwdUser("お願い"), assistantText, stopHookSummary, turnDuration], 30_000);
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].turnEnd).toBe("concluded");
  });

  it("実行中形状の transcript は turnEnd=open で返る", () => {
    writeTranscript("s-open.jsonl", [cwdUser("お願い"), assistantText, toolResult], 30_000);
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].turnEnd).toBe("open");
  });
});
