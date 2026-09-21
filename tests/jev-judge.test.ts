/**
 * 260922_2: Jev に聞く 4 判定（返答待ち／危険度／作業テキスト／停滞）の質問定義と解釈（純関数）のテスト。
 * 閾値の境界、相反する信号の合成、判定材料が足りないときの「聞かない」（precheck）を確認する。
 */
import { describe, expect, it } from "vitest";
import type { JevAnswers } from "../src/main/jev-client";
import {
  DANGER_THRESHOLD,
  PENDING_QUESTION_THRESHOLD,
  STALL_MIN_STEPS,
  STALL_THRESHOLD,
  WORK_TEXT_SHORT_CHARS,
  dangerQuestions,
  dangerState,
  interpretDanger,
  interpretPendingQuestion,
  interpretStall,
  interpretWorkText,
  pendingQuestionQuestions,
  pendingQuestionState,
  shouldJudgeWorkText,
  stallQuestions,
  stallState,
  tailClip,
  workTextQuestions,
  type StepSummary,
} from "../src/main/jev-judge";

const nouls = (values: Record<string, number>): JevAnswers =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "noul", noul: v }]));

describe("tailClip", () => {
  it("上限以下はそのまま、超えたら末尾を残して先頭に … を付ける", () => {
    expect(tailClip("abc", 10)).toBe("abc");
    expect(tailClip("0123456789", 5)).toBe("…6789");
  });
});

describe("返答待ち（pendingQuestion）", () => {
  it("質問はすべて noul（型をまたいで閾値を使い回さない）", () => {
    for (const q of Object.values(pendingQuestionQuestions())) expect(q.type).toBe("noul");
  });

  it("短すぎる返答は聞かない（null）。十分なら末尾優先で切り詰めた本文", () => {
    expect(pendingQuestionState(undefined)).toBeNull();
    expect(pendingQuestionState("了解です")).toBeNull();
    expect(pendingQuestionState("どちらの方式にしますか？ A か B を選んでください")).toContain("選んでください");
  });

  it("asks_user が閾値以上かつ is_report より強ければ返答待ち", () => {
    const v = interpretPendingQuestion(nouls({ asks_user: PENDING_QUESTION_THRESHOLD, is_report: 0.2, wants_permission: 0.1 }));
    expect(v?.pending).toBe(true);
    expect(v?.detail).toContain("asks_user=0.70");
  });

  it("wants_permission（許可依頼）でも返答待ちになる", () => {
    expect(interpretPendingQuestion(nouls({ asks_user: 0.3, is_report: 0.2, wants_permission: 0.9 }))?.pending).toBe(true);
  });

  it("完了報告の方が強ければ返答待ちにしない（フォローアップ提案付きの完了報告を誤検知しない）", () => {
    expect(interpretPendingQuestion(nouls({ asks_user: 0.75, is_report: 0.9 }))?.pending).toBe(false);
    expect(interpretPendingQuestion(nouls({ asks_user: 0.69, is_report: 0.1 }))?.pending).toBe(false);
  });

  it("判定なし（null・asks_user 欠落）は null", () => {
    expect(interpretPendingQuestion(null)).toBeNull();
    expect(interpretPendingQuestion(nouls({ is_report: 0.1 }))).toBeNull();
  });
});

describe("確認待ちの危険度（danger）", () => {
  it("tool_use が無ければ聞かない。あればツール名・引数・通知文を載せる", () => {
    expect(dangerState(undefined, "msg")).toBeNull();
    const s = dangerState({ name: "Bash", input: '{"command":"rm -rf dist"}' }, "Claude needs your permission to use Bash");
    expect(s).toContain("Tool: Bash");
    expect(s).toContain("rm -rf dist");
    expect(s).toContain("Notification: Claude needs");
    expect(Object.keys(dangerQuestions())).toEqual(["irreversible", "external", "broad_scope"]);
  });

  it("閾値以上の項目だけを「・」で連結。全部未満なら text 無し", () => {
    expect(interpretDanger(nouls({ irreversible: DANGER_THRESHOLD, external: 0.1, broad_scope: 0.1 }))?.text).toBe("取り消せない操作");
    expect(interpretDanger(nouls({ irreversible: 0.9, external: 0.8, broad_scope: 0.7 }))?.text).toBe("取り消せない操作・外部へ送る操作・広範囲に影響");
    const none = interpretDanger(nouls({ irreversible: 0.2, external: 0.59, broad_scope: 0.0 }));
    expect(none?.text).toBeUndefined();
    expect(none?.detail).toContain("external=0.59");
  });

  it("判定なしは null", () => {
    expect(interpretDanger(null)).toBeNull();
    expect(interpretDanger({})).toBeNull();
  });
});

describe("作業テキストの上書き防止（workText）", () => {
  it("前の作業テキストがあり、新しいプロンプトが短いときだけ聞く", () => {
    expect(shouldJudgeWorkText("はい", "前の作業")).toBe(true);
    expect(shouldJudgeWorkText("A", "前の作業")).toBe(true);
    expect(shouldJudgeWorkText("はい", undefined)).toBe(false);
    expect(shouldJudgeWorkText("はい", "")).toBe(false);
    expect(shouldJudgeWorkText(undefined, "前の作業")).toBe(false);
    expect(shouldJudgeWorkText("   ", "前の作業")).toBe(false);
    expect(shouldJudgeWorkText("x".repeat(WORK_TEXT_SHORT_CHARS), "前の作業")).toBe(true);
    expect(shouldJudgeWorkText("x".repeat(WORK_TEXT_SHORT_CHARS + 1), "前の作業")).toBe(false);
  });

  it("is_task が閾値以上なら置き換え、未満なら前の文を維持。判定なしは null", () => {
    expect(Object.keys(workTextQuestions())).toEqual(["is_task"]);
    expect(interpretWorkText(nouls({ is_task: 0.5 }))).toEqual({ replace: true, p: 0.5 });
    expect(interpretWorkText(nouls({ is_task: 0.1 }))).toEqual({ replace: false, p: 0.1 });
    expect(interpretWorkText(null)).toBeNull();
    expect(interpretWorkText({})).toBeNull();
  });
});

describe("停滞の疑い（stall）", () => {
  const step = (kind: StepSummary["kind"], text: string, error?: boolean): StepSummary => ({ kind, text, error });

  it("手順（tool_use / tool_result）が最小数未満なら聞かない。text だけでは数えない", () => {
    const few = [step("text", "考え中"), step("tool_use", "Bash ls"), step("tool_result", "a b c")];
    expect(stallState(few)).toBeNull();
    const enough: StepSummary[] = [];
    for (let i = 0; i < STALL_MIN_STEPS; i++) enough.push(step(i % 2 === 0 ? "tool_use" : "tool_result", `s${i}`, i % 2 === 1));
    const s = stallState(enough);
    expect(s).toContain("1. CALL: s0");
    expect(s).toContain("2. RESULT(error): s1");
    expect(Object.keys(stallQuestions())).toEqual(["repeating_failure", "no_progress", "making_progress"]);
  });

  it("繰り返し失敗が閾値以上（かつ進展が弱い）→ 「同じ失敗を繰り返し」。進展なし → 「進展なし」", () => {
    expect(interpretStall(nouls({ repeating_failure: STALL_THRESHOLD, no_progress: 0.3, making_progress: 0.2 }))?.text).toBe("停滞の疑い・同じ失敗を繰り返し");
    expect(interpretStall(nouls({ repeating_failure: 0.2, no_progress: 0.9, making_progress: 0.2 }))?.text).toBe("停滞の疑い・進展なし");
  });

  it("「進展あり」が強ければ停滞にしない（相反する信号の合成）。両方弱ければ text 無し", () => {
    expect(interpretStall(nouls({ repeating_failure: 0.9, no_progress: 0.9, making_progress: 0.8 }))?.text).toBeUndefined();
    const calm = interpretStall(nouls({ repeating_failure: 0.1, no_progress: 0.2, making_progress: 0.9 }));
    expect(calm?.text).toBeUndefined();
    expect(calm?.detail).toContain("making_progress=0.90");
  });

  it("判定なしは null", () => {
    expect(interpretStall(null)).toBeNull();
    expect(interpretStall(nouls({ making_progress: 0.5 }))).toBeNull();
  });
});
