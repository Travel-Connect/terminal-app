/**
 * TypeSafe AI の System One Model「Jev」呼び出し（260922_2）。
 *
 * Jev は文章を生成せず、state（文字列）と型付きの質問（noul = yes の確率 / choice / score）に
 * 確率付きの判断だけを返す。本アプリでは「ハーネスの制御層の門番」としてだけ使う:
 * 制御フロー・閾値・副作用はすべてコード側（jev-judge.ts / index.ts）が持ち、Jev には
 * 「詳しい人が数秒で下せる勘どころの判断」を小さく分けて聞く。
 *
 * 設計方針:
 * - 失敗は常に「判定なし（null）」へ倒す。キー無し・ネットワーク断・タイムアウト・形式不正のどれでも
 *   既存の表示ロジック（hook / transcript / 登録簿ベース）はそのまま動く（追加層であって置き換えではない）
 * - 認証: env TYPESAFE_API_KEY → 無ければ %USERPROFILE%/.typesafe.env の `TYPESAFE_API_KEY=...` 行
 *   （run-firecrawl-obsidian の jev_classify.py と同じ規則）。キー文字列はログに出さない
 * - モデルは既定 `jev-latest`。閾値を調整したらバージョンを固定できるよう env TERMINAL_APP_JEV_MODEL で差し替え可
 * - env TERMINAL_APP_JEV=off で全判定を無効化（キーがあっても呼ばない）
 * - 送信する state は呼び出し側が transcript の抜粋に絞る（context rot 対策・送信データの最小化）
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LoggerLike } from "./logger";

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
/** 1 判定あたりの待ち時間上限。日本からは 1 判定 300ms 前後〜の報告（Obsidian ノート）。余裕を持って 4 秒 */
export const DEFAULT_JEV_TIMEOUT_MS = 4_000;

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };

export type JevAnswers = Record<string, JevAnswer>;

export interface JevClientOptions {
  apiKey: string | null;
  /** fetch 互換（テストで差し替え）。省略時は globalThis.fetch（Node 22 / Electron 組み込み） */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  logger?: LoggerLike;
}

export interface JevClient {
  /** キーがあり無効化されていないか。false のときは judge が常に null を返す（呼び出し側の早期分岐用） */
  readonly available: boolean;
  readonly model: string;
  /**
   * 1 リクエストで複数の質問を同じ state に対して並列評価する。
   * 失敗（キー無し・HTTP エラー・タイムアウト・形式不正）は null。例外は投げない
   */
  judge(state: string, questions: Record<string, JevQuestion>): Promise<JevAnswers | null>;
}

/**
 * API キーの取得: env → %USERPROFILE%/.typesafe.env。見つからなければ null。
 * readFile を差し替えられるようにしてテストする（実ファイルに触れない）
 */
export function loadTypesafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
  homeDirs: readonly (string | undefined)[] = [env.USERPROFILE, env.HOME, os.homedir()],
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")
): string | null {
  const fromEnv = (env.TYPESAFE_API_KEY ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  for (const base of homeDirs) {
    if (base === undefined || base === "") continue;
    let text: string;
    try {
      text = readFile(path.join(base, ".typesafe.env"));
    } catch {
      continue;
    }
    for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("TYPESAFE_API_KEY=")) continue;
      const value = line.slice("TYPESAFE_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  }
  return null;
}

/** env による無効化（TERMINAL_APP_JEV=off / 0 / false）。既定は有効 */
export function jevDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.TERMINAL_APP_JEV ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/** 応答 JSON の answers を型どおりに検証して取り出す（壊れた要素は捨てる。全滅なら null） */
export function parseJevAnswers(body: unknown): JevAnswers | null {
  if (body === null || typeof body !== "object") return null;
  const answers = (body as { answers?: unknown }).answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return null;
  const out: JevAnswers = {};
  for (const [key, raw] of Object.entries(answers as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul)) {
      out[key] = { type: "noul", noul: a.noul };
    } else if (a.type === "choice" && typeof a.choice === "string" && a.probabilities !== null && typeof a.probabilities === "object") {
      const probs: Record<string, number> = {};
      for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) if (typeof v === "number") probs[k] = v;
      out[key] = { type: "choice", choice: a.choice, probabilities: probs, confidence: typeof a.confidence === "number" ? a.confidence : 0 };
    } else if (a.type === "score" && typeof a.score === "number") {
      out[key] = { type: "score", score: a.score, confidence: typeof a.confidence === "number" ? a.confidence : 0 };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function createJevClient(opts: JevClientOptions): JevClient {
  const apiKey = opts.apiKey;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_JEV_MODEL;
  const logger = opts.logger;
  const available = apiKey !== null && apiKey !== "" && typeof fetchImpl === "function";
  /** 連続失敗時にログが溢れないよう、同じ理由の警告は 1 分に 1 回だけ */
  const lastWarnAt = new Map<string, number>();
  const warn = (kind: string, msg: string): void => {
    const now = Date.now();
    if ((lastWarnAt.get(kind) ?? 0) + 60_000 > now) return;
    lastWarnAt.set(kind, now);
    logger?.warn(`Jev: ${msg}`);
  };

  return {
    available,
    model,
    async judge(state, questions) {
      if (!available) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(JEV_API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state, model, questions }),
          signal: controller.signal,
        });
        if (!res.ok) {
          warn(`http-${res.status}`, `API が HTTP ${res.status} を返却（判定なしとして続行）`);
          return null;
        }
        const parsed = parseJevAnswers(await res.json());
        if (parsed === null) warn("shape", "応答の形式が想定外（判定なしとして続行）");
        return parsed;
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        warn(aborted ? "timeout" : "network", aborted ? `タイムアウト（${timeoutMs}ms。判定なしとして続行）` : `呼び出し失敗（判定なしとして続行）: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 判定を丸ごと無効にしたクライアント（デモ・env off・キー無し） */
export const nullJevClient: JevClient = {
  available: false,
  model: DEFAULT_JEV_MODEL,
  judge: async () => null,
};
