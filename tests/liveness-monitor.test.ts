/**
 * 260712_2: 切断判定（findDisconnected）の境界値テスト。
 *
 * 判定規則（認識合わせ 2026-07-12: transcript 監視＋ウィンドウ消失の併用）:
 * - 無更新 >= TRANSCRIPT_STALE_MS かつ ウィンドウ消失 → 切断
 * - 無更新 >= TRANSCRIPT_STALE_HARD_MS → ウィンドウの有無によらず切断
 * - transcript 不明・mtime 取得不可・ウィンドウ判定不能（null）は安全側（切断にしない）
 */
import { describe, expect, it } from "vitest";
import {
  findDisconnected,
  TRANSCRIPT_STALE_HARD_MS,
  TRANSCRIPT_STALE_MS,
  type SweepDeps,
  type SweepTarget,
} from "../src/main/liveness-monitor";

const NOW = 10_000_000_000;

function target(overrides: Partial<SweepTarget> = {}): SweepTarget {
  return { sessionId: "s1", projectId: "p1", transcriptPath: "C:\\t\\s1.jsonl", ...overrides };
}

function deps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    now: () => NOW,
    mtimeMs: () => NOW, // 既定: たった今更新された（生存）
    windowPresent: () => true,
    ...overrides,
  };
}

function ageOf(ms: number): (path: string) => number {
  return () => NOW - ms;
}

describe("findDisconnected の境界値", () => {
  it("無更新が STALE 未満なら切断しない（ウィンドウが消えていても）", () => {
    const d = deps({ mtimeMs: ageOf(TRANSCRIPT_STALE_MS - 1), windowPresent: () => false });
    expect(findDisconnected([target()], d)).toEqual([]);
  });

  it("無更新がちょうど STALE ＋ ウィンドウ消失 → 切断（境界は含む）", () => {
    const d = deps({ mtimeMs: ageOf(TRANSCRIPT_STALE_MS), windowPresent: () => false });
    expect(findDisconnected([target()], d).map((t) => t.sessionId)).toEqual(["s1"]);
  });

  it("無更新 >= STALE でもウィンドウが存在すれば切断しない（HARD 未満）", () => {
    const d = deps({ mtimeMs: ageOf(TRANSCRIPT_STALE_HARD_MS - 1), windowPresent: () => true });
    expect(findDisconnected([target()], d)).toEqual([]);
  });

  it("無更新 >= STALE でウィンドウ判定不能（null）なら切断しない（安全側）", () => {
    const d = deps({ mtimeMs: ageOf(TRANSCRIPT_STALE_MS), windowPresent: () => null });
    expect(findDisconnected([target()], d)).toEqual([]);
  });

  it("無更新がちょうど HARD → ウィンドウが残っていても切断（境界は含む）", () => {
    const d = deps({ mtimeMs: ageOf(TRANSCRIPT_STALE_HARD_MS), windowPresent: () => true });
    expect(findDisconnected([target()], d).map((t) => t.sessionId)).toEqual(["s1"]);
  });

  it("transcript パス不明のセッションは判定しない（安全側）", () => {
    const d = deps({ mtimeMs: ageOf(TRANSCRIPT_STALE_HARD_MS + 1) });
    expect(findDisconnected([target({ transcriptPath: undefined })], d)).toEqual([]);
  });

  it("mtime 取得不可（stat 失敗）は判定しない（安全側）", () => {
    const d = deps({ mtimeMs: () => null, windowPresent: () => false });
    expect(findDisconnected([target()], d)).toEqual([]);
  });

  it("複数対象の混在: 切断条件を満たすものだけ返す", () => {
    const t1 = target({ sessionId: "alive", transcriptPath: "C:\\t\\alive.jsonl" });
    const t2 = target({ sessionId: "dead-window", transcriptPath: "C:\\t\\dead1.jsonl" });
    const t3 = target({ sessionId: "dead-hard", transcriptPath: "C:\\t\\dead2.jsonl" });
    const d = deps({
      mtimeMs: (p) => {
        if (p.includes("alive")) return NOW - 1_000;
        if (p.includes("dead1")) return NOW - TRANSCRIPT_STALE_MS - 1;
        return NOW - TRANSCRIPT_STALE_HARD_MS - 1;
      },
      windowPresent: () => false,
    });
    expect(findDisconnected([t1, t2, t3], d).map((t) => t.sessionId)).toEqual(["dead-window", "dead-hard"]);
  });

  it("ウィンドウ確認は STALE 帯（STALE <= age < HARD）のときだけ行う（HARD 超・生存では呼ばない）", () => {
    let calls = 0;
    const d = deps({
      mtimeMs: (p) => (p.includes("fresh") ? NOW : NOW - TRANSCRIPT_STALE_HARD_MS),
      windowPresent: () => {
        calls += 1;
        return true;
      },
    });
    findDisconnected(
      [
        target({ sessionId: "f", transcriptPath: "C:\\t\\fresh.jsonl" }),
        target({ sessionId: "h", transcriptPath: "C:\\t\\hard.jsonl" }),
      ],
      d
    );
    expect(calls).toBe(0); // 生存（fresh）と HARD 超（hard）ではウィンドウ列挙のコストを掛けない
  });
});
