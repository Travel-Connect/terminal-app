/** 既定ポート（design.md 3.3。config.json で変更可） */
export const DEFAULT_PORT = 41321;

/** イベント受信パス（design.md 3.3 / 10 章: これ以外のパスは 404） */
export const EVENT_PATH = "/terminal-app/event";

/**
 * hooks 識別マーカー（design.md 4.1。2026-07-11 改訂）。
 * command 文字列にイベント送信 URL パス `/terminal-app/event` を含むエントリを
 * 「自アプリが追記したもの」と判定する。
 * 旧判定（`terminal-app` の部分一致）は、ユーザー自身の hook コマンドが本リポジトリの
 * パス等（例: `...\dev\terminal-app\scripts\notify.js`）を含む場合に誤除去しうるため
 * URL パス一致へ厳格化した。既設エントリの command は URL を含むため互換（design.md 4.1/4.2）。
 */
export const HOOK_MARKER = EVENT_PATH;

/** 受信ボディ上限（防御的措置。hooks の stdin JSON はごく小さい） */
export const MAX_BODY_BYTES = 256 * 1024;
