/**
 * ① イベント受信サーバ（design.md 3.1 / 3.3 / 4.8 / 10 章, NFR-04）。
 * - 127.0.0.1 のみバインド（外部公開しない）
 * - POST /terminal-app/event（hooks）と POST /terminal-app/statusline（260712_3 案A）を受理。
 *   他パスは 404、他メソッドは 405
 * - 不正 JSON・スキーマ不一致は 400 で破棄しログのみ（UI は変えない）
 */
import * as http from "http";
import { EVENT_PATH, MAX_BODY_BYTES, STATUSLINE_PATH } from "./constants";
import type { LoggerLike } from "./logger";
import { nullLogger } from "./logger";
import type { HookEvent } from "./state-store";
import { validateEvent } from "./state-store";

export interface EventServerOptions {
  port: number;
  host?: string;
  onEvent: (evt: HookEvent, receivedAt: number) => void;
  /**
   * statusLine JSON 受信時のコールバック（260712_3 案A）。
   * 戻り値の文字列がレスポンス本文になり、curl 経由でそのままターミナルの
   * statusline 表示になる（null = 表示なし・204）。未指定なら STATUSLINE_PATH は 404。
   */
  onStatusLine?: (payload: unknown) => string | null;
  logger?: LoggerLike;
}

export interface EventServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
  /**
   * listen が bind を試みるポート（= EventServerOptions.port）。
   * listen 失敗時のエラー表示はこの値（または err.port）を正とする（260712 課題C:
   * 設定値を表示に使うと実試行ポートとズレうる — 表示 41999 / 実 bind 41321 の実績あり）。
   */
  readonly targetPort: number;
}

/**
 * listen 失敗エラーから「実際に bind を試みたポート」を解決する（260712 課題C）。
 * Node の listen 系エラー（EADDRINUSE 等）は err.port に実試行ポートを持つためそれを最優先し、
 * 無ければ fallbackPort（EventServer.targetPort）を使う。
 */
export function resolveAttemptedPort(err: unknown, fallbackPort: number): number {
  if (err !== null && typeof err === "object") {
    const port = (err as { port?: unknown }).port;
    if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
  }
  return fallbackPort;
}

/**
 * listen 失敗時のユーザー向け文言（260712 課題C）。
 * EADDRINUSE は「ポート変更」ではなく実際に有効な対処（二重起動・他プロセスの確認）を先に案内する。
 */
export function buildListenErrorText(err: unknown, attemptedPort: number): { title: string; body: string; status: string } {
  const isAddrInUse = err !== null && typeof err === "object" && (err as { code?: unknown }).code === "EADDRINUSE";
  const title = "受信ポートを開けません";
  const body = isAddrInUse
    ? `ポート ${attemptedPort} は別のプロセスが使用中です。\n` +
      `本アプリを二重に起動していないか確認してください。別のアプリがポート ${attemptedPort} を使用している場合は、\n` +
      `%APPDATA%\\terminal-app\\config.json の "port" を空いている番号に変更して再起動してください。\n\n詳細: ${String(err)}`
    : `ポート ${attemptedPort} を開けません。\n` +
      `%APPDATA%\\terminal-app\\config.json の "port" を変更して再起動してください。\n\n詳細: ${String(err)}`;
  const status = isAddrInUse
    ? `受信ポート ${attemptedPort} は使用中です（二重起動または他プロセスを確認してください）`
    : `受信ポート ${attemptedPort} を開けません（config.json の "port" を変更して再起動してください）`;
  return { title, body, status };
}

/** 受け付ける Host（ポート部は無視）。hooks / statusLine の curl は 127.0.0.1 宛てで送る */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 送信元の検証（260916_3 / NFR-04 の補強）。127.0.0.1 バインドだけでは、ブラウザで開いた任意の Web ページの JS が
 * `fetch("http://127.0.0.1:41321/…", {method:"POST", body})`（text/plain = preflight なし）で到達できる。
 * - Origin ヘッダがある = ブラウザ発（curl は付けない）→ 403
 * - Host が loopback 以外（DNS リバインディング）→ 403
 * - Content-Type が application/json 以外（simple request）→ 415
 * 戻り値 null = 受理
 */
export function rejectReason(headers: http.IncomingHttpHeaders): { status: number; text: string } | null {
  if (headers.origin !== undefined) return { status: 403, text: "forbidden: browser origin" };
  const rawHost = (Array.isArray(headers.host) ? headers.host[0] : headers.host) ?? "";
  const hostName = rawHost.replace(/:\d+$/, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(hostName)) return { status: 403, text: "forbidden: host" };
  const ct = (Array.isArray(headers["content-type"]) ? headers["content-type"][0] : headers["content-type"]) ?? "";
  if (!/^application\/json\s*(;|$)/i.test(ct.trim())) return { status: 415, text: "unsupported media type: application/json required" };
  return null;
}

export function createEventServer(opts: EventServerOptions): EventServer {
  const host = opts.host ?? "127.0.0.1";
  const logger = opts.logger ?? nullLogger;

  function respond(res: http.ServerResponse, status: number, text: string, headers?: http.OutgoingHttpHeaders): void {
    res.writeHead(status, { "Content-Type": "text/plain", ...headers });
    res.end(text);
  }

  /** ボディ確定後の処理: JSON パース → スキーマ検証 → onEvent（design.md 4.8 / 10 章） */
  function handleBody(body: string, receivedAt: number, res: http.ServerResponse): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // design.md 10 章: 受信 JSON が不正 → 破棄してログ記録（UI は変えない）。
      // 本文はログに残さない（prompt に貼られた鍵などが混入しうる。260916_3）
      logger.warn(`event-server: 不正 JSON を破棄 (${Buffer.byteLength(body, "utf8")} bytes)`);
      respond(res, 400, "invalid json");
      return;
    }
    const v = validateEvent(parsed);
    if (!v.ok) {
      logger.warn(`event-server: スキーマ不一致を破棄: ${v.error}`);
      respond(res, 400, v.error);
      return;
    }
    opts.onEvent(v.event, receivedAt);
    res.writeHead(204);
    res.end();
  }

  /**
   * statusLine ボディの処理（260712_3 案A）: JSON パース → onStatusLine。
   * 戻り値のテキストを 200 で返す（curl がそのまま statusline 表示に使う）。
   * hooks と違い高頻度（最大 300ms 間隔）のため、不正 JSON のログは残さず 400 のみ。
   */
  function handleStatusLineBody(body: string, res: http.ServerResponse): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      respond(res, 400, "invalid json");
      return;
    }
    const text = opts.onStatusLine?.(parsed) ?? null;
    if (text === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    respond(res, 200, text, { "Content-Type": "text/plain; charset=utf-8" });
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? "").split("?")[0];
    const isStatusLine = url === STATUSLINE_PATH && opts.onStatusLine !== undefined;
    if (url !== EVENT_PATH && !isStatusLine) {
      respond(res, 404, "not found");
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, "method not allowed", { Allow: "POST" });
      return;
    }
    const rejected = rejectReason(req.headers);
    if (rejected !== null) {
      // ブラウザ経由の偽イベント（CSRF / DNS リバインディング）を弾く（260916_3）。hooks の curl はこの条件をすべて満たす
      logger.warn(`event-server: 送信元を拒否 (${rejected.status} ${rejected.text})`);
      respond(res, rejected.status, rejected.text);
      req.resume(); // 本文は読み捨てる
      return;
    }
    // チャンク境界でマルチバイト文字（日本語 message 等）が割れないよう、
    // Buffer のまま蓄積して end で一括デコードする
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        logger.warn(`event-server: ボディが上限超過のため破棄 (${size} bytes)`);
        respond(res, 413, "payload too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString("utf8");
      if (isStatusLine) handleStatusLineBody(body, res);
      else handleBody(body, Date.now(), res);
    });
    req.on("error", (e) => {
      logger.warn(`event-server: リクエストエラー: ${String(e)}`);
    });
  }

  const server = http.createServer(handleRequest);
  // 滞留コネクションの上限（260916_3）: hooks の curl は数十 ms で送り切る。ヘッダ 5 秒・全体 10 秒で切る
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;

  let bound: { host: string; port: number } | null = null;

  return {
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        const onListenError = (err: Error): void => reject(err); // EADDRINUSE 等（design.md 10 章）
        server.once("error", onListenError);
        server.listen(opts.port, host, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            bound = { host: addr.address, port: addr.port };
            // listen 成功後は reject 用リスナーを外し、以降の実行時エラーはログのみに落とす
            // （settled 済み Promise への reject は無視され、リスナー不在の 'error' はプロセスを落とすため）
            server.removeListener("error", onListenError);
            server.on("error", (e) => logger.error(`event-server: サーバエラー: ${String(e)}`));
            logger.info(`event-server: listening on http://${addr.address}:${addr.port}${EVENT_PATH}`);
            resolve(bound);
          } else {
            reject(new Error("listen アドレスを取得できません"));
          }
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    address(): { host: string; port: number } | null {
      return bound;
    },
    targetPort: opts.port,
  };
}
