/**
 * 260712_3 案A: /terminal-app/statusline エンドポイントのテスト。
 * レスポンス本文が curl 経由でそのままターミナルの statusline 表示になるため、
 * 200 + テキスト本文（UTF-8）で返ることが要点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEventServer, type EventServer } from "../src/main/event-server";
import { STATUSLINE_PATH } from "../src/main/constants";

let server: EventServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(onStatusLine?: (payload: unknown) => string | null): Promise<number> {
  server = createEventServer({ port: 0, onEvent: () => undefined, onStatusLine });
  const addr = await server.listen();
  return addr.port;
}

async function post(port: number, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${STATUSLINE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("POST /terminal-app/statusline", () => {
  it("整形テキストを 200 で返す（= curl がそのまま statusline に表示する）", async () => {
    const port = await start((payload) => {
      const p = payload as { session_id?: string };
      return p.session_id === "s1" ? "↓ 70.5k tokens · thinking xhigh" : null;
    });
    const res = await post(port, JSON.stringify({ session_id: "s1" }));
    expect(res.status).toBe(200);
    expect(res.text).toBe("↓ 70.5k tokens · thinking xhigh");
  });

  it("表示テキスト無し（null）は 204・本文なし", async () => {
    const port = await start(() => null);
    const res = await post(port, JSON.stringify({ session_id: "unknown" }));
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("不正 JSON は 400 で破棄する", async () => {
    const port = await start(() => "should not reach");
    const res = await post(port, "{broken");
    expect(res.status).toBe(400);
  });

  it("onStatusLine 未指定なら statusline パスは 404（既存構成の互換）", async () => {
    const port = await start(undefined);
    const res = await post(port, JSON.stringify({ session_id: "s1" }));
    expect(res.status).toBe(404);
  });

  it("既存の /terminal-app/event ルートには影響しない", async () => {
    let received = false;
    server = createEventServer({
      port: 0,
      onEvent: () => {
        received = true;
      },
      onStatusLine: () => "text",
    });
    const addr = await server.listen();
    const res = await fetch(`http://127.0.0.1:${addr.port}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "C:\\dev\\x" }),
    });
    expect(res.status).toBe(204);
    expect(received).toBe(true);
  });
});
