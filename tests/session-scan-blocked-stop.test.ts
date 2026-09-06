/**
 * 260907_1: block された Stop の痕跡と、同期 fork 中の活動証跡。
 *
 * 背景（2026-09-07 実測）:
 * - Stop hook が {"decision":"block"} を返すと Claude Code は続行し、対話 transcript に
 *   system{stop_hook_summary, preventedContinuation:true, stopReason:"<理由>"} を書く（通常の Stop は false）。
 *   従来の classifyTurnEnd は stop_hook_summary を無条件に concluded 扱いしていた → block 直後を「完了」と誤判定する。
 * - 同期 fork（background:false の Skill）の間、本体 <sessionId>.jsonl は更新されず、
 *   <dir>/<sessionId>/subagents/agent-*.jsonl だけが更新される → 本体 mtime だけ見ると「切断」に見える。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityMtimeMs, blockedStopOf, classifyTurnEnd, findBlockedStop } from "../src/main/session-scan";

const REASON = "[Eval-loop iteration 1/4 | RESUME 1/3] The loop is mid-iteration and your response ended. Continue now.";
const blocked = (timestamp?: string, stopReason: string | undefined = REASON): Record<string, unknown> => ({
  type: "system",
  subtype: "stop_hook_summary",
  preventedContinuation: true,
  ...(stopReason !== undefined ? { stopReason } : {}),
  ...(timestamp !== undefined ? { timestamp } : {}),
});
const normalSummary = (timestamp?: string): Record<string, unknown> => ({
  type: "system",
  subtype: "stop_hook_summary",
  preventedContinuation: false,
  stopReason: "",
  ...(timestamp !== undefined ? { timestamp } : {}),
});
const legacySummary = { type: "system", subtype: "stop_hook_summary" }; // 2026-07 時点の実測形状（フィールド無し）
const turnDuration = { type: "system", subtype: "turn_duration" };
const assistantText = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "続けます" }] } };
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } };

describe("classifyTurnEnd と block された Stop（R5。入力は新しい順）", () => {
  it("preventedContinuation=true の stop_hook_summary が終端 → open（Claude はこの直後に続行する）", () => {
    expect(classifyTurnEnd([blocked("2026-09-07T03:00:05.000Z"), assistantText])).toBe("open");
  });

  it("false・フィールド欠落（旧形状）は従来どおり concluded", () => {
    expect(classifyTurnEnd([normalSummary(), assistantText])).toBe("concluded");
    expect(classifyTurnEnd([legacySummary, assistantText])).toBe("concluded");
  });

  it("turn_duration が block の新しい側にあっても open（turn_duration 単独では決めない）", () => {
    expect(classifyTurnEnd([turnDuration, blocked(), assistantText])).toBe("open");
    expect(classifyTurnEnd([{ type: "system", subtype: "away_summary" }, turnDuration, blocked(), assistantText])).toBe("open");
  });

  it("turn_duration 単独（Stop hook 未設定の環境。summary が書かれない）は concluded", () => {
    expect(classifyTurnEnd([turnDuration, assistantText])).toBe("concluded");
    expect(classifyTurnEnd([turnDuration, toolResult])).toBe("concluded");
  });

  it("block の後に続行の記録があれば従来どおりそれで判定する", () => {
    expect(classifyTurnEnd([assistantText, blocked()])).toBe("open");
    expect(classifyTurnEnd([turnDuration, normalSummary(), assistantText, blocked()])).toBe("concluded");
  });
});

describe("findBlockedStop（最新の stop_hook_summary が since 以降の block かどうか）", () => {
  const SINCE = Date.parse("2026-09-07T03:00:00.000Z");

  it("since 以降の block を {at, reason} で返す", () => {
    expect(findBlockedStop([assistantText, blocked("2026-09-07T03:00:05.000Z")], SINCE)).toEqual({ at: SINCE + 5_000, reason: REASON });
  });

  it("since ちょうどは含む・それより古い block は null", () => {
    expect(findBlockedStop([blocked("2026-09-07T03:00:00.000Z")], SINCE)).not.toBe(null);
    expect(findBlockedStop([blocked("2026-09-07T02:59:59.999Z")], SINCE)).toBe(null);
  });

  it("最新の summary が非 block なら、それより古い block があっても null（前のターンの痕跡を拾わない）", () => {
    expect(findBlockedStop([normalSummary("2026-09-07T03:00:10.000Z"), assistantText, blocked("2026-09-07T03:00:05.000Z")], SINCE)).toBe(null);
    expect(findBlockedStop([legacySummary, blocked("2026-09-07T03:00:05.000Z")], SINCE)).toBe(null);
  });

  it("timestamp が無い・壊れている block は null（安全側）", () => {
    expect(findBlockedStop([blocked(undefined)], SINCE)).toBe(null);
    expect(findBlockedStop([blocked("not a date")], SINCE)).toBe(null);
  });

  it("stopReason が無ければ reason は空文字", () => {
    const noReason = { type: "system", subtype: "stop_hook_summary", preventedContinuation: true, timestamp: "2026-09-07T03:00:05.000Z" };
    expect(findBlockedStop([noReason], SINCE)).toEqual({ at: SINCE + 5_000, reason: "" });
  });

  it("summary が 1 つも無ければ null。メタレコードや user/assistant は読み飛ばす", () => {
    expect(findBlockedStop([], SINCE)).toBe(null);
    expect(findBlockedStop([{ type: "ai-title" }, assistantText, toolResult, turnDuration], SINCE)).toBe(null);
    expect(findBlockedStop([{ type: "ai-title" }, assistantText, toolResult, blocked("2026-09-07T03:00:05.000Z")], SINCE)).not.toBe(null);
  });
});

describe("blockedStopOf / activityMtimeMs（ファイル）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-blocked-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeJsonl(p: string, records: Array<Record<string, unknown>>): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  function touch(p: string, epochMs: number): void {
    fs.utimesSync(p, new Date(epochMs), new Date(epochMs));
  }

  it("blockedStopOf: transcript 末尾の block を検出する／読めないファイルは null", () => {
    const p = path.join(dir, "s1.jsonl");
    writeJsonl(p, [toolResult, assistantText, blocked("2026-09-07T03:00:05.000Z")]);
    const since = Date.parse("2026-09-07T03:00:00.000Z");
    expect(blockedStopOf(p, since)).toEqual({ at: since + 5_000, reason: REASON });
    writeJsonl(p, [toolResult, assistantText, blocked("2026-09-07T03:00:05.000Z"), assistantText, normalSummary("2026-09-07T03:01:00.000Z"), turnDuration]);
    expect(blockedStopOf(p, since)).toBe(null);
    expect(blockedStopOf(path.join(dir, "missing.jsonl"), since)).toBe(null);
  });

  it("activityMtimeMs: subagent 記録が無ければ本体の mtime", () => {
    const main = path.join(dir, "abc.jsonl");
    writeJsonl(main, [assistantText]);
    touch(main, 1_700_000_000_000);
    expect(activityMtimeMs(main)).toBe(1_700_000_000_000);
  });

  it("activityMtimeMs: subagents 配下に新しい記録があればその mtime（同期 fork 中の活動）", () => {
    const main = path.join(dir, "abc.jsonl");
    writeJsonl(main, [assistantText]);
    touch(main, 1_700_000_000_000);
    const agentA = path.join(dir, "abc", "subagents", "agent-a1.jsonl");
    const agentB = path.join(dir, "abc", "subagents", "agent-b2.jsonl");
    writeJsonl(agentA, [assistantText]);
    writeJsonl(agentB, [assistantText]);
    touch(agentA, 1_700_000_050_000);
    touch(agentB, 1_700_000_090_000);
    // .jsonl 以外（meta.json）はもっと新しくても無視
    const meta = path.join(dir, "abc", "subagents", "agent-b2.meta.json");
    fs.writeFileSync(meta, "{}", "utf8");
    touch(meta, 1_700_000_999_000);
    expect(activityMtimeMs(main)).toBe(1_700_000_090_000);
  });

  it("activityMtimeMs: 本体が古くなくても subagent が古ければ本体の mtime（最大値）", () => {
    const main = path.join(dir, "abc.jsonl");
    writeJsonl(main, [assistantText]);
    touch(main, 1_700_000_100_000);
    const agentA = path.join(dir, "abc", "subagents", "agent-a1.jsonl");
    writeJsonl(agentA, [assistantText]);
    touch(agentA, 1_700_000_050_000);
    expect(activityMtimeMs(main)).toBe(1_700_000_100_000);
  });

  it("activityMtimeMs: 本体が無ければ null（subagent 記録だけでは判定しない）", () => {
    const agentA = path.join(dir, "abc", "subagents", "agent-a1.jsonl");
    writeJsonl(agentA, [assistantText]);
    expect(activityMtimeMs(path.join(dir, "abc.jsonl"))).toBe(null);
  });
});
