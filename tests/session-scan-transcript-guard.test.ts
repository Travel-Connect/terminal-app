/**
 * 260916_3: hook payload の transcript_path は許可ディレクトリ配下の .jsonl だけを使う
 * （受信サーバに届いた任意パスをそのまま open していた = 偽イベントで任意ファイルを読ませられた）。
 */
import * as path from "path";
import { describe, expect, it } from "vitest";
import { isAllowedTranscriptPath, transcriptRoots } from "../src/main/session-scan";

const home = "C:\\Users\\me";
const projectsRoot = path.join(home, ".claude", "projects");

describe("transcriptRoots", () => {
  it("既定は ~/.claude/projects。TERMINAL_APP_DATA_DIR と TERMINAL_APP_TRANSCRIPT_DIRS（区切り可）を足せる", () => {
    expect(transcriptRoots({}, home)).toEqual([projectsRoot]);
    expect(transcriptRoots({ TERMINAL_APP_DATA_DIR: "D:\\tmp\\data" }, home)).toEqual([projectsRoot, "D:\\tmp\\data"]);
    expect(transcriptRoots({ TERMINAL_APP_TRANSCRIPT_DIRS: `D:\\a${path.delimiter}D:\\b${path.delimiter}` }, home)).toEqual([projectsRoot, "D:\\a", "D:\\b"]);
    expect(transcriptRoots({ TERMINAL_APP_DATA_DIR: "  " }, home)).toEqual([projectsRoot]);
  });
});

describe("isAllowedTranscriptPath", () => {
  const roots = [projectsRoot, "D:\\tmp\\data"];

  it("許可ルート配下の .jsonl は通す（大文字小文字・区切りの違いは無視）", () => {
    expect(isAllowedTranscriptPath(path.join(projectsRoot, "C--dev-app", "abc.jsonl"), roots)).toBe(true);
    expect(isAllowedTranscriptPath("c:/users/ME/.claude/projects/C--dev-app/ABC.JSONL", roots)).toBe(true);
    expect(isAllowedTranscriptPath("D:\\tmp\\data\\t.jsonl", roots)).toBe(true);
  });

  it("ルート外・`..` での脱出・.jsonl 以外・空は弾く", () => {
    expect(isAllowedTranscriptPath("C:\\Windows\\win.ini", roots)).toBe(false);
    expect(isAllowedTranscriptPath(path.join(projectsRoot, "..", "settings.json"), roots)).toBe(false);
    expect(isAllowedTranscriptPath(path.join(projectsRoot, "x", "..", "..", "..", "secret.jsonl"), roots)).toBe(false);
    expect(isAllowedTranscriptPath(path.join(projectsRoot, "x", "notes.txt"), roots)).toBe(false);
    expect(isAllowedTranscriptPath(projectsRoot, roots)).toBe(false); // ルートそのもの
    expect(isAllowedTranscriptPath("", roots)).toBe(false);
    expect(isAllowedTranscriptPath("D:\\tmp\\data-other\\t.jsonl", roots)).toBe(false); // 接頭辞だけ一致するディレクトリ
  });
});
