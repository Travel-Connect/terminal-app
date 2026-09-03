/**
 * drop-paths の単体テスト（260727_1: Cursor エクスプローラからの D&D フォールバック抽出）。
 * 認識合わせ: Cursor（VS Code 系）からのドラッグは dataTransfer.files が空で、
 * codefiles（JSON 配列）/ text/uri-list（file:// URI）/ text/plain（パス文字列）に
 * パスが入る。エクスプローラからの通常ドロップ（filePaths あり）が常に最優先。
 */
import { describe, expect, it } from "vitest";
import { extractDropPaths } from "../src/main/drop-paths";

describe("extractDropPaths", () => {
  it("filePaths があれば最優先で採用する（エクスプローラからのドロップ）", () => {
    const r = extractDropPaths({
      filePaths: ["C:\\dev\\app", "C:\\dev\\app"],
      data: { codefiles: JSON.stringify(["C:\\other"]) },
    });
    expect(r.source).toBe("files");
    expect(r.paths).toEqual(["C:\\dev\\app"]); // 重複は除去
  });

  it("codefiles（VS Code 系の JSON 配列）から抽出する", () => {
    const r = extractDropPaths({
      data: { codefiles: JSON.stringify(["c:\\Users\\x\\proj\\src\\main.ts"]) },
    });
    expect(r.source).toBe("codefiles");
    expect(r.paths).toEqual(["c:\\Users\\x\\proj\\src\\main.ts"]);
  });

  it("タイプ名は大文字小文字を区別しない（CodeFiles でも引ける）", () => {
    const r = extractDropPaths({
      data: { CodeFiles: JSON.stringify(["c:\\dev\\a.txt"]) },
    });
    expect(r.source).toBe("codefiles");
    expect(r.paths).toEqual(["c:\\dev\\a.txt"]);
  });

  it("codefiles が壊れた JSON（切り詰め等）なら uri-list へフォールバックする", () => {
    const r = extractDropPaths({
      data: {
        codefiles: '["c:\\\\dev\\\\a', // 途中で切れた JSON
        "text/uri-list": "file:///c%3A/dev/proj/readme.md",
      },
    });
    expect(r.source).toBe("uri-list");
    expect(r.paths).toEqual(["c:\\dev\\proj\\readme.md"]);
  });

  it("text/uri-list の複数行・コメント行・CRLF を処理する", () => {
    const r = extractDropPaths({
      data: {
        "text/uri-list": "# comment\r\nfile:///c%3A/dev/a.txt\r\nfile:///d%3A/work/b\r\n",
      },
    });
    expect(r.source).toBe("uri-list");
    expect(r.paths).toEqual(["c:\\dev\\a.txt", "d:\\work\\b"]);
  });

  it("file: 以外のスキーム（vscode-remote 等）はスキップする", () => {
    const r = extractDropPaths({
      data: { "text/uri-list": "vscode-remote://wsl/home/x/proj\nfile:///c%3A/dev/a" },
    });
    expect(r.paths).toEqual(["c:\\dev\\a"]);
  });

  it("text/plain は Windows 絶対パスに見える行だけを採用する", () => {
    const r = extractDropPaths({
      data: { "text/plain": "C:\\Users\\x\\proj\\file.ts\nこれはただのテキスト" },
    });
    expect(r.source).toBe("text-plain");
    expect(r.paths).toEqual(["C:\\Users\\x\\proj\\file.ts"]);
  });

  it("どの経路にもパスが無ければ none を返す", () => {
    const r = extractDropPaths({ data: { "text/plain": "hello world" } });
    expect(r.source).toBe("none");
    expect(r.paths).toEqual([]);
  });

  it("ペイロードが空でも落ちない", () => {
    expect(extractDropPaths({})).toEqual({ paths: [], source: "none" });
  });
});
