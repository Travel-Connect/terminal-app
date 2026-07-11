/**
 * event-server の UTF-8 チャンク境界の回帰テスト（bug-audit #1 の直接カバー）。
 * TCP チャンクがマルチバイト文字（日本語 message・絵文字）の途中で割れても
 * 文字化け（U+FFFD）せず原文どおり受信できることを、実ソケットの分割送信で検証する。
 * あわせてボディ上限超過（413 破棄）が onEvent へ届かないことも確認する。
 * （パス区切りはフォワードスラッシュ表記。受信サーバはパスの解釈をしないため等価）
 */
import * as http from "http";
import { afterEach, describe, expect, it } from "vitest";
import { createEventServer, type EventServer } from "../src/main/event-server";
import type { HookEvent } from "../src/main/state-store";

let server: EventServer | null = null;
let received: HookEvent[] = [];
let port = 0;

async function startServer(): Promise<void> {
  received = [];
  server = createEventServer({
    port: 0, // 空きポートで起動（テストの安定性のため固定ポートを避ける）
    onEvent: (evt) => received.push(evt),
  });
  const addr = await server.listen();
  port = addr.port;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

/**
 * ボディを splitAt バイト目で 2 分割し、間に 50ms 置いて別々の TCP 書き込みで POST する。
 * ループバックでも書き込み間隔があれば別セグメント = サーバ側で別 chunk として届くため、
 * チャンク境界がマルチバイト文字の途中に落ちるケースを決定的に再現できる。
 */
function postSplit(body: Buffer, splitAt: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/terminal-app/event",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.write(body.subarray(0, splitAt));
    setTimeout(() => req.end(body.subarray(splitAt)), 50);
  });
}

/** needle（マルチバイト文字）の 1 バイト目の直後 = 文字の途中で割れる分割位置を返す */
function splitInside(body: Buffer, needle: string): number {
  const idx = body.indexOf(Buffer.from(needle, "utf8"));
  expect(idx).toBeGreaterThan(0); // needle が本文に含まれている前提の確認
  return idx + 1;
}

describe("UTF-8 チャンク境界（bug-audit #1: Buffer 蓄積 → end で一括デコード）", () => {
  it("3 バイト文字（日本語）の途中でチャンクが割れても message が文字化けしない", async () => {
    await startServer();
    const message = "許可が必要です — Bash コマンドの実行を承認してください";
    const body = Buffer.from(
      JSON.stringify({ hook_event_name: "Notification", session_id: "s-mb-01", cwd: "C:/dev/sandbox", message }),
      "utf8"
    );
    const status = await postSplit(body, splitInside(body, "許"));
    expect(status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe(message); // 原文一致 = チャンク境界で壊れていない
    expect(received[0].message).not.toContain("�");
  });

  it("4 バイト文字（絵文字）の途中でチャンクが割れても message が文字化けしない", async () => {
    await startServer();
    const message = "デプロイ完了 🚀 確認してください";
    const body = Buffer.from(
      JSON.stringify({ hook_event_name: "Notification", session_id: "s-mb-02", cwd: "C:/dev/sandbox", message }),
      "utf8"
    );
    const status = await postSplit(body, splitInside(body, "🚀"));
    expect(status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe(message);
    expect(received[0].message).not.toContain("�");
  });

  it("cwd（日本語パス）の途中でチャンクが割れても原文どおり受信する", async () => {
    await startServer();
    const cwd = "C:/開発/在庫管理アプリ";
    const body = Buffer.from(
      JSON.stringify({ hook_event_name: "Stop", session_id: "s-mb-03", cwd }),
      "utf8"
    );
    const status = await postSplit(body, splitInside(body, "在"));
    expect(status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].cwd).toBe(cwd);
  });

  it("上限（256KB）超過のボディは 413 で破棄され onEvent へ届かない", async () => {
    await startServer();
    const huge = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s-huge",
      cwd: "C:/dev/x",
      message: "a".repeat(300 * 1024),
    });
    // サーバは上限超過時に 413 応答後 req.destroy() するため、クライアント側は
    // 413 応答を受け取れる場合と接続切断（ECONNRESET 等）になる場合の両方がありうる。
    // どちらでも「イベントが状態へ届かない」ことが要件（bug-audit #11 の採用挙動）。
    const outcome = await new Promise<{ status?: number; errored: boolean }>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/terminal-app/event", method: "POST" },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, errored: false }));
        }
      );
      req.on("error", () => resolve({ errored: true }));
      req.end(huge);
    });
    expect(outcome.errored || outcome.status === 413).toBe(true);
    expect(received).toHaveLength(0);
  });
});
