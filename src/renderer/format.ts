/**
 * ③ UI の表示整形 純関数（renderer.ts から切り出し。DOM 非依存のため Vitest で単体テスト可能）。
 * 対応設計: design.md 5.1（経過時間・相対時刻の表示規則）／6.1（ステータスバーの 0 件省略）。
 * 前ループ evaluator 指摘（renderer 表示純関数のテスト未カバー）への対応として分離した。
 */
import type { StatusCounts } from "../shared/types";

/** 実行中の経過時間 h:mm:ss（モック 1a: 1:24:01。design.md 5.1 / 6.2） */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 相対時刻（design.md 5.1: 1 分未満は「たった今」。以降は分・時間・日単位） */
export function fmtRelative(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  return `${Math.floor(hr / 24)}日前`;
}

/**
 * ステータスバー表記（REQ-10 / design.md 6.1）。
 * 件数 0 の状態は省略する（面 1b の表記: 「8実行中 2完了 1確認待ち 1エラー / 12セッション」）。
 * 全状態 0 件のときは「{N} セッション」のみ（面 1a / 1c）。
 * counts は StateStore.counts（main 側）を正とし、本関数は整形のみを行う（重複実装の一本化）。
 */
export function fmtStatusCounts(counts: StatusCounts): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running}実行中`);
  if (counts.done > 0) parts.push(`${counts.done}完了`);
  if (counts.confirm > 0) parts.push(`${counts.confirm}確認待ち`);
  if (counts.error > 0) parts.push(`${counts.error}エラー`);
  return parts.length > 0 ? `${parts.join(" ")} / ${counts.total}セッション` : `${counts.total} セッション`;
}
