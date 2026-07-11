/**
 * 260712 課題C: ポート決定ロジック（config.json → 実 bind）とエラー表示の一致のテスト。
 *
 * 実障害（スクリーンショット 20260711233717）: ダイアログは「ポート 41999」を表示しながら
 * 実際の bind 失敗は EADDRINUSE 127.0.0.1:41321 だった。表示に設定値を使い、bind に別経路の
 * 値（load 前の既定ポート）を使っていたことが原因（bug-audit #14）。表示は
 * 「実際に bind を試みたポート」（err.port → EventServer.targetPort）を正とする。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildListenErrorText, createEventServer, resolveAttemptedPort, type EventServer } from "../src/main/event-server";
import { ProjectStore } from "../src/main/project-store";

const servers: EventServer[] = [];
const tmpDirs: string[] = [];

function makeServer(port: number): EventServer {
  const server = createEventServer({ port, onEvent: () => undefined });
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("config.json の port → 実 bind の一致（ポート決定フロー）", () => {
  it("config.json の port 値で listen し、targetPort・実 bind ポートが一致する", async () => {
    // 空きポートを実測で確保（固定ポートを避けテストを安定させる）
    const probe = makeServer(0);
    const freePort = (await probe.listen()).port;
    await probe.close();

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-port-test-"));
    tmpDirs.push(dataDir);
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ version: 1, port: freePort, theme: "auto", alwaysOnTopDefault: false, notifySound: { enabled: false } }),
      "utf8"
    );
    const store = new ProjectStore(dataDir);
    store.load();
    expect(store.config.port).toBe(freePort); // config.json の値が読めている

    // main の createAppEventServer と同じく load 後の config.port を渡す
    const server = makeServer(store.config.port);
    expect(server.targetPort).toBe(freePort); // 表示の正 = 実試行ポート
    const bound = await server.listen();
    expect(bound.port).toBe(freePort); // 実 bind も同じポート
  });

  it("port 0（空きポート委任）でも targetPort はオプション値を保持し、実 bind は address() で取れる", async () => {
    const server = makeServer(0);
    const bound = await server.listen();
    expect(server.targetPort).toBe(0);
    expect(bound.port).toBeGreaterThan(0);
    expect(server.address()?.port).toBe(bound.port);
  });
});

describe("EADDRINUSE: 表示ポート = 実際に bind を試みたポート", () => {
  it("使用中ポートへの listen は EADDRINUSE で失敗し、resolveAttemptedPort が実試行ポートを返す", async () => {
    const first = makeServer(0);
    const usedPort = (await first.listen()).port;

    const second = makeServer(usedPort);
    let caught: unknown = null;
    try {
      await second.listen();
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBe(null);
    expect((caught as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    // ダイアログに出すポートの解決: err.port（実試行値）が最優先で一致する
    expect(resolveAttemptedPort(caught, second.targetPort)).toBe(usedPort);
    expect(second.targetPort).toBe(usedPort); // フォールバック値も実試行ポートと一致
  });

  it("err.port が無いエラーでは fallback（targetPort）へフォールバックする", () => {
    expect(resolveAttemptedPort(new Error("何か別の失敗"), 41321)).toBe(41321);
    expect(resolveAttemptedPort(null, 41321)).toBe(41321);
    expect(resolveAttemptedPort({ port: "41999" }, 41321)).toBe(41321); // 非数値は無視
  });
});

describe("buildListenErrorText: EADDRINUSE のとき有効な対処を案内する", () => {
  function addrInUseError(port: number): NodeJS.ErrnoException {
    const e = new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`) as NodeJS.ErrnoException & {
      port?: number;
    };
    e.code = "EADDRINUSE";
    (e as { port?: number }).port = port;
    return e;
  }

  it("EADDRINUSE: 実試行ポートを表示し、二重起動・他プロセスの確認を案内する", () => {
    const err = addrInUseError(41321);
    const text = buildListenErrorText(err, resolveAttemptedPort(err, 41999));
    expect(text.body).toContain("ポート 41321"); // 実試行ポートが表示される（41999 ではない）
    expect(text.body).not.toContain("41999");
    expect(text.body).toContain("二重に起動していないか");
    expect(text.body).toContain('config.json の "port"');
    expect(text.status).toContain("41321");
  });

  it("EADDRINUSE 以外: 従来どおり port 変更の案内にフォールバックする", () => {
    const text = buildListenErrorText(new Error("EACCES"), 41321);
    expect(text.body).toContain("ポート 41321 を開けません");
    expect(text.body).toContain('config.json の "port"');
    expect(text.body).not.toContain("二重に起動");
  });
});
