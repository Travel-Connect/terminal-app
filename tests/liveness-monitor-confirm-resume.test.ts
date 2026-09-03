/**
 * 確認待ち → 実行中の復帰検知（260904_1 #2）と掃引間隔の短縮。
 * 認識合わせ: 「許可した後も Claude が動いているのに『確認待ち』表示が残る」を、15 秒周期の掃引で
 * transcript 更新（または登録簿 status=busy）を見て「実行中」へ戻す。
 */
import { describe, expect, it } from "vitest";
import {
  CONFIRM_RESUME_MARGIN_MS,
  CONFIRM_RESUME_MIN_AGE_MS,
  DISCONNECT_CHECK_INTERVAL_MS,
  findResumedFromConfirm,
  type ConfirmTarget,
} from "../src/main/liveness-monitor";

const T0 = 1_000_000;
function target(id: string, lastEventAt = T0, transcriptPath: string | undefined = `C:/t/${id}.jsonl`): ConfirmTarget {
  return { sessionId: id, projectId: "p1", transcriptPath, lastEventAt };
}
function deps(opts: { now?: number; mtimes?: Record<string, number | null>; status?: Record<string, string> }) {
  return {
    now: () => opts.now ?? T0 + 60_000,
    mtimeMs: (p: string) => opts.mtimes?.[p] ?? null,
    registryStatus: (sid: string) => opts.status?.[sid],
  };
}

describe("掃引間隔（260904_1 #2）", () => {
  it("既定 15 秒（30 秒から短縮）", () => {
    expect(DISCONNECT_CHECK_INTERVAL_MS).toBe(15_000);
  });
});

describe("findResumedFromConfirm", () => {
  it("transcript が確認待ちイベント＋余裕以降に更新されていれば復帰（reason=transcript）", () => {
    const t = target("s1");
    const hits = findResumedFromConfirm([t], deps({ mtimes: { "C:/t/s1.jsonl": T0 + CONFIRM_RESUME_MARGIN_MS } }));
    expect(hits).toEqual([{ target: t, reason: "transcript" }]);
  });

  it("余裕未満の更新（通知直後の書き終わり）は復帰しない", () => {
    const hits = findResumedFromConfirm([target("s1")], deps({ mtimes: { "C:/t/s1.jsonl": T0 + CONFIRM_RESUME_MARGIN_MS - 1 } }));
    expect(hits).toEqual([]);
  });

  it("イベントより古い transcript（アイドル通知 = 入力待ち）は復帰しない", () => {
    const hits = findResumedFromConfirm([target("s1")], deps({ mtimes: { "C:/t/s1.jsonl": T0 - 60_000 } }));
    expect(hits).toEqual([]);
  });

  it("登録簿 status が busy なら transcript を見ずに復帰（reason=registry）", () => {
    const t = target("s1", T0, undefined);
    const hits = findResumedFromConfirm([t], deps({ status: { s1: "busy" } }));
    expect(hits).toEqual([{ target: t, reason: "registry" }]);
  });

  it("登録簿 status が waiting / idle は根拠にならない（transcript 側の判定に委ねる）", () => {
    expect(findResumedFromConfirm([target("s1")], deps({ status: { s1: "waiting" } }))).toEqual([]);
    expect(findResumedFromConfirm([target("s2")], deps({ status: { s2: "idle" } }))).toEqual([]);
  });

  it("確認待ちになった直後（MIN_AGE 未満）は判定しない（登録簿更新との競合回避）", () => {
    const hits = findResumedFromConfirm([target("s1")], deps({ now: T0 + CONFIRM_RESUME_MIN_AGE_MS - 1, status: { s1: "busy" }, mtimes: { "C:/t/s1.jsonl": T0 + 60_000 } }));
    expect(hits).toEqual([]);
    const later = findResumedFromConfirm([target("s1")], deps({ now: T0 + CONFIRM_RESUME_MIN_AGE_MS, status: { s1: "busy" } }));
    expect(later).toHaveLength(1);
  });

  it("transcript パス不明・mtime 取得不可は安全側 = 復帰しない", () => {
    expect(findResumedFromConfirm([target("s1", T0, undefined)], deps({}))).toEqual([]);
    expect(findResumedFromConfirm([target("s1")], deps({ mtimes: { "C:/t/s1.jsonl": null } }))).toEqual([]);
  });

  it("複数対象の混在: 条件を満たすものだけ返す", () => {
    const a = target("a");
    const b = target("b");
    const c = target("c");
    const hits = findResumedFromConfirm([a, b, c], deps({ mtimes: { "C:/t/a.jsonl": T0 + 10_000, "C:/t/b.jsonl": T0 - 1 }, status: { c: "busy" } }));
    expect(hits.map((h) => `${h.target.sessionId}:${h.reason}`)).toEqual(["a:transcript", "c:registry"]);
  });
});
