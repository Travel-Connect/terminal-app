/**
 * 260922_9: CLI が混ぜてくる案内行を名前の候補から外す。
 *
 * 実測（2026-09-22）: `claude -p` は環境によって「✗ Auto-update failed…」「⚠ Sandbox disabled…」
 * 「Permission deny rule …」を出す。これを名前として拾うと必ず失敗していた。
 * 長すぎる行は「その行を捨てて次を見る」に変えた（説明文の後ろに名前が来る場合を拾う）。
 */
import { describe, expect, it } from "vitest";
import { NAME_SUGGEST_MAX_CHARS, parseSuggestedName } from "../src/main/name-suggest";

describe("parseSuggestedName（案内行の混入）", () => {
  it("自動更新・サンドボックス・権限の案内を飛ばして名前を拾う", () => {
    const out = [
      "✗ Auto-update failed: claude.exe in use (close other Claude Code sessions, including VS Code)",
      "⚠ Sandbox disabled: sandbox is enabled but the Windows sandbox is not active",
      "Permission deny rule (.claude/settings.json): Write(.claude/settings*) is not matched",
      "",
      "在庫スキャンツール",
    ].join("\n");
    expect(parseSuggestedName(out)).toBe("在庫スキャンツール");
  });

  it("長すぎる行は捨てて次の行を見る（説明のあとに名前が来る形）", () => {
    const out = `このプロジェクトの内容から考えると次の名前が適切だと思われます。理由は作業内容が在庫管理に関するものだからです。\n在庫管理ツール`;
    expect(parseSuggestedName(out)).toBe("在庫管理ツール");
  });

  it("案内行しか無ければ null（表示名は変えない）", () => {
    expect(parseSuggestedName("✗ Auto-update failed\nRun claude doctor")).toBeNull();
    expect(parseSuggestedName("Error: something went wrong")).toBeNull();
  });

  it("案内行に見える名前は誤って落とさない（先頭が記号・英単語でないかぎり通す）", () => {
    expect(parseSuggestedName("Warning灯チェックツール")).toBeNull(); // Warning で始まるものは案内行として除外
    expect(parseSuggestedName("警告灯チェックツール")).toBe("警告灯チェックツール");
    expect(parseSuggestedName("あ".repeat(NAME_SUGGEST_MAX_CHARS))).toBe("あ".repeat(NAME_SUGGEST_MAX_CHARS));
  });
});
