export const RESTART_CLEANUP_TIMEOUT_MS = 3000;

export interface RestartDeps {
  cleanup: () => Promise<void>;
  relaunch: () => void;
  exit: (code: number) => void;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

export function createAppRestarter(deps: RestartDeps): { restart(): Promise<void> } {
  let restarting = false;

  return {
    async restart(): Promise<void> {
      // relaunch を複数回予約すると終了後に複数インスタンスが起動するため、
      // 連打や重複イベントをプロセス全体で一度だけ受け付ける。
      if (restarting) {
        deps.log?.("再起動はすでに進行中です");
        return;
      }
      restarting = true;

      const timeoutMs = deps.timeoutMs ?? RESTART_CLEANUP_TIMEOUT_MS;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = Promise.resolve()
        .then(() => deps.cleanup())
        .then(
          () => "completed" as const,
          (error: unknown) => {
            deps.log?.(`再起動前の後始末に失敗しました: ${String(error)}`);
            return "failed" as const;
          }
        );
      const timedOut = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      });

      // app.exit() は will-quit を発火しないため明示的に後始末する。
      // ただし失敗やハングで再起動自体を妨げないよう、待機時間には上限を設ける。
      const cleanupResult = await Promise.race([cleanup, timedOut]);
      if (timeout !== undefined) clearTimeout(timeout);
      if (cleanupResult === "timeout") {
        deps.log?.(`再起動前の後始末が ${timeoutMs}ms でタイムアウトしました`);
      }

      // relaunch は終了後の再起動を予約する API なので、予約してから確実に終了する。
      deps.relaunch();
      deps.exit(0);
    },
  };
}
