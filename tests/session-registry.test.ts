/**
 * セッション登録簿（260904_1 #3）: ~/.claude/sessions/<pid>.json の解釈と生死分類。
 * 実測フォーマット（claude 2.1.259, 2026-09-04）を元にした入力で、
 * 「登録簿にあり PID 生存 → alive / 無い・PID 死亡 → dead / 登録簿なし → unknown」を確認する。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyLiveness,
  parseRegistryEntry,
  readSessionRegistry,
  registryDir,
  registryStatusOf,
} from "../src/main/session-registry";

const REAL_SAMPLE =
  '{"pid":102628,"sessionId":"71aa8b9e-0cf1-4b34-afe3-08d65ddf11d6","cwd":"C:/Users/hppym/dev/terminal-app",' +
  '"startedAt":1788466766834,"version":"2.1.259","kind":"interactive","entrypoint":"cli","status":"busy",' +
  '"name":"terminal-app-5a","nameSource":"derived"}';

describe("parseRegistryEntry", () => {
  it("実測フォーマットから pid / sessionId / cwd / status / kind / entrypoint を取り出す", () => {
    expect(parseRegistryEntry(REAL_SAMPLE)).toEqual({
      pid: 102628,
      sessionId: "71aa8b9e-0cf1-4b34-afe3-08d65ddf11d6",
      cwd: "C:/Users/hppym/dev/terminal-app",
      status: "busy",
      kind: "interactive",
      entrypoint: "cli",
    });
  });

  it("status の無いエントリ（claude-vscode 起動）も pid / sessionId があれば受理する", () => {
    const e = parseRegistryEntry('{"pid":12644,"sessionId":"e265d7a7","entrypoint":"claude-vscode"}');
    expect(e).toEqual({ pid: 12644, sessionId: "e265d7a7", entrypoint: "claude-vscode" });
    expect(e?.status).toBeUndefined();
  });

  it("壊れた JSON・pid 欠落・sessionId 空・配列は null（書き込み途中のファイルを読んだケース）", () => {
    expect(parseRegistryEntry('{"pid":1,"sessionId":"s"')).toBe(null);
    expect(parseRegistryEntry('{"sessionId":"s"}')).toBe(null);
    expect(parseRegistryEntry('{"pid":0,"sessionId":"s"}')).toBe(null);
    expect(parseRegistryEntry('{"pid":"5","sessionId":"s"}')).toBe(null);
    expect(parseRegistryEntry('{"pid":5,"sessionId":""}')).toBe(null);
    expect(parseRegistryEntry("[1,2]")).toBe(null);
    expect(parseRegistryEntry("null")).toBe(null);
  });
});

describe("readSessionRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-registry-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("*.json だけを読み、.key や壊れたファイルは読み飛ばす", () => {
    fs.writeFileSync(path.join(dir, "100.json"), '{"pid":100,"sessionId":"s-100"}');
    fs.writeFileSync(path.join(dir, "200.json"), "{broken");
    fs.writeFileSync(path.join(dir, "300.json"), '{"pid":300,"sessionId":"s-300","status":"idle"}');
    fs.writeFileSync(path.join(dir, "100.abc.key"), "secret");
    const entries = readSessionRegistry(dir);
    expect(entries?.map((e) => e.sessionId).sort()).toEqual(["s-100", "s-300"]);
  });

  it("ディレクトリが無いときは null（判定不能 → 従来の hook / transcript 判定に委ねる）", () => {
    expect(readSessionRegistry(path.join(dir, "missing"))).toBe(null);
  });

  it("空ディレクトリは空配列（登録簿はあるが誰も動いていない）", () => {
    expect(readSessionRegistry(dir)).toEqual([]);
  });

  it("既定の場所は ~/.claude/sessions", () => {
    expect(registryDir("C:/Users/x")).toBe(path.join("C:/Users/x", ".claude", "sessions"));
  });
});

describe("classifyLiveness", () => {
  const entries = [
    { pid: 10, sessionId: "s-alive" },
    { pid: 20, sessionId: "s-stale" },
    { pid: 30, sessionId: "s-dup" },
    { pid: 31, sessionId: "s-dup" },
  ];
  const alivePids = new Set([10, 31]);
  const pidAlive = (pid: number) => alivePids.has(pid);

  it("登録簿にあり PID が生きている → alive", () => {
    expect(classifyLiveness(entries, "s-alive", pidAlive)).toBe("alive");
  });

  it("登録簿にあるが PID が死んでいる（kill でファイルが残った）→ dead", () => {
    expect(classifyLiveness(entries, "s-stale", pidAlive)).toBe("dead");
  });

  it("登録簿に無い（正常終了でファイルが消えた）→ dead", () => {
    expect(classifyLiveness(entries, "s-gone", pidAlive)).toBe("dead");
  });

  it("同じ sessionId が複数あればどれか 1 つ生きていれば alive", () => {
    expect(classifyLiveness(entries, "s-dup", pidAlive)).toBe("alive");
  });

  it("登録簿が無い（null）→ unknown", () => {
    expect(classifyLiveness(null, "s-alive", pidAlive)).toBe("unknown");
  });
});

describe("registryStatusOf", () => {
  it("cli 起動のセッションは status（busy / waiting / idle）を返し、無ければ undefined", () => {
    const entries = [
      { pid: 1, sessionId: "a", status: "waiting" },
      { pid: 2, sessionId: "b" },
    ];
    expect(registryStatusOf(entries, "a")).toBe("waiting");
    expect(registryStatusOf(entries, "b")).toBeUndefined();
    expect(registryStatusOf(entries, "zzz")).toBeUndefined();
    expect(registryStatusOf(null, "a")).toBeUndefined();
  });
});
