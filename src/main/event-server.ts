/**
 * ① イベント受信サーバ（design.md 3.1 / 3.3 / 4.8 / 10 章, NFR-04）。
 * - 127.0.0.1 のみバインド（外部公開しない）
 * - POST /terminal-app/event のみ受理。他パスは 404、他メソッドは 405
 * - 不正 JSON・スキーマ不一致は 400 で破棄しログのみ（UI は変えない）
 */
import * as http from "http";
import { EVENT_PATH, MAX_BODY_BYTES } from "./constants";
import type { LoggerLike } from "./logger";
import { nullLogger } from "./logger";
import type { HookEvent } from "./state-store";
import { validateEvent } from "./state-store";

export interface EventServerOptions {
  port: number;
  host?: string;
  onEvent: (evt: HookEvent, receivedAt: number) => void;
  logger?: LoggerLike;
}

export interface EventServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
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
      // design.md 10 章: 受信 JSON が不正 → 破棄してログ記録（UI は変えない）
      logger.warn(`event-server: 不正 JSON を破棄: ${body.slice(0, 200)}`);
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

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? "").split("?")[0];
    if (url !== EVENT_PATH) {
      respond(res, 404, "not found");
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, "method not allowed", { Allow: "POST" });
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
      handleBody(Buffer.concat(chunks).toString("utf8"), Date.now(), res);
    });
    req.on("error", (e) => {
      logger.warn(`event-server: リクエストエラー: ${String(e)}`);
    });
  }

  const server = http.createServer(handleRequest);

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
  };
}
