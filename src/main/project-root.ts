/**
 * ドロップされたパスからプロジェクトルートを解決する（260727_1 / 260729 改定）。
 * - ディレクトリのドロップ・フォルダ選択はユーザーが対象を明示している → そのまま登録する。
 *   祖先探索すると、複数プロジェクトを束ねる親フォルダ（例: 開発案件/ の .claude）に
 *   吸われて親が登録される誤動作になる（260729 実障害）。
 * - ファイルのドロップのみ、祖先方向にプロジェクトの目印（.claude / .git）を探して
 *   ルートに読み替える（プロジェクト内のファイルをつかんでも正しく登録するため）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizePath } from "./state-store";

/** テスト差し替え用の最小 fs インターフェース */
export interface FsLike {
  statSync(p: string): { isDirectory(): boolean };
  existsSync(p: string): boolean;
}

export interface ResolveOptions {
  fsLike?: FsLike;
  /**
   * 探索の上限ディレクトリ（既定 = ホームディレクトリ）。この階層以上はマーカー判定しない。
   * ホームには ~/.claude がほぼ必ず存在するため、上限なしで遡るとマーカー無しのパスが
   * すべてホーム＝プロジェクト扱いになってしまう（ホームへの hooks 追記は全セッションに波及する）
   */
  stopDir?: string;
}

/** プロジェクトルートの目印。いずれかを持つ最も近い祖先ディレクトリをルートとみなす */
export const ROOT_MARKERS = [".claude", ".git"] as const;

/**
 * ドロップパス → 登録すべきプロジェクトルート。
 * - ディレクトリはそれ自身を返す（祖先探索しない。260729 改定）
 * - ファイルは親ディレクトリを起点に、stopDir（既定 = ホーム）の手前まで遡り、
 *   最初に目印が見つかったディレクトリを返す。目印が無ければ親を返す
 * - パスが存在しなければ null（呼び出し側で元パスのまま検証エラーに落とす）
 */
export function resolveProjectRoot(droppedPath: string, opts: ResolveOptions = {}): string | null {
  const fsLike = opts.fsLike ?? fs;
  const stop = normalizePath(opts.stopDir ?? os.homedir());
  let isDir: boolean;
  try {
    isDir = fsLike.statSync(droppedPath).isDirectory();
  } catch {
    return null;
  }
  if (isDir) return droppedPath;
  const start = path.dirname(droppedPath);
  for (let cur = start; ; ) {
    if (normalizePath(cur) === stop) break; // 上限に到達（ホーム自身はマーカー判定しない）
    if (ROOT_MARKERS.some((m) => fsLike.existsSync(path.join(cur, m)))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break; // ドライブルートに到達
    cur = parent;
  }
  return start;
}
