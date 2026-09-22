/**
 * 260922_6: タイル名と作業内容の整合判定（Jev）の質問定義と解釈。
 *
 * 閾値は 2026-09-22 の実データ（稼働中 16 タイル）に合わせた:
 * - 汎用名「dev」… name_generic 0.98（作業が何であれ高い）
 * - 具体名「しまのやさんcsv作成ツール」「日別レポート作成」… name_generic 0.08〜0.21 / matches 0.73〜0.95
 * - 内部マーカー（task-notification）が作業テキストのとき… work_is_topic 0.07（名前の材料にならない）
 */
import { describe, expect, it } from "vitest";
import type { JevAnswers } from "../src/main/jev-client";
import {
  NAME_GENERIC_THRESHOLD,
  NAME_MISMATCH_THRESHOLD,
  NAME_WORK_MIN_CHARS,
  NAME_WORK_TOPIC_MIN,
  interpretNameMatch,
  nameMatchQuestions,
  nameMatchState,
} from "../src/main/jev-judge";

const nouls = (values: Record<string, number>): JevAnswers =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "noul", noul: v }]));

describe("nameMatchState", () => {
  it("表示名・フォルダ名・作業テキストを載せる", () => {
    const s = nameMatchState("商品登録アプリ", "shohin-app", "楽天ページに NE コードが入っていない");
    expect(s).toContain("Display name: 商品登録アプリ");
    expect(s).toContain("Folder name: shohin-app");
    expect(s).toContain("Current work: 楽天ページに NE コードが入っていない");
  });

  it("作業テキストが無い・短すぎるときは聞かない", () => {
    expect(nameMatchState("app", "app", undefined)).toBeNull();
    expect(nameMatchState("app", "app", "  ")).toBeNull();
    expect(nameMatchState("app", "app", "あ".repeat(NAME_WORK_MIN_CHARS - 1))).toBeNull();
    expect(nameMatchState("app", "app", "あ".repeat(NAME_WORK_MIN_CHARS))).not.toBeNull();
  });

  it("質問はすべて noul の 3 問", () => {
    const q = nameMatchQuestions();
    expect(Object.keys(q)).toEqual(["matches", "name_generic", "work_is_topic"]);
    for (const v of Object.values(q)) expect(v.type).toBe("noul");
  });
});

describe("interpretNameMatch", () => {
  it("名前が汎用的（dev 相当）なら見直しを提案する", () => {
    const v = interpretNameMatch(nouls({ matches: 0.85, name_generic: NAME_GENERIC_THRESHOLD, work_is_topic: 0.95 }));
    expect(v?.reason).toBe("generic");
    expect(v?.text).toBe("名前が作業を表していません");
  });

  it("名前と作業が別物なら見直しを提案する", () => {
    const v = interpretNameMatch(nouls({ matches: NAME_MISMATCH_THRESHOLD, name_generic: 0.2, work_is_topic: 0.9 }));
    expect(v?.reason).toBe("mismatch");
    expect(v?.text).toBe("名前と作業が一致しません");
  });

  it("具体名で作業も合っていれば印を出さない（文言なし・数値はログ用に返す）", () => {
    const v = interpretNameMatch(nouls({ matches: 0.93, name_generic: 0.08, work_is_topic: 0.72 }));
    expect(v?.text).toBeUndefined();
    expect(v?.reason).toBeUndefined();
    expect(v?.detail).toContain("matches=0.93");
  });

  it("作業テキストが名前の材料にならない（内部マーカー・相槌）なら、汎用名でも提案しない", () => {
    const v = interpretNameMatch(nouls({ matches: 0.7, name_generic: 0.98, work_is_topic: NAME_WORK_TOPIC_MIN - 0.01 }));
    expect(v?.text).toBeUndefined();
    expect(v?.detail).toContain("work_is_topic=0.49");
  });

  it("判定なし・必須の回答が欠けていれば null", () => {
    expect(interpretNameMatch(null)).toBeNull();
    expect(interpretNameMatch(nouls({ work_is_topic: 0.9 }))).toBeNull();
  });
});
