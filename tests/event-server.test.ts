/**
 * event-server の統合テスト（HTTP 擬似注入。verification.md 3.4 / 5 章「統合」枠, NFR-04）。
 * curl の代わりに fetch で 127.0.0.1 の実ソケットへ POST する（同一プロトコル・同一パス）。
 */
import * as http from "http";
import { afterEach, describe, expect, it } from "vitest";
import { createEventServer, rejectReason, type EventServer } from "../src/main/event-server";
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }), // session_id / cwd なし
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("未知の hook_event_name は 400 で破棄される（design.md 4.8）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SomethingElse", session_id: "s", cwd: "c" }),
    });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("ブラウザ発（Origin ヘッダ付き）は 403 で拒否し onEvent に届かない（260916_3: CSRF）", async () => {
    const base = await startServer();
    const body = JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "C:\\dev\\x" });
    const res = await fetch(`${base}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body,
    });
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("Content-Type が application/json 以外（text/plain の simple request）は 415 で拒否（260916_3）", async () => {
    const base = await startServer();
    const body = JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "C:\\dev\\x" });
    expect((await fetch(`${base}/terminal-app/event`, { method: "POST", body })).status).toBe(415); // fetch 既定 = text/plain
    expect((await fetch(`${base}/terminal-app/event`, { method: "POST", headers: { "Content-Type": "text/plain" }, body })).status).toBe(415);
    expect(received).toHaveLength(0);
    // charset 付きは受理
    const ok = await fetch(`${base}/terminal-app/event`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body });
    expect(ok.status).toBe(204);
    expect(received).toHaveLength(1);
  });

  it("Host が loopback 以外（DNS リバインディング）は 403（260916_3）", async () => {
    // fetch は Host ヘッダを上書きできない（禁止ヘッダ）ので http.request で送る
    const base = await startServer();
    const port = Number(new URL(base).port);
    const body = JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "C:\\dev\\x" });
    const postWithHost = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/terminal-app/event", method: "POST", headers: { "Content-Type": "application/json", Host: host, "Content-Length": Buffer.byteLength(body) } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end(body);
      });
    expect(await postWithHost("attacker-rebind.example.com")).toBe(403);
    expect(await postWithHost("attacker-rebind.example.com:41321")).toBe(403);
    expect(received).toHaveLength(0);
    expect(await postWithHost("localhost:1")).toBe(204);
    expect(await postWithHost("127.0.0.1")).toBe(204);
    expect(received).toHaveLength(2);
  });

  it("rejectReason: 判定の単体（Origin → 403、Host → 403、Content-Type → 415、curl 相当は受理）", () => {
    const ok = { host: "127.0.0.1:41321", "content-type": "application/json" };
    expect(rejectReason(ok)).toBe(null);
    expect(rejectReason({ ...ok, origin: "null" })?.status).toBe(403);
    expect(rejectReason({ ...ok, host: "[::1]:41321" })).toBe(null);
    expect(rejectReason({ ...ok, host: "evil.example.com:41321" })?.status).toBe(403);
    expect(rejectReason({ ...ok, host: undefined })?.status).toBe(403);
    expect(rejectReason({ ...ok, "content-type": "text/plain;charset=UTF-8" })?.status).toBe(415);
    expect(rejectReason({ ...ok, "content-type": "application/jsonx" })?.status).toBe(415);
    expect(rejectReason({ host: "localhost", "content-type": undefined })?.status).toBe(415);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-err", cwd: "C:\\dev\\x", reason: "other" }),
    });
    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].reason).toBe("other");
  });
});
