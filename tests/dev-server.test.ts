/**
 * 開発サーバー機能（260722_1）の単体テスト。
 * 認識合わせ対応: 起動スクリプトは dev → serve → start の順で自動検出（electron 除外）、
 * URL はサーバー出力から自動検出（CP932 対応）、未検出時はフレームワーク既定ポートへフォールバック。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeLine,
  detectDevScript,
  DevServerManager,
  findLocalUrl,
  guessDefaultPort,
  StreamLineDecoder,
  stripAnsi,
  type DevServerEvents,
} from "../src/main/dev-server";

/* ---------------- fixtures ---------------- */

const tmpDirs: string[] = [];

function makeProject(pkg: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devsrv-test-"));
  tmpDirs.push(dir);
  if (pkg !== undefined) {
    fs.writeFileSync(path.join(dir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  }
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 「ローカル: http://localhost:41999/ で起動しました」の CP932 バイト列（python cp932 で生成）
const CP932_URL_LINE =
  "838d815b834a838b3a20687474703a2f2f6c6f63616c686f73743a34313939392f2082c58b4e93ae82b582dc82b582bd";
// 「起動に失敗しました（ポート使用中）」の CP932 バイト列
const CP932_ERROR_LINE = "8b4e93ae82c98eb8947382b582dc82b582bd8169837c815b83678e6797709286816a";

/* ---------------- detectDevScript ---------------- */

describe("detectDevScript: 起動スクリプトの自動検出（dev → serve → start）", () => {
  it("dev を最優先で選ぶ（zaico-kanri-app 相当: dev と start が両方ある）", () => {
    const dir = makeProject({ scripts: { dev: "next dev", start: "next start" } });
    expect(detectDevScript(dir)).toEqual({ name: "dev", command: "next dev" });
  });

  it("dev が無ければ serve → start の順で選ぶ", () => {
    const dir = makeProject({ scripts: { serve: "vite preview", start: "node server.js" } });
    expect(detectDevScript(dir)).toEqual({ name: "serve", command: "vite preview" });
    const dir2 = makeProject({ scripts: { start: "node server.js" } });
    expect(detectDevScript(dir2)).toEqual({ name: "start", command: "node server.js" });
  });

  it("electron を含むコマンドは除外する（terminal-app 自身の start: electron . を誤起動しない）", () => {
    const dir = makeProject({ scripts: { start: "electron ." } });
    expect(detectDevScript(dir)).toBeNull();
    // electron スクリプトを飛ばして次の候補も探さない（dev → serve → start の順に評価して該当なし）
    const dir2 = makeProject({ scripts: { dev: "electron .", serve: "vite" } });
    expect(detectDevScript(dir2)).toEqual({ name: "serve", command: "vite" });
  });

  it("package.json が無い / 壊れている / scripts が無い場合は null（メニュー無効表示）", () => {
    expect(detectDevScript(makeProject(undefined))).toBeNull();
    expect(detectDevScript(makeProject("{ broken json"))).toBeNull();
    expect(detectDevScript(makeProject({ name: "x" }))).toBeNull();
    expect(detectDevScript(makeProject({ scripts: { dev: "   " } }))).toBeNull();
  });
});

/* ---------------- decodeLine / StreamLineDecoder ---------------- */

describe("decodeLine: CP932 / UTF-8 自動判別", () => {
  it("UTF-8 の日本語をそのまま復号する", () => {
    expect(decodeLine(Buffer.from("ローカル: 起動しました", "utf8"))).toBe("ローカル: 起動しました");
  });

  it("CP932 の日本語を文字化けなく復号する（Windows npm の日本語出力対策）", () => {
    expect(decodeLine(Buffer.from(CP932_URL_LINE, "hex"))).toBe(
      "ローカル: http://localhost:41999/ で起動しました"
    );
    expect(decodeLine(Buffer.from(CP932_ERROR_LINE, "hex"))).toBe("起動に失敗しました（ポート使用中）");
  });

  it("ASCII のみの行はどちらの経路でも同じ結果になる", () => {
    expect(decodeLine(Buffer.from("ready on http://localhost:3000", "utf8"))).toBe(
      "ready on http://localhost:3000"
    );
  });
});

describe("StreamLineDecoder: チャンク境界をまたぐ行の組み立て", () => {
  it("CRLF / LF 混在の複数行を正しく分割する", () => {
    const d = new StreamLineDecoder();
    const lines = d.push(Buffer.from("line1\r\nline2\nline3", "utf8"));
    expect(lines).toEqual(["line1", "line2"]);
    expect(d.flush()).toBe("line3");
  });

  it("多バイト文字の途中でチャンクが割れても文字化けしない（CP932）", () => {
    const d = new StreamLineDecoder();
    const full = Buffer.concat([Buffer.from(CP932_URL_LINE, "hex"), Buffer.from("\n")]);
    // 「ロ」(0x838d) の 1 バイト目と 2 バイト目の間で割る
    const first = d.push(full.subarray(0, 1));
    expect(first).toEqual([]);
    const rest = d.push(full.subarray(1));
    expect(rest).toEqual(["ローカル: http://localhost:41999/ で起動しました"]);
  });

  it("多バイト文字の途中でチャンクが割れても文字化けしない（UTF-8）", () => {
    const d = new StreamLineDecoder();
    const full = Buffer.from("起動しました\n", "utf8");
    d.push(full.subarray(0, 4)); // 「起」(3 バイト) + 「動」の 1 バイト目で割る
    const lines = d.push(full.subarray(4));
    expect(lines).toEqual(["起動しました"]);
  });

  it("flush は未改行の残りを返し、空なら null", () => {
    const d = new StreamLineDecoder();
    expect(d.flush()).toBeNull();
    d.push(Buffer.from("partial", "utf8"));
    expect(d.flush()).toBe("partial");
    expect(d.flush()).toBeNull();
  });
});

/* ---------------- stripAnsi / findLocalUrl ---------------- */

describe("stripAnsi: ANSI エスケープの除去", () => {
  it("色付き出力からエスケープだけを取り除く（Vite の起動ログ相当）", () => {
    const colored = "\x1b[32m➜\x1b[39m  Local: \x1b[36mhttp://localhost:5173/\x1b[39m";
    expect(stripAnsi(colored)).toBe("➜  Local: http://localhost:5173/");
  });

  it("ESC の無い普通の角かっこ表記（[dev] 等）は消さない", () => {
    expect(stripAnsi("[dev] listening on [::1]:3000 [ok]")).toBe("[dev] listening on [::1]:3000 [ok]");
  });
});

describe("findLocalUrl: 出力行からのローカル URL 検出", () => {
  it("Next.js 形式（- Local: http://localhost:3000）を検出する", () => {
    expect(findLocalUrl("   - Local:        http://localhost:3000")).toBe("http://localhost:3000/");
  });

  it("ANSI 色付き（Vite 形式）でも検出する", () => {
    const colored = "  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:5173/\x1b[39m";
    expect(findLocalUrl(colored)).toBe("http://localhost:5173/");
  });

  it("CP932 由来の日本語行に埋まった URL も検出する（デコード後の行）", () => {
    const line = decodeLine(Buffer.from(CP932_URL_LINE, "hex"));
    expect(findLocalUrl(line)).toBe("http://localhost:41999/");
  });

  it("0.0.0.0 / 127.0.0.1 はブラウザで開ける localhost に正規化する", () => {
    expect(findLocalUrl("listening on http://0.0.0.0:8080")).toBe("http://localhost:8080/");
    expect(findLocalUrl("ready http://127.0.0.1:4000/app")).toBe("http://localhost:4000/app");
  });

  it("URL が無い行・外部 URL の行は null", () => {
    expect(findLocalUrl("compiled successfully in 300ms")).toBeNull();
    expect(findLocalUrl("see https://nextjs.org/docs for help")).toBeNull();
  });

  it("ホスト名の前方一致では誤検出しない（レビュー指摘: localhost.example.com 等）", () => {
    expect(findLocalUrl("proxy to http://localhost.example.com/api")).toBeNull();
    expect(findLocalUrl("upstream http://127.0.0.1.evil.example/")).toBeNull();
    expect(findLocalUrl("host http://localhost-api.example.com/")).toBeNull();
  });
});

/* ---------------- DevServerManager の起動ガード ---------------- */

const NOOP_EVENTS: DevServerEvents = {
  onUrl: () => undefined,
  onUrlTimeout: () => undefined,
  onExit: () => undefined,
  onLine: () => undefined,
};

describe("DevServerManager: 終了処理との競合ガード", () => {
  it("stopAll 後の start は拒否する（アプリ終了中の起動でサーバーが残るのを防ぐ。レビュー指摘）", async () => {
    const manager = new DevServerManager(NOOP_EVENTS);
    await manager.stopAll();
    const dir = makeProject({ scripts: { dev: "node server.js" } });
    const result = manager.start({ id: "p-shutdown", path: dir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("終了処理中");
  });
});

/* ---------------- guessDefaultPort ---------------- */

describe("guessDefaultPort: URL 未検出時のフレームワーク既定ポート推測", () => {
  it("next → 3000 / vite → 5173（devDependencies も見る）", () => {
    expect(guessDefaultPort(makeProject({ dependencies: { next: "15.0.0" } }))).toBe(3000);
    expect(guessDefaultPort(makeProject({ devDependencies: { vite: "6.0.0" } }))).toBe(5173);
  });

  it("該当フレームワークが無い / package.json が無い場合は null", () => {
    expect(guessDefaultPort(makeProject({ dependencies: { express: "4.0.0" } }))).toBeNull();
    expect(guessDefaultPort(makeProject(undefined))).toBeNull();
  });
});
