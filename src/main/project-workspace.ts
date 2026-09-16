/** Cursor/VS Code のローカル workspace を登録先フォルダへ展開する。 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { resolveProjectRoot } from "./project-root";
import { normalizePath } from "./state-store";

export interface ProjectLocation {
  path: string;
  workspacePath?: string;
}

/** JSONC の文字列を保ったままコメントと末尾カンマを除く。eval は使わない。 */
function parseWorkspace(text: string): unknown {
  const tokens = text.replace(/^\uFEFF/, "").match(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[^"/]+|\//g) ?? [];
  const uncommented = tokens.map((token) => token.startsWith("//") || token.startsWith("/*") ? " " : token).join("");
  // 文字列リテラルを先にマッチさせるため、文字列中の「, }」等は変更しない。
  return JSON.parse(uncommented.replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith('"') ? token : ""));
}

/**
 * workspace ファイルの親をプロジェクトとみなすと、別の .claude に hooks を書いてしまう。
 * folders が解決できない場合は親へフォールバックせず、書き込み前に登録エラーにする。
 */
export function resolveProjectLocations(droppedPath: string): ProjectLocation[] {
  if (path.extname(droppedPath).toLowerCase() !== ".code-workspace" || fs.statSync(droppedPath).isDirectory()) {
    return [{ path: resolveProjectRoot(droppedPath) ?? droppedPath }];
  }
  const workspacePath = path.resolve(droppedPath);
  let parsed: unknown;
  try {
    parsed = parseWorkspace(fs.readFileSync(workspacePath, "utf8"));
  } catch {
    throw new Error("ワークスペースを読み込めません（JSONC を確認してください）");
  }
  const folders = parsed !== null && typeof parsed === "object" && "folders" in parsed ? parsed.folders : undefined;
  if (!Array.isArray(folders) || folders.length === 0) {
    throw new Error("ワークスペースに登録対象の folders がありません");
  }
  const locations = new Map<string, ProjectLocation>();
  for (const folder of folders) {
    if (folder === null || typeof folder !== "object") throw new Error("ワークスペースの folders が不正です");
    let folderPath: string;
    if (typeof folder.path === "string" && folder.path.trim() !== "") {
      folderPath = path.resolve(path.dirname(workspacePath), folder.path);
    } else if (typeof folder.uri === "string") {
      try {
        folderPath = fileURLToPath(folder.uri);
      } catch {
        throw new Error("ローカルの file: URI 以外のワークスペースは登録できません");
      }
    } else {
      throw new Error("ワークスペースのフォルダパスが不正です");
    }
    // 全フォルダを先に検証し、壊れた workspace の途中まで hooks を書くことを避ける。
    if (!fs.statSync(folderPath).isDirectory()) throw new Error("ワークスペースの参照先がフォルダではありません");
    locations.set(normalizePath(folderPath), { path: folderPath, workspacePath });
  }
  return [...locations.values()];
}
