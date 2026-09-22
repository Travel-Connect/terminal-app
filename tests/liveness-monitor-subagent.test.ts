/**
 * 260922_8: サブエージェント（バックグラウンドエージェント）待ちの復帰判定。
 *
 * 実データ（2026-09-22 15:40 実測）: product-register のセッションは本体 transcript が 14 分無更新なのに
 * subagents/agent-*.jsonl は 0.4 分前まで更新されていた（Backgrounded agent が作業中）。
 * 本体 mtime は Stop 直後の後片付けでも動くため、判定には subagent 記録だけを使う。
 */
import { describe, expect, it } from "vitest";
import {
  SUBAGENT_RESUME_MARGIN_MS,
  findResumedFromQuestion,
  findResumedFromStopped,
  type QuestionResumeDeps,
  type QuestionTarget,
  type StoppedResumeDeps,
  type StoppedTarget,
} from "../src/main/liveness-monitor";

const NOW = 1_000_000_000;
const STOPPED_AT = NOW - 120_000;

const stopped = (over: Partial<StoppedTarget> = {}): StoppedTarget => ({
  sessionId: "s1",
  projectId: "p1",
  transcriptPath: "C:/t/s1.jsonl",
  state: "done",
  lastEventAt: STOPPED_AT,
  ...over,
});

const stoppedDeps = (over: Partial<StoppedResumeDeps> = {}): StoppedResumeDeps => ({
  now: () => NOW,
  registryStatus: () => "idle",
  turnEnd: () => "concluded",
  blockedStop: () => null,
  activityMtimeMs: () => null,
  ...over,
});

describe("findResumedFromStopped（サブエージェント待ち）", () => {
  it("完了でも subagent 記録が Stop より後に更新されていれば実行中へ戻す", () => {
    const hits = findResumedFromStopped([stopped()], stoppedDeps({ subagentMtimeMs: () => NOW - 20_000 }));
    expect(hits.map((h) => h.reason)).toEqual(["subagent"]);
  });

  it("Stop の直前に終わった subagent（余裕の範囲内）では戻さない", () => {
    const justBefore = stoppedDeps({ subagentMtimeMs: () => STOPPED_AT + SUBAGENT_RESUME_MARGIN_MS });
    expect(findResumedFromStopped([stopped()], justBefore)).toEqual([]);
    const after = stoppedDeps({ subagentMtimeMs: () => STOPPED_AT + SUBAGENT_RESUME_MARGIN_MS + 1 });
    expect(findResumedFromStopped([stopped()], after)).toHaveLength(1);
  });

  it("subagent 記録が無い（null）ときは従来どおり（完了は戻さない）", () => {
    expect(findResumedFromStopped([stopped()], stoppedDeps({ subagentMtimeMs: () => null }))).toEqual([]);
    expect(findResumedFromStopped([stopped()], stoppedDeps())).toEqual([]); // dep 未指定でも落ちない
  });

  it("切断からも同じ根拠で戻る。登録簿 busy・block 痕跡の方が先に採用される", () => {
    const disc = stopped({ state: "disconnected" });
    expect(findResumedFromStopped([disc], stoppedDeps({ subagentMtimeMs: () => NOW - 10_000 }))[0].reason).toBe("subagent");
    const busy = stoppedDeps({ registryStatus: () => "busy", turnEnd: () => "open", subagentMtimeMs: () => NOW - 10_000 });
    expect(findResumedFromStopped([stopped()], busy)[0].reason).toBe("registry");
    const blocked = stoppedDeps({ blockedStop: () => ({ at: NOW - 60_000, reason: "[loop]" }), subagentMtimeMs: () => NOW - 10_000 });
    expect(findResumedFromStopped([stopped()], blocked)[0].reason).toBe("blocked-stop");
  });
});

const question = (over: Partial<QuestionTarget> = {}): QuestionTarget => ({
  sessionId: "s1",
  projectId: "p1",
  transcriptPath: "C:/t/s1.jsonl",
  stoppedAt: STOPPED_AT,
  pendingSince: STOPPED_AT + 4_000,
  ...over,
});

const questionDeps = (over: Partial<QuestionResumeDeps> = {}): QuestionResumeDeps => ({
  now: () => NOW,
  registryStatus: () => "idle",
  turnEnd: () => "concluded",
  blockedStop: () => null,
  ...over,
});

describe("findResumedFromQuestion（サブエージェント待ち）", () => {
  it("返答待ちに見えても subagent が Stop より後に動いていれば実行中へ戻す", () => {
    const hits = findResumedFromQuestion([question()], questionDeps({ subagentMtimeMs: () => NOW - 30_000 }));
    expect(hits.map((h) => h.reason)).toEqual(["subagent"]);
  });

  it("Stop 直前までの更新では戻さない。dep 未指定でも落ちない", () => {
    expect(findResumedFromQuestion([question()], questionDeps({ subagentMtimeMs: () => STOPPED_AT + SUBAGENT_RESUME_MARGIN_MS }))).toEqual([]);
    expect(findResumedFromQuestion([question()], questionDeps())).toEqual([]);
  });

  it("ターン再開（終端 open）の方が先に採用される", () => {
    const both = questionDeps({ turnEnd: () => "open", subagentMtimeMs: () => NOW - 10_000 });
    expect(findResumedFromQuestion([question()], both)[0].reason).toBe("turn-open");
  });
});
