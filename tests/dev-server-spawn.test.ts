/**
 * 開発サーバー機能（260722_1）の統合テスト（実プロセス）。
 * 認識合わせ対応「E2E = 統合テスト＋実機確認」の統合テスト側:
 * 実際に npm run dev で子プロセス（本物の HTTP サーバー）を起動し、
 * CP932 の日本語出力の読み取り → URL 検出 → HTTP 応答確認 → プロセスツリーごとの停止、
 * までを通しで検証する。onUrl は応答確認後にのみ発火する（死んだ URL を開かない関門）。
 */
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DevServerManager, type DevServerEvents } from "../src/main/dev-server";

// 「開発サーバー準備中です」（CP932。python cp932 で生成）
const CP932_BANNER = "8a4a94ad8354815b836f815b8f8094f5928682c582b7";

/**
 * CP932 で日本語バナーを出し、実際に HTTP を待ち受けて URL 行を出力し、
 * 生存中は heartbeat.txt を更新し続けるダミー開発サーバーを持つ一時プロジェクト
 */
function makeFixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devsrv-spawn-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "devsrv-spawn-fixture", version: "1.0.0", scripts: { dev: "node server.cjs" } })
  );
  const server = [
    'const fs = require("fs");',
    'const http = require("http");',
    `process.stdout.write(Buffer.from("${CP932_BANNER}", "hex"));`,
    'process.stdout.write(Buffer.from("\\n"));',
    'const srv = http.createServer((_req, res) => { res.end("ok"); });',
    'srv.listen(0, "127.0.0.1", () => {',
    "  const port = srv.address().port;",
    "  process.stdout.write(`Local: http://localhost:${port}/ ready\\n`);",
    "});",
    // 起動直後に 1 回即書きする（URL 検出が最初の interval より速く完了しても存在を保証）
    'fs.writeFileSync("heartbeat.txt", String(Date.now()));',
    'setInterval(() => { fs.writeFileSync("heartbeat.txt", String(Date.now())); }, 250);',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "server.cjs"), server);
  return dir;
}

interface Captured {
  lines: string[];
  url: Promise<string>;
  exits: Array<number | null>;
}

function makeEvents(): { events: DevServerEvents; captured: Captured } {
  const lines: string[] = [];
  const exits: Array<number | null> = [];
  let resolveUrl: (u: string) => void = () => undefined;
  const url = new Promise<string>((r) => {
    resolveUrl = r;
  });
  return {
    captured: { lines, url, exits },
    events: {
      onUrl: (_id, u) => resolveUrl(u),
      onUrlTimeout: () => undefined,
      onExit: (_id, code) => {
        exits.push(code);
      },
      onLine: (_id, line) => {
        lines.push(line);
      },
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`${label} が ${ms}ms 以内に完了しません`)), ms)),
  ]);
}

/** URL へ HTTP GET してステータスコードを返す（onUrl 後は必ず応答するはず） */
function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP timeout"));
    });
    req.on("error", reject);
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows はプロセス残存中の削除に失敗しうる。一時領域なので放置してよい */
    }
  }
});

describe("DevServerManager: 実プロセスの起動 → CP932 読み取り → URL 検出 → 応答確認 → 停止", () => {
  it(
    "npm run dev で本物の HTTP サーバーを起動し、CP932 ログの読み取り・応答確認済み URL の通知・プロセスツリー停止まで通る",
    async () => {
      const dir = makeFixtureProject();
      tmpDirs.push(dir);
      const { events, captured } = makeEvents();
      const manager = new DevServerManager(events);
      cleanups.push(() => manager.stopAll());

      const result = manager.start({ id: "p-test", path: dir });
      expect(result.ok).toBe(true);
      expect(result.scriptName).toBe("dev");
      expect(manager.isRunning("p-test")).toBe(true);

      // URL 検出（onUrl は HTTP 応答確認後にのみ発火する）
      const url = await withTimeout(captured.url, 25_000, "URL 検出");
      expect(url).toMatch(/^http:\/\/localhost:\d+\/$/);
      expect(manager.get("p-test")?.url).toBe(url);
      // onUrl 済みの URL は実際に開ける（応答確認の関門が機能している）
      expect(await httpGet(url)).toBe(200);

      // CP932 の日本語バナーが文字化けせずログ行として届いていること
      expect(captured.lines).toContain("開発サーバー準備中です");

      // 停止: プロセスツリーごと止まる（heartbeat の更新が完全に止まることで裏取り）
      const heartbeat = path.join(dir, "heartbeat.txt");
      expect(fs.existsSync(heartbeat)).toBe(true);
      const stopResult = await manager.stop("p-test");
      expect(stopResult.ok).toBe(true);
      expect(manager.isRunning("p-test")).toBe(false);
      const mtimeAfterStop = fs.statSync(heartbeat).mtimeMs;
      await new Promise((r) => setTimeout(r, 1200));
      expect(fs.statSync(heartbeat).mtimeMs).toBe(mtimeAfterStop);

      // stop() 経由の終了では onExit（想定外終了の通知）を発火しない
      expect(captured.exits).toEqual([]);
    },
    40_000
  );

  it(
    "多重起動は拒否する（1 プロジェクト 1 サーバー）",
    async () => {
      const dir = makeFixtureProject();
      tmpDirs.push(dir);
      const { events } = makeEvents();
      const manager = new DevServerManager(events);
      cleanups.push(() => manager.stopAll());

      expect(manager.start({ id: "p-dup", path: dir }).ok).toBe(true);
      const second = manager.start({ id: "p-dup", path: dir });
      expect(second.ok).toBe(false);
      expect(second.error).toContain("既に起動中");

      const stopResult = await manager.stop("p-dup");
      expect(stopResult.ok).toBe(true);
    },
    40_000
  );

  it("起動していないプロジェクトの停止・スクリプト未検出の起動はエラーを返す", async () => {
    const { events } = makeEvents();
    const manager = new DevServerManager(events);
    const stopResult = await manager.stop("p-none");
    expect(stopResult.ok).toBe(false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devsrv-empty-"));
    tmpDirs.push(dir);
    const startResult = manager.start({ id: "p-empty", path: dir });
    expect(startResult.ok).toBe(false);
    expect(startResult.error).toContain("スクリプト");
  });
});
