/**
 * 260922_8 追補: サブエージェントが作業中の実行中セッションを終了検知から外す窓（SUBAGENT_ACTIVE_WINDOW_MS）。
 *
 * 背景（2026-09-22 06:45 実測）: 外さないと掃引のたびに
 * 「終了検知で完了へ降格 → サブエージェント待ちで実行中へ復帰」を繰り返し、Jev も毎回呼ばれていた。
 * 判定式そのものは呼び出し側（index.sweepLiveness）にあるため、ここでは窓の値と境界の意味を固定する。
 */
import { describe, expect, it } from "vitest";
import { SUBAGENT_ACTIVE_WINDOW_MS, SUBAGENT_RESUME_MARGIN_MS, findConcluded } from "../src/main/liveness-monitor";

const NOW = 2_000_000_000;
const active = (subMtime: number): boolean => subMtime > NOW - SUBAGENT_ACTIVE_WINDOW_MS;

describe("SUBAGENT_ACTIVE_WINDOW_MS", () => {
  it("復帰の余裕より十分長い（往復を止めるための窓）", () => {
    expect(SUBAGENT_ACTIVE_WINDOW_MS).toBeGreaterThan(SUBAGENT_RESUME_MARGIN_MS);
  });

  it("窓の内側の更新は「作業中」、外側は「作業中でない」", () => {
    expect(active(NOW - SUBAGENT_ACTIVE_WINDOW_MS + 1)).toBe(true);
    expect(active(NOW)).toBe(true);
    expect(active(NOW - SUBAGENT_ACTIVE_WINDOW_MS)).toBe(false);
    expect(active(NOW - SUBAGENT_ACTIVE_WINDOW_MS - 60_000)).toBe(false);
  });
});

describe("findConcluded に渡す対象の絞り込み", () => {
  const deps = { now: () => NOW, mtimeMs: () => NOW - 60_000, turnEnd: () => "concluded" as const };
  const targets = [
    { sessionId: "bg", projectId: "p1", transcriptPath: "C:/t/bg.jsonl" },
    { sessionId: "plain", projectId: "p1", transcriptPath: "C:/t/plain.jsonl" },
  ];

  it("サブエージェント作業中を外すと、そのセッションは完了へ降格しない", () => {
    const bgActive = new Set(["bg"]);
    const hits = findConcluded(targets.filter((t) => !bgActive.has(t.sessionId)), deps);
    expect(hits.map((t) => t.sessionId)).toEqual(["plain"]);
  });

  it("外さなければ両方が完了へ降格する（従来の挙動 = 往復の原因）", () => {
    expect(findConcluded(targets, deps).map((t) => t.sessionId)).toEqual(["bg", "plain"]);
  });
});
