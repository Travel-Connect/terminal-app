/**
 * 260922_5: Claude Code が prompt に自動で差し込む枠を作業テキストから落とす stripSystemBlocks / extractWorkText。
 *
 * 実データ（2026-09-22 実測）: 商品登録アプリ・入庫スキャンアプリのタイルに
 * `<task-notification> <…` と内部向けの文字列が出ていた。バックグラウンド作業の完了通知や
 * 貼り付け枠・スラッシュコマンドの記録が UserPromptSubmit の prompt に含まれるため。
 * 枠だけの prompt は undefined（呼び出し側が前の依頼文を維持する）に倒す。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, extractWorkText, stripSystemBlocks, type HookEvent } from "../src/main/state-store";

describe("stripSystemBlocks", () => {
  it("開始〜終了タグの枠ごと落とす（task-notification / system-reminder）", () => {
    expect(stripSystemBlocks("<task-notification>Agent done: 12 files</task-notification>").trim()).toBe("");
    expect(stripSystemBlocks("<system-reminder>\n内部の注意書き\n</system-reminder>").trim()).toBe("");
  });

  it("貼り付け枠の外にあるユーザーの指示は残す", () => {
    const prompt = '<pasted_content id="f299">長いログ\n2 行目</pasted_content>\n\nこのエラーを直して';
    expect(stripSystemBlocks(prompt).trim()).toBe("このエラーを直して");
  });

  it("終了タグが無い（途中で切れた）枠は、そこから末尾まで捨てる", () => {
    expect(stripSystemBlocks("前置き\n<task-notification>途中で切れた内容").trim()).toBe("前置き");
  });

  it("スラッシュコマンドの記録（command-name など）も落とす", () => {
    const prompt = "<command-name>/model</command-name><command-message>model</command-message><command-args></command-args>";
    expect(stripSystemBlocks(prompt).trim()).toBe("");
  });

  it("ふつうの依頼文は 1 文字も変えない。HTML・コードのタグ（div 等）は対象外", () => {
    expect(stripSystemBlocks("在庫の発注点を再計算して")).toBe("在庫の発注点を再計算して");
    expect(stripSystemBlocks("<div class='x'>ここ</div> を直して")).toBe("<div class='x'>ここ</div> を直して");
  });
});

describe("extractWorkText（枠を落としてから整形）", () => {
  it("枠だけの prompt は undefined（= 前の作業テキストを維持する合図）", () => {
    expect(extractWorkText("<task-notification>Agent finished</task-notification>")).toBeUndefined();
    expect(extractWorkText("<bash-input>ls</bash-input><bash-stdout>a b c</bash-stdout>")).toBeUndefined();
  });

  it("枠の外の指示だけを整形して返す（改行畳み・80 文字省略は従来どおり）", () => {
    expect(extractWorkText("<system-reminder>注意</system-reminder>\n\n  README を\n直して  ")).toBe("README を 直して");
    const long = `<task-notification>x</task-notification>${"あ".repeat(100)}`;
    expect(extractWorkText(long)).toBe(`${"あ".repeat(80)}…`);
  });
});

describe("UserPromptSubmit 経由（タイルの作業テキスト）", () => {
  const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-22T00:00:00Z" }];
  const evt = (prompt: string | undefined, sessionId = "s1"): HookEvent => ({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd: "C:/dev/app",
    prompt,
  });

  it("バックグラウンド完了通知では作業テキストが書き換わらず、状態だけ実行中になる", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("在庫の発注点を再計算して"), projects);
    store.applyEvent(evt("<task-notification>Agent done</task-notification>"), projects);
    const v = store.displaySessions(projects)["p1"];
    expect(v.workText).toBe("在庫の発注点を再計算して");
    expect(v.state).toBe("running");
  });

  it("貼り付け付きの依頼は、貼り付け本文ではなく指示文が出る", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt('<pasted_content id="a1">巨大なログ</pasted_content>\nこのログの原因を調べて'), projects);
    expect(store.displaySessions(projects)["p1"].workText).toBe("このログの原因を調べて");
  });
});
