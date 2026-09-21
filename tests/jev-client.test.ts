/**
 * 260922_2: Jev（TypeSafe AI System One）クライアントのテスト。
 * - API キーの取得順（env → .typesafe.env）とキー無しの扱い
 * - リクエスト形状（URL / Bearer / state・model・questions）と応答の検証（parseJevAnswers）
 * - 失敗（HTTP エラー・ネットワーク例外・タイムアウト・形式不正）はすべて null（例外を投げない）
 * 実ネットワーク・実ファイルには触れない（fetch と readFile を差し替える）
 */
import { describe, expect, it, vi } from "vitest";
import { createJevClient, jevDisabledByEnv, loadTypesafeApiKey, nullJevClient, parseJevAnswers, JEV_API_URL } from "../src/main/jev-client";

const okResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("loadTypesafeApiKey", () => {
  it("env TYPESAFE_API_KEY を最優先で返す（前後の空白は落とす）", () => {
    expect(loadTypesafeApiKey({ TYPESAFE_API_KEY: "  k-env  " }, ["C:/home"], () => "TYPESAFE_API_KEY=k-file")).toBe("k-env");
  });

  it("env に無ければ %USERPROFILE%/.typesafe.env の行から読む（BOM・引用符・CRLF を許容）", () => {
    const files: Record<string, string> = { "C:\\home\\.typesafe.env": "\uFEFF# comment\r\nTYPESAFE_API_KEY=\"k-file\"\r\n" };
    const readFile = (p: string): string => {
      const v = files[p] ?? files[p.replaceAll("/", "\\")];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    };
    expect(loadTypesafeApiKey({}, ["C:\\home"], readFile)).toBe("k-file");
  });

  it("どこにも無ければ null（ファイル読み取り失敗は黙って次へ）", () => {
    expect(loadTypesafeApiKey({}, ["C:/a", undefined, "C:/b"], () => { throw new Error("ENOENT"); })).toBeNull();
    expect(loadTypesafeApiKey({}, ["C:/a"], () => "OTHER=1\nTYPESAFE_API_KEY=\n")).toBeNull();
  });
});

describe("jevDisabledByEnv", () => {
  it("off / 0 / false で無効、未設定・その他は有効", () => {
    expect(jevDisabledByEnv({ TERMINAL_APP_JEV: "off" })).toBe(true);
    expect(jevDisabledByEnv({ TERMINAL_APP_JEV: "0" })).toBe(true);
    expect(jevDisabledByEnv({ TERMINAL_APP_JEV: "FALSE" })).toBe(true);
    expect(jevDisabledByEnv({})).toBe(false);
    expect(jevDisabledByEnv({ TERMINAL_APP_JEV: "on" })).toBe(false);
  });
});

describe("parseJevAnswers", () => {
  it("noul / choice / score を型どおりに取り出し、壊れた要素は捨てる", () => {
    const parsed = parseJevAnswers({
      answers: {
        a: { type: "noul", noul: 0.9 },
        b: { type: "choice", choice: "x", probabilities: { x: 0.8, y: 0.2 }, confidence: 0.6 },
        c: { type: "score", score: 1.5, confidence: 0.7 },
        broken1: { type: "noul", noul: "0.9" },
        broken2: null,
      },
    });
    expect(parsed).toEqual({
      a: { type: "noul", noul: 0.9 },
      b: { type: "choice", choice: "x", probabilities: { x: 0.8, y: 0.2 }, confidence: 0.6 },
      c: { type: "score", score: 1.5, confidence: 0.7 },
    });
  });

  it("answers が無い・空・オブジェクトでないときは null", () => {
    expect(parseJevAnswers(null)).toBeNull();
    expect(parseJevAnswers({})).toBeNull();
    expect(parseJevAnswers({ answers: [] })).toBeNull();
    expect(parseJevAnswers({ answers: { a: { type: "noul", noul: Number.NaN } } })).toBeNull();
  });
});

describe("createJevClient.judge", () => {
  it("state・model・questions を JSON で POST し、Bearer 認証を付け、answers を返す", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ answers: { q: { type: "noul", noul: 0.42 } } }));
    const client = createJevClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, model: "jev-1.13.0" });
    expect(client.available).toBe(true);
    const result = await client.judge("hello", { q: { type: "noul", instructions: "is it?" } });
    expect(result).toEqual({ q: { type: "noul", noul: 0.42 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_API_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({ state: "hello", model: "jev-1.13.0", questions: { q: { type: "noul", instructions: "is it?" } } });
  });

  it("キー無しは available=false で fetch を呼ばず null", async () => {
    const fetchImpl = vi.fn();
    const client = createJevClient({ apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(client.available).toBe(false);
    expect(await client.judge("x", {})).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(nullJevClient.available).toBe(false);
    expect(await nullJevClient.judge("x", {})).toBeNull();
  });

  it("HTTP エラー・ネットワーク例外・形式不正はすべて null（例外を投げない）。警告は同じ理由で 1 分に 1 回", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    const http500 = createJevClient({ apiKey: "k", fetchImpl: (async () => okResponse({}, 500)) as unknown as typeof fetch, logger });
    expect(await http500.judge("x", {})).toBeNull();
    expect(await http500.judge("x", {})).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1); // 同じ理由（http-500）は抑制
    const thrower = createJevClient({ apiKey: "k", fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch, logger });
    expect(await thrower.judge("x", {})).toBeNull();
    const badShape = createJevClient({ apiKey: "k", fetchImpl: (async () => okResponse({ nope: 1 })) as unknown as typeof fetch, logger });
    expect(await badShape.judge("x", {})).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("タイムアウトで abort され null になる", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const client = createJevClient({ apiKey: "k", fetchImpl, timeoutMs: 20 });
    expect(await client.judge("x", {})).toBeNull();
  });
});
