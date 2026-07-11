/**
 * statusLine 転送（260712_3 案A）: Claude Code の statusLine JSON から
 * 「↓ 70.5k tokens · thinking xhigh」相当の作業メトリクスを取り出して整形する。
 *
 * 入力スキーマは公式ドキュメント（code.claude.com/docs/en/statusline.md の Full JSON schema、
 * 2026-07-12 取得）に準拠:
 * - session_id: string
 * - context_window.total_output_tokens: number（現在のコンテキスト内の出力トークン。
 *   ターミナルのスピナー行の「↓ Nk tokens」に最も近い公式値）
 * - effort.level: "low"|"medium"|"high"|"xhigh"|"max"（対応モデルのみ存在）
 * - thinking.enabled: boolean
 * フィールドは欠落・null がありうるため、すべて任意として防御的に読む。
 */

export interface StatusMetrics {
  sessionId: string;
  outputTokens?: number;
  effortLevel?: string;
  thinkingEnabled?: boolean;
}

/** statusLine の stdin JSON → メトリクス。session_id が無い・形が違う場合は null（破棄） */
export function parseStatusLinePayload(payload: unknown): StatusMetrics | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.session_id !== "string" || p.session_id.trim() === "") return null;
  const m: StatusMetrics = { sessionId: p.session_id };

  const cw = p.context_window;
  if (cw !== null && typeof cw === "object" && !Array.isArray(cw)) {
    const out = (cw as Record<string, unknown>).total_output_tokens;
    if (typeof out === "number" && Number.isFinite(out) && out >= 0) m.outputTokens = out;
  }
  const effort = p.effort;
  if (effort !== null && typeof effort === "object" && !Array.isArray(effort)) {
    const level = (effort as Record<string, unknown>).level;
    if (typeof level === "string" && level.trim() !== "") m.effortLevel = level;
  }
  const thinking = p.thinking;
  if (thinking !== null && typeof thinking === "object" && !Array.isArray(thinking)) {
    const enabled = (thinking as Record<string, unknown>).enabled;
    if (typeof enabled === "boolean") m.thinkingEnabled = enabled;
  }
  return m;
}

/** トークン数の表示整形（ターミナル準拠: 70500 → 70.5k、999 以下はそのまま） */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * タイル・statusline 用の表示文字列。例: 「↓ 70.5k tokens · thinking xhigh」。
 * 出せる情報が何も無ければ undefined（表示しないフォールバック）。
 */
export function fmtStats(m: StatusMetrics): string | undefined {
  const parts: string[] = [];
  if (m.outputTokens !== undefined) parts.push(`↓ ${fmtTokens(m.outputTokens)} tokens`);
  if (m.thinkingEnabled === true) {
    parts.push(m.effortLevel !== undefined ? `thinking ${m.effortLevel}` : "thinking");
  } else if (m.effortLevel !== undefined) {
    parts.push(`effort ${m.effortLevel}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
