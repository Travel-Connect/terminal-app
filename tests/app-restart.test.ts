import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppRestarter,
  RESTART_CLEANUP_TIMEOUT_MS,
  type RestartDeps,
} from "../src/main/app-restart";

function deps(calls: string[], overrides: Partial<RestartDeps> = {}): RestartDeps {
  return {
    cleanup: async () => {
      calls.push("cleanup");
    },
    relaunch: () => {
      calls.push("relaunch");
    },
    exit: (code) => {
      calls.push(`exit(${code})`);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createAppRestarter", () => {
  it("cleanup、relaunch、exit(0) の順で再起動する", async () => {
    const calls: string[] = [];
    const restarter = createAppRestarter(deps(calls));

    await restarter.restart();

    expect(calls).toEqual(["cleanup", "relaunch", "exit(0)"]);
  });

  it("exit より先に relaunch を予約する", async () => {
    let relaunched = false;
    const restarter = createAppRestarter(
      deps([], {
        relaunch: () => {
          relaunched = true;
        },
        exit: (code) => {
          expect(relaunched).toBe(true);
          expect(code).toBe(0);
        },
      })
    );

    await restarter.restart();
  });

  it("cleanup が reject しても relaunch と exit を続行する", async () => {
    const calls: string[] = [];
    const restarter = createAppRestarter(
      deps(calls, {
        cleanup: async () => {
          calls.push("cleanup");
          throw new Error("close failed");
        },
      })
    );

    await restarter.restart();

    expect(calls).toEqual(["cleanup", "relaunch", "exit(0)"]);
  });

  it("cleanup がハングしてもタイムアウト後に relaunch と exit を続行する", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const restarter = createAppRestarter(
      deps(calls, {
        cleanup: () => {
          calls.push("cleanup");
          return new Promise<void>(() => undefined);
        },
        timeoutMs: RESTART_CLEANUP_TIMEOUT_MS,
      })
    );

    const restarting = restarter.restart();
    await vi.advanceTimersByTimeAsync(RESTART_CLEANUP_TIMEOUT_MS);
    await restarting;

    expect(calls).toEqual(["cleanup", "relaunch", "exit(0)"]);
  });

  it("進行中の二重実行を無視して relaunch と exit を一度だけ呼ぶ", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const restarter = createAppRestarter(
      deps(calls, {
        cleanup: () => {
          calls.push("cleanup");
          return new Promise<void>(() => undefined);
        },
        timeoutMs: 10,
      })
    );

    const first = restarter.restart();
    const second = restarter.restart();
    await second;
    await vi.advanceTimersByTimeAsync(10);
    await first;

    expect(calls).toEqual(["cleanup", "relaunch", "exit(0)"]);
  });

  it("完了後の再呼び出しも無視する", async () => {
    const calls: string[] = [];
    const restarter = createAppRestarter(deps(calls));

    await restarter.restart();
    await restarter.restart();

    expect(calls).toEqual(["cleanup", "relaunch", "exit(0)"]);
  });
});
