/**
 * main プロセスのエントリ（design.md 3 章の結線 / REQ-01〜REQ-11）。
 * モジュール分割: ①event-server ②state-store/project-store ③renderer(UI)
 * ④hooks-manager ⑤window-control（design.md 3.1）。
 *
 * 起動フラグ（検証・証跡用）:
 *   --demo               モック 1b 相当のデモデータで起動（一時データディレクトリ使用・hooks 追記なし）
 *   --demo-count=16      デモを 16 タイルに拡張（NFR-05 / V-15 用）
 *   --capture=<path>     指定パスへウィンドウのスクリーンショット PNG を保存して終了（FL2 証跡用）
 *   --capture-delay=<ms> キャプチャまでの待ち時間（既定 1600ms。擬似イベント注入の時間を確保する用途）
 *   --theme=<t>          テーマの一時上書き（light / dark / auto。ライトモード証跡用）
 *   --view=settings      設定画面を初期表示で開く（面 1d / 1f の証跡用）
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClickTarget, RegisterResult, Snapshot, ThemeSetting } from "../shared/types";
import { seedDemo } from "./demo";
import { createEventServer, type EventServer } from "./event-server";
import { mergeHooks, removeHooks } from "./hooks-manager";
import { Logger } from "./logger";
import { getDataDir } from "./paths";
import { ProjectStore, validateProjectDir } from "./project-store";
import { classifyNotification, StateStore } from "./state-store";
import { focusProjectWindow } from "./window-control";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

const demoMode = process.argv.includes("--demo") || argValue("demo-count") !== undefined;
const demoCount: 12 | 16 = argValue("demo-count") === "16" ? 16 : 12;
const capturePath = argValue("capture");
const captureDelayArg = Number(argValue("capture-delay") ?? "1600");
const captureDelay = Number.isFinite(captureDelayArg) && captureDelayArg >= 0 ? captureDelayArg : 1600;
const themeOverride = argValue("theme") as ThemeSetting | undefined;

// デモ・キャプチャ実行では実ユーザーの %APPDATA% を汚さない（一時ディレクトリへ差し替え）
if (demoMode && !process.env.TERMINAL_APP_DATA_DIR) {
  process.env.TERMINAL_APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-app-demo-"));
}

const dataDir = getDataDir();

// データディレクトリを差し替えた実行（検証・デモ）では Chromium プロファイル（userData）も隔離する。
// 実稼働インスタンスとプロファイルを共有すると、2 個目以降の起動がプロファイルロックの競合で
// ハング・大幅遅延しうる（検証スクリプトを実稼働アプリと並走させたときに顕在化）
if (process.env.TERMINAL_APP_DATA_DIR) {
  app.setPath("userData", path.join(dataDir, "electron-user-data"));
}
const logger = new Logger(dataDir);
const projectStore = new ProjectStore(dataDir, logger);
const stateStore = new StateStore();

let win: BrowserWindow | null = null;
let revision = 0;
let statusMessage = "";
let pinned = false;

/** NFR-01 計測: revision → イベント受信時刻。renderer の描画完了通知でログ差分を出す（verification.md 3.2） */
const pendingRender = new Map<number, number>();

function buildSnapshot(): Snapshot {
  const config = { ...projectStore.config };
  if (themeOverride !== undefined) config.theme = themeOverride;
  return {
    revision,
    projects: [...projectStore.projects],
    sessions: stateStore.displaySessions(projectStore.projects),
    // 件数は StateStore.counts を正とし、renderer は表示整形のみ行う（重複実装の一本化）
    counts: stateStore.counts(projectStore.projects),
    config,
    pinned,
    statusMessage,
  };
}

function broadcast(receivedAt?: number): void {
  revision += 1;
  const canDeliver = win !== null && !win.isDestroyed();
  // 配信できない revision の計測開始点は記録しない（notify-rendered が来ず Map が育ち続けるのを防ぐ）
  if (receivedAt !== undefined && canDeliver) pendingRender.set(revision, receivedAt);
  if (canDeliver) {
    win?.webContents.send("snapshot", buildSnapshot());
  }
}

function setStatus(message: string): void {
  statusMessage = message;
  broadcast();
}

// 多重起動は禁止（design.md 8 章）。デモ・キャプチャ実行は通常インスタンスと共存可とする
let secondInstance = false;
if (!demoMode && capturePath === undefined) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // quit は非同期のため、whenReady 側でも secondInstance を見て初期化を打ち切る
    // （2 個目のインスタンスが受信サーバの listen を試みて「ポート使用中」ダイアログを出す競合の防止）
    secondInstance = true;
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (win !== null) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

// 受信サーバは projectStore.load() 後（whenReady 内）に生成する。
// トップレベルで生成すると config.json 読み込み前の既定ポートを捕捉してしまい、
// 「config.json の port 変更が反映されない」バグになる（2026-07-11 検証で発見・修正）
let eventServer: EventServer | null = null;

function createAppEventServer(): EventServer {
  return createEventServer({
    port: projectStore.config.port,
    onEvent: (evt, receivedAt) => {
      const result = stateStore.applyEvent(evt, projectStore.projects);
      if (result === null) {
        // design.md 10 章: 未登録 cwd・正常 SessionEnd は破棄してログのみ（UI は変えない）
        logger.info(`event 破棄: ${evt.hook_event_name} cwd=${evt.cwd}`);
        return;
      }
      const detail = evt.hook_event_name === "Notification" ? ` 種別=${classifyNotification(evt.message)}` : "";
      logger.info(
        `event 受信: ${evt.hook_event_name}${detail} → ${result.state} (project=${result.projectId}, session=${result.sessionId})`
      );
      broadcast(receivedAt);
    },
    logger,
  });
}

/** D&D 登録（design.md 3.2(a): パス検証 → hooks マージ → projects 追加。失敗時は登録しない） */
function registerProject(dirPath: string): RegisterResult {
  // 事前検証は ProjectStore と共通の validateProjectDir に集約
  // （hooks マージより先に弾くことで、無効パスへの .claude/ 作成を防ぐ）
  const valid = validateProjectDir(dirPath, projectStore.projects);
  if (!valid.ok) {
    return { ok: false, path: dirPath, error: valid.error };
  }
  const merged = mergeHooks(dirPath, projectStore.config.port);
  if (!merged.ok) {
    // design.md 3.2(a) 失敗時: settings.json に書き込まず、登録も行わない
    logger.error(`hooks マージ失敗のため登録中止: ${dirPath} — ${merged.error}`);
    return { ok: false, path: dirPath, error: merged.error };
  }
  const added = projectStore.addProject(dirPath);
  if (!added.ok || added.project === undefined) {
    removeHooks(dirPath); // 追加に失敗したらマージを巻き戻す
    return { ok: false, path: dirPath, error: added.error };
  }
  logger.info(`プロジェクト登録: ${dirPath} (hooks 書込=${merged.changed})`);
  return { ok: true, path: dirPath, projectId: added.project.id };
}

function wireIpc(): void {
  ipcMain.handle("get-snapshot", () => buildSnapshot());

  ipcMain.handle("register-projects", (_e, paths: string[]): RegisterResult[] => {
    const results = paths.map((p) => registerProject(p));
    broadcast();
    return results;
  });

  ipcMain.handle("unregister-project", (_e, id: string) => {
    const project = projectStore.getProject(id);
    if (project === null) return { ok: false, error: "プロジェクトが見つかりません" };
    const removed = removeHooks(project.path);
    if (!removed.ok) {
      // design.md 4.2 除去: パース失敗時は中断（手動対応を促す）。登録は残す
      logger.error(`hooks 除去失敗: ${project.path} — ${removed.error}`);
      setStatus(`hooks を除去できません（手動確認が必要）: ${removed.error ?? ""}`);
      return { ok: false, error: removed.error };
    }
    projectStore.removeProject(id);
    stateStore.removeProjectSessions(id); // 解除済みプロジェクトのセッションを保持し続けない（メモリ整理）
    logger.info(`プロジェクト登録解除: ${project.path} (hooks 除去=${removed.changed})`);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle("set-click-target", (_e, id: string, target: ClickTarget) => {
    projectStore.setClickTarget(id, target);
    broadcast();
  });

  ipcMain.handle("set-theme", (_e, theme: ThemeSetting) => {
    projectStore.setTheme(theme);
    broadcast();
  });

  ipcMain.handle("set-aot-default", (_e, value: boolean) => {
    projectStore.setAlwaysOnTopDefault(value);
    broadcast();
  });

  ipcMain.handle("set-pinned", (_e, value: boolean) => {
    pinned = value;
    win?.setAlwaysOnTop(value);
    broadcast();
  });

  ipcMain.handle("focus-project", (_e, id: string) => {
    const project = projectStore.getProject(id);
    if (project === null) return { ok: false, message: "プロジェクトが見つかりません" };
    // クリック時点では本アプリがフォアグラウンド → SetForegroundWindow の権限内（design.md 7.2）
    const outcome = focusProjectWindow(project.clickTarget, path.basename(project.path));
    logger.info(`前面化 ${outcome.ok ? "成功" : "失敗"}: ${project.name} → ${project.clickTarget}${outcome.message ? ` (${outcome.message})` : ""}`);
    setStatus(outcome.ok ? "" : (outcome.message ?? "前面化に失敗しました"));
    return outcome;
  });

  ipcMain.on("window-action", (_e, action: "minimize" | "maximize" | "close") => {
    if (win === null) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === "close") win.close(); // 閉じる = アプリ終了（design.md 6.1）
  });

  ipcMain.on("notify-rendered", (_e, rev: number) => {
    const receivedAt = pendingRender.get(rev);
    if (receivedAt !== undefined) {
      pendingRender.delete(rev);
      logger.info(`ui-latency: 受信→描画完了 ${Date.now() - receivedAt}ms (revision=${rev})`); // V-04 のログ差分計測
    }
    // 追い越された古い計測は破棄
    for (const key of pendingRender.keys()) {
      if (key < rev) pendingRender.delete(key);
    }
  });
}

function scheduleCaptureIfNeeded(): void {
  if (capturePath === undefined || win === null) return;
  const target = capturePath;
  setTimeout(() => {
    void (async () => {
      try {
        if (win === null) return;
        // V-11 補助証跡: setAlwaysOnTop の ON/OFF が API に反映されることをログで確認
        const before = win.isAlwaysOnTop();
        win.setAlwaysOnTop(true);
        logger.info(`pin-check: setAlwaysOnTop(true) → isAlwaysOnTop=${win.isAlwaysOnTop()}`);
        win.setAlwaysOnTop(false);
        logger.info(`pin-check: setAlwaysOnTop(false) → isAlwaysOnTop=${win.isAlwaysOnTop()}`);
        win.setAlwaysOnTop(before);
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, image.toPNG());
        logger.info(`capture saved: ${target}`);
      } catch (e) {
        logger.error(`capture 失敗: ${String(e)}`);
      } finally {
        app.quit();
      }
    })();
  }, captureDelay);
}

function createWindow(): void {
  pinned = projectStore.config.alwaysOnTopDefault; // 起動時の既定値（design.md 8 章 / 面 1d）
  win = new BrowserWindow({
    width: 680,
    height: 520,
    minWidth: 420,
    minHeight: 320,
    frame: false, // タイトルバーはモック準拠の自前実装（面 1a〜1f）
    show: false,
    backgroundColor: "#101216",
    alwaysOnTop: pinned,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  const initialView = argValue("view") === "settings" ? "settings" : "main";
  void win.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { view: initialView } });
  win.once("ready-to-show", () => {
    win?.show();
    logger.info(`window shown (demo=${demoMode}, capture=${capturePath ?? "-"})`);
    scheduleCaptureIfNeeded();
  });
  win.on("closed", () => {
    win = null;
  });
}

void app.whenReady().then(async () => {
  if (secondInstance) return; // 多重起動側: quit 完了を待つだけ（サーバ listen もウィンドウ生成もしない）
  logger.info(`terminal-app 起動 (dataDir=${dataDir}, demo=${demoMode})`);
  projectStore.load();

  if (demoMode) {
    seedDemo(projectStore, stateStore, demoCount);
    logger.info(`demo シード投入: ${demoCount} タイル`);
  } else {
    // 起動時追補（セルフヒール）: 登録済み全プロジェクトの hooks を冪等マージし、
    // マーカー付きエントリが不足しているイベントのみ append する（design.md 4.2 / 3.3）。
    // 旧 2 イベント（Stop / Notification）構成で登録済みのプロジェクトにも、
    // 再登録なしで UserPromptSubmit（OPEN-04 案 A）が行き渡る。ポート変更後の再追記も同経路。
    for (const p of projectStore.projects) {
      const r = mergeHooks(p.path, projectStore.config.port);
      if (!r.ok) logger.warn(`hooks 追補失敗: ${p.path} — ${r.error}`);
      else if (r.changed) logger.info(`hooks を追補（不足イベントの追記/再追記）: ${p.path}`);
    }
  }

  // design.md 10 章「UI は起動継続」: 先にウィンドウを表示し、listen 失敗時は
  // ステータス表示＋エラーダイアログで設定変更を案内する（ダイアログはモーダルで
  // メインプロセスを止めるため、ウィンドウ表示前に出すと起動自体が固まる）
  wireIpc();
  createWindow();

  eventServer = createAppEventServer();
  try {
    await eventServer.listen();
  } catch (e) {
    logger.error(`受信サーバの起動に失敗: ${String(e)}`);
    setStatus(`受信ポート ${projectStore.config.port} を開けません（config.json の "port" を変更して再起動してください）`);
    // 自動キャプチャ実行（検証・証跡採取）ではモーダルを出さない（無人実行がハングするため）
    if (capturePath === undefined) {
      dialog.showErrorBox(
        "受信ポートを開けません",
        `ポート ${projectStore.config.port} を使用できません。\n` +
          `%APPDATA%\\terminal-app\\config.json の "port" を変更して再起動してください。\n\n詳細: ${String(e)}`
      );
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  void eventServer?.close();
  logger.info("terminal-app 終了");
});
