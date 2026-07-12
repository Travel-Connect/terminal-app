/**
 * 通知要否の判定（260712_5）。electron 非依存の純粋関数として切り出し、
 * Notification 呼び出し自体をモックせずに単体テストできるようにする
 * （src/main/app-restart.ts で確立した「ロジック抽出＋DI」パターンを踏襲）。
 */
import type { SessionState } from "../shared/types";

/** トースト通知の対象となる状態（完了・確認待ち） */
export const NOTIFIABLE_STATES = new Set<SessionState>(["done", "confirm"]);

/**
 * セッションの状態遷移に対して通知を出すべきか判定する。
 * - newState が対象外状態なら通知しない。
 * - prevState と newState が異なるときのみ通知する（同一状態への再遷移は抑制 = 過剰通知防止）。
 * - prevState === undefined（このセッションをまだ一度も見ていない）は遷移とみなし通知する。
 */
export function shouldNotify(prevState: SessionState | undefined, newState: SessionState): boolean {
  if (!NOTIFIABLE_STATES.has(newState)) return false;
  return newState !== prevState;
}
