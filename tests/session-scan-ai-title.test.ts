/**
 * 260922_10: Claude Code が transcript に書く ai-title（そのセッションのタスク名）の取り出し。
 * 実データ（2026-09-22 実測）: {"type":"ai-title","aiTitle":"確認待ち左上配置","sessionId":"…"}。
 * 会話が進むたび追記されるため、新しい順に見て最初の 1 件が現在のタスク。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiTitleFrom, aiTitleOf } from "../src/main/session-scan";

const title = (t: unknown): Record<string, unknown> => ({ type: "ai-title", aiTitle: t, sessionId: "s1" });
const newestFirst = (oldestFirst: Record<string, unknown>[]): Record<string, unknown>[] => [...oldestFirst].reverse();

describe("aiTitleFrom", () => {
  it("最新の ai-title を返す（古いものは無視）", () => {
    const records = newestFirst([title("最初のタスク"), { type: "user" }, title("いまのタスク"), { type: "assistant" }]);
    expect(aiTitleFrom(records)).toBe("いまのタスク");
  });

  it("改行・連続空白は 1 つの空白に畳む", () => {
    expect(aiTitleFrom([title("  2026年7月・8月\n 月次レポート作成 ")])).toBe("2026年7月・8月 月次レポート作成");
  });

  it("空・空白のみ・文字列でない値は飛ばして次を見る", () => {
    expect(aiTitleFrom(newestFirst([title("古いタスク"), title(""), title("   "), title(123)]))).toBe("古いタスク");
  });

  it("ai-title が無ければ undefined", () => {
    expect(aiTitleFrom([{ type: "user" }, { type: "assistant" }])).toBeUndefined();
    expect(aiTitleFrom([])).toBeUndefined();
  });
});

describe("aiTitleOf（ファイル）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-aititle-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("JSONL の末尾から最新のタスク名を読む。壊れた行は飛ばす", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, [JSON.stringify(title("古い")), "{壊れた", JSON.stringify({ type: "user" }), JSON.stringify(title("新しい"))].join("\n") + "\n", "utf8");
    expect(aiTitleOf(file)).toBe("新しい");
  });

  it("無いファイルは undefined", () => {
    expect(aiTitleOf(path.join(dir, "none.jsonl"))).toBeUndefined();
  });
});
