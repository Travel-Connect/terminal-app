/**
 * 260712_2: 再接続用の transcript 走査（scanLiveSessions）のテスト。
 *
 * 実ディレクトリ構造（2026-07-12 実測: %USERPROFILE%\.claude\projects\C--Users-hppym-dev-terminal-app\
 * <sessionId>.jsonl）を一時ディレクトリに再現して検証する。
 * munge は情報を落とすため、JSONL 内 cwd の裏取りが必須（テストで担保）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mungeProjectPath, scanLiveSessions, transcriptDirFor, RECONNECT_ACTIVE_MS } from "../src/main/session-scan";

const PROJECT = "C:\\dev\\terminal-app";

let home: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ta-scan-home-"));
  dir = transcriptDirFor(PROJECT, home);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function jsonl(records: Array<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** transcript ファイルを作成し mtime を ageMs 前に設定する */
function writeTranscript(name: string, records: Array<Record<string, unknown>>, ageMs: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, jsonl(records), "utf8");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

const userRec = (text: string): Record<string, unknown> => ({
  type: "user",
  message: { role: "user", content: text },
  cwd: PROJECT,
  sessionId: "x",
});

describe("mungeProjectPath / transcriptDirFor", () => {
  it("英数字以外を - へ置換する（実測: C:\\Users\\hppym\\dev\\terminal-app → C--Users-hppym-dev-terminal-app）", () => {
    expect(mungeProjectPath("C:\\Users\\hppym\\dev\\terminal-app")).toBe("C--Users-hppym-dev-terminal-app");
    expect(mungeProjectPath("C:\\dev\\app.v2")).toBe("C--dev-app-v2");
  });

  it("transcript ディレクトリは homeDir/.claude/projects/<munged>", () => {
    expect(transcriptDirFor("C:\\dev\\app", "D:\\home")).toBe(path.join("D:\\home", ".claude", "projects", "C--dev-app"));
  });
});

describe("scanLiveSessions", () => {
  it("直近更新の transcript を sessionId・workText 付きで返す", () => {
    writeTranscript("aaaa-1111.jsonl", [userRec("古い依頼"), userRec("最新の依頼です")], 10_000);
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe("aaaa-1111");
    expect(found[0].workText).toBe("最新の依頼です"); // 末尾側 = 最新の user テキスト
    expect(found[0].transcriptPath).toBe(path.join(dir, "aaaa-1111.jsonl"));
  });

  it("activeMs より古い transcript は「動作中」とみなさない", () => {
    writeTranscript("old.jsonl", [userRec("依頼")], RECONNECT_ACTIVE_MS + 60_000);
    expect(scanLiveSessions(PROJECT, { homeDir: home })).toEqual([]);
  });

  it("cwd がプロジェクト配下でない transcript は除外する（munge 衝突の裏取り）", () => {
    writeTranscript(
      "other.jsonl",
      [{ type: "user", message: { role: "user", content: "x" }, cwd: "C:\\dev\\terminal-app2" }],
      1_000
    );
    expect(scanLiveSessions(PROJECT, { homeDir: home })).toEqual([]);
  });

  it("サブディレクトリ起動（cwd がプロジェクト配下）は同一プロジェクトとして受理する", () => {
    writeTranscript(
      "sub.jsonl",
      [{ type: "user", message: { role: "user", content: "サブで作業" }, cwd: "C:\\dev\\terminal-app\\src" }],
      1_000
    );
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe("sub");
  });

  it("agent-*.jsonl（サブエージェント記録）と .jsonl 以外は対象外", () => {
    writeTranscript("agent-xyz.jsonl", [userRec("サブエージェント")], 1_000);
    fs.writeFileSync(path.join(dir, "note.txt"), "not a transcript", "utf8");
    fs.mkdirSync(path.join(dir, "subdir-uuid"), { recursive: true });
    expect(scanLiveSessions(PROJECT, { homeDir: home })).toEqual([]);
  });

  it("workText はコマンド枠（<...>）・Caveat・メタ・tool_result を飛ばして直近のユーザー文を拾う", () => {
    writeTranscript(
      "w.jsonl",
      [
        userRec("本当の依頼文"),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] }, cwd: PROJECT },
        { type: "user", isMeta: true, message: { role: "user", content: "メタ" }, cwd: PROJECT },
        { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" }, cwd: PROJECT },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "返答" }] }, cwd: PROJECT },
      ],
      1_000
    );
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found[0].workText).toBe("本当の依頼文");
  });

  it("user テキストが見つからなくても復元対象にはなる（workText undefined）", () => {
    writeTranscript(
      "no-user.jsonl",
      [{ type: "assistant", message: { role: "assistant", content: [] }, cwd: PROJECT }],
      1_000
    );
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].workText).toBeUndefined();
  });

  it("複数セッションは更新が新しい順に返す", () => {
    writeTranscript("older.jsonl", [userRec("A")], 60_000);
    writeTranscript("newer.jsonl", [userRec("B")], 5_000);
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found.map((f) => f.sessionId)).toEqual(["newer", "older"]);
  });

  it("transcript ディレクトリ自体が無ければ空配列（例外にしない）", () => {
    expect(scanLiveSessions("C:\\dev\\unknown-project", { homeDir: home })).toEqual([]);
  });

  it("破損行（不正 JSON）が混ざっていても他レコードで判定を続行する", () => {
    const p = path.join(dir, "broken.jsonl");
    fs.writeFileSync(p, "{invalid json}\n" + JSON.stringify(userRec("生きてる依頼")) + "\n", "utf8");
    const t = new Date(Date.now() - 1_000);
    fs.utimesSync(p, t, t);
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].workText).toBe("生きてる依頼");
  });
});
