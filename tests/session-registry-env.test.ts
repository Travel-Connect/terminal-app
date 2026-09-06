/**
 * 260907_1 R7: 登録簿ディレクトリの env 上書き（E2E 用）。
 * TERMINAL_APP_DATA_DIR と同系の検証フラグ。未設定なら従来どおり <home>/.claude/sessions。
 */
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registryDir } from "../src/main/session-registry";

const saved = process.env.TERMINAL_APP_SESSIONS_DIR;

beforeEach(() => {
  delete process.env.TERMINAL_APP_SESSIONS_DIR;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TERMINAL_APP_SESSIONS_DIR;
  else process.env.TERMINAL_APP_SESSIONS_DIR = saved;
});

describe("registryDir と TERMINAL_APP_SESSIONS_DIR", () => {
  it("未設定なら <home>/.claude/sessions", () => {
    expect(registryDir("C:/Users/x")).toBe(path.join("C:/Users/x", ".claude", "sessions"));
  });

  it("設定されていればそのパス（homeDir 引数より優先）", () => {
    process.env.TERMINAL_APP_SESSIONS_DIR = "C:/tmp/fake-sessions";
    expect(registryDir("C:/Users/x")).toBe("C:/tmp/fake-sessions");
    expect(registryDir()).toBe("C:/tmp/fake-sessions");
  });

  it("空文字・空白だけは未設定扱い", () => {
    process.env.TERMINAL_APP_SESSIONS_DIR = "   ";
    expect(registryDir("C:/Users/x")).toBe(path.join("C:/Users/x", ".claude", "sessions"));
  });
});
