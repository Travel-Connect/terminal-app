/**
 * 260922_8: 「バックグラウンドのエージェントに任せて待っている」の判定（返答待ち判定への追加分）。
 * 画面メモ（2026-09-22）の例: 「Yahoo 側の作業を Opus に投げました。完了通知が来たら…確認します。」
 * — 質問でも完了でもなく、裏で作業が続いている状態。
 */
import { describe, expect, it } from "vitest";
import type { JevAnswers } from "../src/main/jev-client";
import { BACKGROUND_DELEGATION_THRESHOLD, PENDING_QUESTION_THRESHOLD, interpretPendingQuestion, pendingQuestionQuestions } from "../src/main/jev-judge";

const nouls = (values: Record<string, number>): JevAnswers =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "noul", noul: v }]));

describe("delegated_background", () => {
  it("質問セットに含まれ、すべて noul", () => {
    const q = pendingQuestionQuestions();
    expect(Object.keys(q)).toContain("delegated_background");
    for (const v of Object.values(q)) expect(v.type).toBe("noul");
  });

  it("委譲が強ければ background=true（完了でも返答待ちでもない）", () => {
    const v = interpretPendingQuestion(nouls({ asks_user: 0.2, is_report: 0.8, delegated_background: BACKGROUND_DELEGATION_THRESHOLD }));
    expect(v?.background).toBe(true);
    expect(v?.pending).toBe(false);
    expect(v?.detail).toContain("delegated_background=0.70");
  });

  it("返答待ちが成立していれば background にはしない（ユーザーの返答が先）", () => {
    const v = interpretPendingQuestion(nouls({ asks_user: PENDING_QUESTION_THRESHOLD, is_report: 0.1, delegated_background: 0.95 }));
    expect(v?.pending).toBe(true);
    expect(v?.background).toBe(false);
  });

  it("委譲が弱ければ false。回答が無いときも false（従来どおり完了）", () => {
    expect(interpretPendingQuestion(nouls({ asks_user: 0.1, is_report: 0.9, delegated_background: 0.69 }))?.background).toBe(false);
    expect(interpretPendingQuestion(nouls({ asks_user: 0.1, is_report: 0.9 }))?.background).toBe(false);
  });
});
