/**
 * 260922_2: Jev 判定の表示整形（renderer 側 format.ts）のテスト。
 * - confirmLabel: 返答待ち（question）は「返答待ち」、権限確認・未設定は「確認待ち」
 * - tileAlertText: 危険度（dangerText）を優先し、無ければ停滞（stallText）、どちらも無ければ空
 */
import { describe, expect, it } from "vitest";
import { confirmLabel, tileAlertText } from "../src/renderer/format";

describe("confirmLabel", () => {
  it("question は「返答待ち」、permission・undefined は「確認待ち」", () => {
    expect(confirmLabel("question")).toBe("返答待ち");
    expect(confirmLabel("permission")).toBe("確認待ち");
    expect(confirmLabel(undefined)).toBe("確認待ち");
  });
});

describe("tileAlertText", () => {
  it("危険度を優先、無ければ停滞、どちらも無ければ空。待機タイル（undefined）も空", () => {
    expect(tileAlertText({ dangerText: "取り消せない操作", stallText: "停滞の疑い・進展なし" })).toBe("取り消せない操作");
    expect(tileAlertText({ stallText: "停滞の疑い・進展なし" })).toBe("停滞の疑い・進展なし");
    expect(tileAlertText({})).toBe("");
    expect(tileAlertText(undefined)).toBe("");
  });
});
