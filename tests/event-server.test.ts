/**
 * event-server の統合テスト（HTTP 擬似注入。verification.md 3.4 / 5 章「統合」枠, NFR-04）。
 * curl の代わりに fetch で 127.0.0.1 の実ソケットへ POST する（同一プロトコル・同一パス）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEventServer, type EventServer } from "../src/main/event-server";
import type { HookEvent } from "../src/main/state-store";

let server: EventServer | null = null;
let received: HookEvent[] = [];

async function startServer(): Promise<string> {
  received = [];
  server = createEventServer({
    port: 0, // 空きポートで起動（テストの安定性のため固定ポートを避ける）
    onEvent: (evt) => received.push(evt),
  });
  const addr = await server.listen();
  // NFR-04 / V-19: 127.0.0.1 のみにバインドしている
  expect(addr.host).toBe("127.0.0.1");
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("イベント受信サーバ（design.md 3.3 / 4.8 / 10 章）", () => {
  it("正しいイベント POST は 204 を返し onEvent が呼ばれる（V-13 / 3.4 の擬似注入経路）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop", session_id: "s-test-01", cwd: "C:\\dev\\sandbox-hook-test" }),
    });
    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].hook_event_name).toBe("Stop");
    expect(received[0].session_id).toBe("s-test-01");
  });

  it("不正 JSON は 400 で破棄され状態へ届かない（design.md 10 章）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json !!",
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("必須フィールド欠落は 400 で破棄される（design.md 4.8）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      body: JSON.stringify({ hook_event_name: "Stop" }), // session_id / cwd なし
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("未知の hook_event_name は 400 で破棄される（design.md 4.8）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      body: JSON.stringify({ hook_event_name: "SomethingElse", session_id: "s", cwd: "c" }),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("/terminal-app/event 以外のパスは 404（NFR-04 / design.md 10 章）", async () => {
    const base = await startServer();
    expect((await fetch(`${base}/`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/other`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("POST 以外のメソッドは 405", async () => {
    const base = await startServer();
    expect((await fetch(`${base}/terminal-app/event`)).status).toBe(405);
  });

  it("エラー相当イベント（SessionEnd + 異常 reason）も受理して onEvent へ渡す（V-16 の注入経路）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      body: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-err", cwd: "C:\\dev\\x", reason: "other" }),
    });
    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].reason).toBe("other");
  });
});
