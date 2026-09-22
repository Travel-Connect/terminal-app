/**
 * 260922_6: 表示名の提案（Claude Code CLI = sonnet）の純関数と組み立て。
 * CLI は差し替え可能な run で注入するため、実プロセスは起動しない。
 * 実測（2026-09-22）: `claude -p --model sonnet` は名前 1 行だけを返し、所要 11 秒前後。
 */
import { describe, expect, it, vi } from "vitest";
import { NAME_SUGGEST_MAX_CHARS, buildNamePrompt, parseSuggestedName, suggestProjectName } from "../src/main/name-suggest";

describe("buildNamePrompt", () => {
  it("フォルダ名・現在の表示名・直近の作業（最大 5 件）と条件を載せる", () => {
    const prompt = buildNamePrompt({
      folderName: "repeat_mail_tool",
      currentName: "dev",
      works: ["リピート促進メールの本数を1,3,5,10に設定", "  ", "2本セットの登録を検討", "a", "b", "c", "d"],
    });
    expect(prompt).toContain("フォルダ名: repeat_mail_tool");
    expect(prompt).toContain("現在の表示名: dev");
    expect(prompt).toContain("- リピート促進メールの本数を1,3,5,10に設定");
    expect(prompt).toContain(`- 日本語で ${NAME_SUGGEST_MAX_CHARS} 文字以内`);
    expect(prompt.match(/^- /gm)?.length).toBe(5 + 4); // 作業 5 件（空白行は除外）＋ 条件 4 行
  });

  it("作業が 1 件も無ければ「（不明）」と書く", () => {
    expect(buildNamePrompt({ folderName: "app", currentName: "app", works: [] })).toContain("直近の作業: （不明）");
  });
});

describe("parseSuggestedName", () => {
  it("名前だけの 1 行をそのまま採る", () => {
    expect(parseSuggestedName("リピート促進メール設定\n")).toBe("リピート促進メール設定");
  });

  it("箇条書き・引用符・末尾の句点を落とす", () => {
    expect(parseSuggestedName("- 「在庫管理ツール」。")).toBe("在庫管理ツール");
    expect(parseSuggestedName('"日別レポート作成"')).toBe("日別レポート作成");
  });

  it("空行を飛ばして最初の中身のある行を採る", () => {
    expect(parseSuggestedName("\n\n  受注CSV取込ツール  \n説明は無視される")).toBe("受注CSV取込ツール");
  });

  it("上限超過・空・制御文字は null（提案なしに倒す）", () => {
    expect(parseSuggestedName("あ".repeat(NAME_SUGGEST_MAX_CHARS + 1))).toBeNull();
    expect(parseSuggestedName("あ".repeat(NAME_SUGGEST_MAX_CHARS))).toBe("あ".repeat(NAME_SUGGEST_MAX_CHARS));
    expect(parseSuggestedName("")).toBeNull();
    expect(parseSuggestedName("   \n  ")).toBeNull();
    expect(parseSuggestedName("名前\u0007あり")).toBeNull();
  });

  it("上限は引数で変えられる", () => {
    expect(parseSuggestedName("長めの名前です", 5)).toBeNull();
    expect(parseSuggestedName("短い名", 5)).toBe("短い名");
  });
});

describe("suggestProjectName", () => {
  const input = { folderName: "repeat_mail_tool", currentName: "dev", works: ["リピート促進メールの本数を設定"] };

  it("CLI の出力から名前を返し、プロンプトと作業ディレクトリを渡す", async () => {
    const run = vi.fn(async (_prompt: string, _cwd: string, _timeoutMs: number) => ({ ok: true, stdout: "リピート促進メール\n" }));
    const r = await suggestProjectName(input, "C:/dev/repeat_mail_tool", { run });
    expect(r).toEqual({ ok: true, name: "リピート促進メール" });
    expect(run.mock.calls[0][1]).toBe("C:/dev/repeat_mail_tool");
    expect(String(run.mock.calls[0][0])).toContain("フォルダ名: repeat_mail_tool");
  });

  it("CLI 失敗・形式不正・現状維持の提案は ok=false（表示名は変えない）", async () => {
    expect(await suggestProjectName(input, ".", { run: async () => ({ ok: false, stdout: "", error: "claude コマンドを実行できません" }) })).toEqual({
      ok: false,
      error: "claude コマンドを実行できません",
    });
    const bad = await suggestProjectName(input, ".", { run: async () => ({ ok: true, stdout: "  \n \n" }) });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("名前だけの 1 行");
    const same = await suggestProjectName(input, ".", { run: async () => ({ ok: true, stdout: "dev" }) });
    expect(same.ok).toBe(false);
    expect(same.error).toContain("dev");
  });

  it("タイムアウト値と上限文字数を渡せる", async () => {
    const run = vi.fn(async (_prompt: string, _cwd: string, _timeoutMs: number) => ({ ok: true, stdout: "とても長い名前になっています" }));
    expect(await suggestProjectName(input, ".", { run, timeoutMs: 1234, maxChars: 5 })).toEqual({
      ok: false,
      error: "提案の形式が想定外でした（名前だけの 1 行が得られませんでした）",
    });
    expect(run.mock.calls[0][2]).toBe(1234);
  });
});
