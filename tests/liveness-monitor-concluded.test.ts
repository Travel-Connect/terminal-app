/**
 * 260712_4: 終了検知（findConcluded）のテスト。
 *
 * 背景バグ: 割り込み（Esc）では Stop hook が発火しない（2026-07-11 実測:
 * transcript に stop_hook_summary が無く「[Request interrupted by user for tool use]」のみ）。
 * その場合「実行中」から抜ける経路が無く、ウィンドウが生きている限り切断検知（HARD 15 分）まで
 * スピナーが回り続けた。掃引で transcript 終端がターン完了を示すものを「完了」へ降格する。
 *
 * 誤検知対策: ターン境界の直後（Stop が配送中）と競合しないよう、
 * transcript 無更新が CONCLUDED_MIN_AGE_MS 以上のものだけ対象にする。
 */
import { describe, expect, it } from "vitest";
import { CONCLUDED_MIN_AGE_MS, findConcluded, type SweepTarget } from "../src/main/liveness-monitor";

const NOW = 10_000_000;

function target(sessionId: string, transcriptPath?: string): SweepTarget {
  return { sessionId, projectId: "p1", transcriptPath };
}

function deps(overrides: {
  mtimeMs?: (p: string) => number | null;
  turnEnd?: (p: string) => "concluded" | "open" | "unknown";
}) {
  return {
    now: () => NOW,
    mtimeMs: overrides.mtimeMs ?? (() => NOW - CONCLUDED_MIN_AGE_MS - 1_000),
    turnEnd: overrides.turnEnd ?? (() => "concluded" as const),
  };
}

describe("findConcluded（Stop 欠落の終了検知）", () => {
  it("無更新が閾値以上 かつ 終端が concluded → 検知する", () => {
    const hits = findConcluded([target("s1", "C:\\t\\s1.jsonl")], deps({}));
    expect(hits.map((t) => t.sessionId)).toEqual(["s1"]);
  });

  it("無更新が閾値未満は検知しない（ターン境界・Stop 配送中との競合回避）", () => {
    const hits = findConcluded(
      [target("s1", "C:\\t\\s1.jsonl")],
      deps({ mtimeMs: () => NOW - CONCLUDED_MIN_AGE_MS + 1 })
    );
    expect(hits).toEqual([]);
  });

  it("終端が open / unknown は検知しない（進行中・判定不能を完了扱いしない）", () => {
    expect(findConcluded([target("s1", "C:\\t\\s1.jsonl")], deps({ turnEnd: () => "open" }))).toEqual([]);
    expect(findConcluded([target("s1", "C:\\t\\s1.jsonl")], deps({ turnEnd: () => "unknown" }))).toEqual([]);
  });

  it("transcriptPath 不明・mtime 取得不可は安全側 = 検知しない", () => {
    expect(findConcluded([target("s1", undefined)], deps({}))).toEqual([]);
    expect(findConcluded([target("s1", "C:\\t\\s1.jsonl")], deps({ mtimeMs: () => null }))).toEqual([]);
  });

  it("複数対象から concluded のものだけを返す", () => {
    const hits = findConcluded(
      [target("s-done", "C:\\t\\done.jsonl"), target("s-live", "C:\\t\\live.jsonl")],
      deps({ turnEnd: (p) => (p.includes("done") ? "concluded" : "open") })
    );
    expect(hits.map((t) => t.sessionId)).toEqual(["s-done"]);
  });
});
