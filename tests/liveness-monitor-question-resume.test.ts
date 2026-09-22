/**
 * 260922_4: 返答待ち（Jev 判定）→ 実行中の復帰検知 findResumedFromQuestion のテスト。
 *
 * 背景の実ログ（2026-09-22 01:23:38 Stop → 01:23:42 返答待ち → 01:24:36 復帰）: 返答待ちは実質「完了」なのに
 * 確認待ち用の規則（transcript の mtime のみ）しか効かず、作業が進んでいるタイルが取り残された。
 * 根拠は完了・切断と同じ 3 系統（登録簿 busy / block 痕跡 / ターン再開）。
 */
import { describe, expect, it } from "vitest";
import { QUESTION_RESUME_MIN_AGE_MS, findResumedFromQuestion, type QuestionResumeDeps, type QuestionTarget } from "../src/main/liveness-monitor";

const NOW = 1_000_000_000;
const target = (over: Partial<QuestionTarget> = {}): QuestionTarget => ({
  sessionId: "s1",
  projectId: "p1",
  transcriptPath: "C:/t/s1.jsonl",
  stoppedAt: NOW - 60_000,
  pendingSince: NOW - 56_000,
  ...over,
});

const deps = (over: Partial<QuestionResumeDeps> = {}): QuestionResumeDeps => ({
  now: () => NOW,
  registryStatus: () => "idle",
  turnEnd: () => "concluded",
  blockedStop: () => null,
  ...over,
});

describe("findResumedFromQuestion", () => {
  it("ターンが再開している（終端 open）なら復帰する = ユーザーが返答した／Claude が続行した", () => {
    const hits = findResumedFromQuestion([target()], deps({ turnEnd: () => "open" }));
    expect(hits.map((h) => h.reason)).toEqual(["turn-open"]);
  });

  it("登録簿が busy で終端が concluded でなければ復帰する（busy の残骸は concluded で弾く）", () => {
    expect(findResumedFromQuestion([target()], deps({ registryStatus: () => "busy", turnEnd: () => "unknown" }))[0].reason).toBe("registry");
    expect(findResumedFromQuestion([target()], deps({ registryStatus: () => "busy", turnEnd: () => "concluded" }))).toEqual([]);
  });

  it("block 痕跡（Stop hook が続行を指示）があれば復帰し、理由ラベルを返す。探索起点は Stop の時刻", () => {
    let since = 0;
    const hits = findResumedFromQuestion(
      [target()],
      deps({
        blockedStop: (_p, s) => {
          since = s;
          return { at: NOW - 55_000, reason: "Eval-loop iteration 1/4" };
        },
      })
    );
    expect(hits[0].reason).toBe("blocked-stop");
    expect(hits[0].blockReason).toBe("Eval-loop iteration 1/4");
    expect(since).toBeLessThan(target().stoppedAt); // 痕跡が Stop と同時刻でも拾えるよう余裕を引く
  });

  it("後片付けの書き込みだけ（終端 concluded・登録簿 idle・痕跡なし）では復帰しない", () => {
    expect(findResumedFromQuestion([target()], deps())).toEqual([]);
  });

  it("返答待ちにした直後（猶予未満）は判定しない", () => {
    const fresh = target({ pendingSince: NOW - QUESTION_RESUME_MIN_AGE_MS + 1 });
    expect(findResumedFromQuestion([fresh], deps({ turnEnd: () => "open" }))).toEqual([]);
    const aged = target({ pendingSince: NOW - QUESTION_RESUME_MIN_AGE_MS });
    expect(findResumedFromQuestion([aged], deps({ turnEnd: () => "open" }))).toHaveLength(1);
  });

  it("transcript が無いセッションは登録簿 busy のときだけ復帰する（終端・痕跡は見られない）", () => {
    const noPath = target({ transcriptPath: undefined });
    expect(findResumedFromQuestion([noPath], deps({ registryStatus: () => "busy" }))[0].reason).toBe("registry");
    expect(findResumedFromQuestion([noPath], deps({ turnEnd: () => "open" }))).toEqual([]);
  });

  it("複数対象はそれぞれ独立に判定し、成立したものだけ返す", () => {
    const targets = [target({ sessionId: "open" }), target({ sessionId: "idle" })];
    const hits = findResumedFromQuestion(targets, deps({ turnEnd: (p) => (p === "open.jsonl" ? "open" : "concluded") }));
    expect(hits).toEqual([]);
    const hits2 = findResumedFromQuestion(targets, deps({ registryStatus: (sid) => (sid === "open" ? "busy" : "idle"), turnEnd: () => "unknown" }));
    expect(hits2.map((h) => h.target.sessionId)).toEqual(["open"]);
  });
});
