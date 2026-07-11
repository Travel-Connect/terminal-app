import * as os from "os";
import * as path from "path";

/**
 * 永続化ディレクトリの解決（design.md 9 章: %APPDATA%\terminal-app\）。
 * テスト・デモ実行では環境変数 TERMINAL_APP_DATA_DIR で差し替える
 * （実ユーザーの登録情報を汚さないための入口）。
 */
export function getDataDir(): string {
  const override = process.env.TERMINAL_APP_DATA_DIR;
  if (override && override.trim() !== "") return override;
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "terminal-app");
}
