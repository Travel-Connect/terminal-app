/**
 * 260712_3 案A: statusLine JSON → 「↓ 70.5k tokens · thinking xhigh」整形のテスト。
 * 入力形は公式ドキュメント（code.claude.com/docs/en/statusline.md の Full JSON schema、
 * 2026-07-12 取得）に準拠。effort・thinking・context_window は欠落・null がありうる。
 */
import { describe, expect, it } from "vitest";
import { buildStatusLineCommand } from "../src/main/hooks-manager";
import { fmtStats, fmtTokens, parseStatusLinePayload } from "../src/main/statusline";

/** 公式ドキュメントの Full JSON schema と同形のペイロード */
function docPayload(): Record<string, unknown> {
  return {
    cwd: "C:\\dev\\terminal-app",
    session_id: "abc123",
    transcript_path: "C:\\Users\\x\\.claude\\projects\\C--dev-terminal-app\\abc123.jsonl",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    workspace: { current_dir: "C:\\dev\\terminal-app", project_dir: "C:\\dev\\terminal-app", added_dirs: [] },
    version: "2.1.207",
    cost: { total_cost_usd: 0.01, total_duration_ms: 45000 },
    context_window: {
      total_input_tokens: 15500,
      total_output_tokens: 70500,
      context_window_size: 200000,
      used_percentage: 8,
      remaining_percentage: 92,
      current_usage: { input_tokens: 8500, output_tokens: 1200 },
    },
    exceeds_200k_tokens: false,
    effort: { level: "xhigh" },
    thinking: { enabled: true },
  };
}

describe("parseStatusLinePayload", () => {
  it("公式スキーマ形のペイロードからメトリクスを抽出する", () => {
    const m = parseStatusLinePayload(docPayload());
    expect(m).toEqual({ sessionId: "abc123", outputTokens: 70500, effortLevel: "xhigh", thinkingEnabled: true });
  });

  it("session_id が無い・空・非オブジェクトは null（破棄）", () => {
    expect(parseStatusLinePayload({})).toBeNull();
    expect(parseStatusLinePayload({ session_id: "  " })).toBeNull();
    expect(parseStatusLinePayload("text")).toBeNull();
    expect(parseStatusLinePayload(null)).toBeNull();
    expect(parseStatusLinePayload([1, 2])).toBeNull();
  });

  it("effort 欠落（非対応モデル）・current_usage null（/compact 直後）でも壊れない", () => {
    const p = docPayload();
    delete p.effort;
    (p.context_window as Record<string, unknown>).current_usage = null;
    const m = parseStatusLinePayload(p);
    expect(m).toEqual({ sessionId: "abc123", outputTokens: 70500, thinkingEnabled: true });
  });

  it("context_window 欠落・total_output_tokens が不正型なら tokens 無しで返す", () => {
    const p1 = docPayload();
    delete p1.context_window;
    expect(parseStatusLinePayload(p1)?.outputTokens).toBeUndefined();
    const p2 = docPayload();
    (p2.context_window as Record<string, unknown>).total_output_tokens = "70500";
    expect(parseStatusLinePayload(p2)?.outputTokens).toBeUndefined();
  });
});

describe("fmtTokens", () => {
  it("1000 以上は 0.1k 単位（ターミナル表示準拠）、999 以下はそのまま", () => {
    expect(fmtTokens(70500)).toBe("70.5k");
    expect(fmtTokens(83400)).toBe("83.4k");
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(0)).toBe("0");
  });
});

describe("fmtStats", () => {
  it("フル情報 → 「↓ 70.5k tokens · thinking xhigh」", () => {
    expect(fmtStats({ sessionId: "s", outputTokens: 70500, effortLevel: "xhigh", thinkingEnabled: true })).toBe(
      "↓ 70.5k tokens · thinking xhigh"
    );
  });

  it("thinking 無効 + effort あり → 「effort xhigh」", () => {
    expect(fmtStats({ sessionId: "s", outputTokens: 1200, effortLevel: "xhigh", thinkingEnabled: false })).toBe(
      "↓ 1.2k tokens · effort xhigh"
    );
  });

  it("thinking 有効 + effort 欠落 → 「thinking」のみ", () => {
    expect(fmtStats({ sessionId: "s", thinkingEnabled: true })).toBe("thinking");
  });

  it("tokens のみ → tokens だけ、何も無ければ undefined（非表示フォールバック）", () => {
    expect(fmtStats({ sessionId: "s", outputTokens: 500 })).toBe("↓ 500 tokens");
    expect(fmtStats({ sessionId: "s" })).toBeUndefined();
    expect(fmtStats({ sessionId: "s", thinkingEnabled: false })).toBeUndefined();
  });
});

describe("buildStatusLineCommand", () => {
  it("statusline 受信パスへ POST し、レスポンスを stdout に流す（-o NUL を付けない）", () => {
    const cmd = buildStatusLineCommand(41321);
    expect(cmd).toContain("http://127.0.0.1:41321/terminal-app/statusline");
    expect(cmd).toContain("--data-binary @-");
    expect(cmd).not.toContain("-o NUL"); // レスポンス本文 = statusline 表示のため捨てない
  });
});
