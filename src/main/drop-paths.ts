/**
 * D&D ペイロードから登録候補のファイルパスを抽出する（260727_1）。
 * エクスプローラからのドロップは OS の File が付く（filePaths）が、
 * Cursor（VS Code 系）のエクスプローラからのドラッグは File が付かず、
 * DataTransfer の独自タイプにパスが入るため、優先順でフォールバック抽出する:
 *   1. filePaths（webUtils.getPathForFile で解決済みの実ファイル）
 *   2. codefiles（VS Code 系: 絶対パスの JSON 配列。最も正確）
 *   3. text/uri-list（file:// URI の改行区切り。# はコメント行）
 *   4. text/plain（絶対パスに見える行のみ。誤爆防止のため Windows 絶対パス限定）
 */
import { fileURLToPath } from "url";

export interface DropPayloadLike {
  filePaths?: string[];
  types?: string[];
  data?: Record<string, string>;
}

export type DropSource = "files" | "codefiles" | "uri-list" | "text-plain" | "none";

export interface ExtractedDrop {
  paths: string[];
  /** どの経路で抽出できたか（診断ログ用） */
  source: DropSource;
}

/** text/plain フォールバックで受け付ける形（Windows 絶対パスのみ。任意テキストの誤登録防止） */
const WIN_ABS = /^[A-Za-z]:[\\/]/;

function fromCodeFiles(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  } catch {
    return []; // JSON でない・IPC 送信時の切り詰めで壊れた場合は次の経路へ
  }
}

function fromUriList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith("file:")) continue; // vscode-remote:// 等のローカルでない URI はスキップ
    try {
      out.push(fileURLToPath(line));
    } catch {
      /* 変換不能な URI はスキップ */
    }
  }
  return out;
}

function fromPlainText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => WIN_ABS.test(l));
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function extractDropPaths(payload: DropPayloadLike): ExtractedDrop {
  const filePaths = payload.filePaths ?? [];
  if (filePaths.length > 0) return { paths: dedupe(filePaths), source: "files" };

  // DataTransfer のタイプ名は Chromium 側で小文字化される（"CodeFiles" → "codefiles"）ため寄せて引く
  const data = new Map<string, string>();
  for (const [k, v] of Object.entries(payload.data ?? {})) data.set(k.toLowerCase(), v);

  const code = fromCodeFiles(data.get("codefiles") ?? "");
  if (code.length > 0) return { paths: dedupe(code), source: "codefiles" };

  const uris = fromUriList(data.get("text/uri-list") ?? data.get("application/vnd.code.uri-list") ?? "");
  if (uris.length > 0) return { paths: dedupe(uris), source: "uri-list" };

  const plain = fromPlainText(data.get("text/plain") ?? "");
  if (plain.length > 0) return { paths: dedupe(plain), source: "text-plain" };

  return { paths: [], source: "none" };
}
