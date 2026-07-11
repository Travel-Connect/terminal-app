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
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClickTarget, OpResult, RegisterResult, Snapshot, ThemeSetting } from "../shared/types";
import { seedDemo } from "./demo";
import { buildListenErrorText, createEventServer, resolveAttemptedPort, type EventServer } from "./event-server";
import { ALL_HOOK_EVENTS, mergeHooks, mergeStatusLine, removeHooks, removeStatusLine } from "./hooks-manager";
import { DISCONNECT_CHECK_INTERVAL_MS, findDisconnected } from "./liveness-monitor";
import { Logger } from "./logger";
import { getDataDir } from "./paths";
import { ProjectStore, validateProjectDir } from "./project-store";
import { scanLiveSessions } from "./session-scan";
import { fmtStats, parseStatusLinePayload } from "./statusline";
import { classifyNotification, StateStore } from "./state-store";
import { focusProjectWindow, hasWindowFor, isAvailable as windowApiAvailable, listTopLevelWindows, type TopLevelWindow } from "./window-control";

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
    // デモ実行は hooks を書かず受信も不要のため空きポート（0）で listen し、
    // 実稼働インスタンス（既定 41321）と並走しても EADDRINUSE を起こさない（260712 課題C）
    port: demoMode ? 0 : projectStore.config.port,
    onEvent: (evt, receivedAt) => {
      const result = stateStore.applyEvent(evt, projectStore.projects);
      if (result === null) {
        // design.md 10 章: 未登録 cwd・正常 SessionEnd は破棄してログのみ（UI は変えない）
        logger.info(`event 破棄: ${evt.hook_event_name} cwd=${evt.cwd}`);
        return;
      }
      if (result.discardedRunning === true) {
        // 正常 SessionEnd: 実行中のまま終了したセッションの記録を破棄（260712 課題A の幽霊実行中防止）
        logger.info(`event 受信: SessionEnd（正常終了）→ 実行中セッションの記録を破棄 (project=${result.projectId}, session=${result.sessionId})`);
      } else {
        const detail = evt.hook_event_name === "Notification" ? ` 種別=${classifyNotification(evt.message)}` : "";
        logger.info(
          `event 受信: ${evt.hook_event_name}${detail} → ${result.state} (project=${result.projectId}, session=${result.sessionId})`
        );
      }
      broadcast(receivedAt);
    },
    // statusLine 転送（260712_3 案A）: メトリクスをタイルへ反映し、整形テキストを
    // レスポンス本文として返す（curl 経由でそのままターミナルの statusline 表示になる）。
    // 高頻度（最大 300ms 間隔）のため、表示値が変わったときだけ broadcast する。
    onStatusLine: (payload) => {
      const metrics = parseStatusLinePayload(payload);
      if (metrics === null) return null;
      const text = fmtStats(metrics);
      if (stateStore.applyStatusStats(metrics.sessionId, text)) broadcast();
      return text ?? null;
    },
    logger,
  });
}

/* ---------------- 切断検知（260712_2） ---------------- */

let livenessTimer: NodeJS.Timeout | null = null;

function statMtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** 切断トースト（260712_2）。通知音は REQ-12（次期）まで鳴らさない = silent 固定 */
function showDisconnectToast(projectName: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: `${projectName}: セッションが切断されました`,
    body: "終了の合図が届かないまま更新が止まりました。タイル右クリック →「再接続」で拾い直せます。",
    silent: true,
  });
  n.on("click", () => {
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
}

/**
 * 1 掃引: 実行中セッションの transcript 更新時刻とウィンドウ存在を確認し、
 * 切断と判定されたものを「切断」状態へ遷移 ＋ トースト通知する。
 * ウィンドウ列挙（EnumWindows）は 1 掃引につき最大 1 回に抑える（遅延取得）。
 */
function sweepLiveness(): void {
  const targets = stateStore.runningSessions();
  if (targets.length === 0) return;
  let windows: TopLevelWindow[] | null = null;
  const windowPresent = (projectId: string): boolean | null => {
    const project = projectStore.getProject(projectId);
    if (project === null || !windowApiAvailable()) return null; // 判定不能 → liveness-monitor 側で安全側に扱う
    if (windows === null) windows = listTopLevelWindows();
    return hasWindowFor(project.clickTarget, path.basename(project.path), windows);
  };
  const hits = findDisconnected(targets, { now: () => Date.now(), mtimeMs: statMtimeMs, windowPresent });
  let changed = false;
  for (const t of hits) {
    if (!stateStore.markDisconnected(t.sessionId)) continue;
    changed = true;
    const project = projectStore.getProject(t.projectId);
    const name = project?.name ?? t.projectId;
    logger.warn(`切断検知: ${name} (session=${t.sessionId}) — transcript 更新途絶`);
    showDisconnectToast(name);
  }
  if (changed) broadcast();
}

/** D&D 登録（design.md 3.2(a): パス検証 → hooks マージ → projects 追加。失敗時は登録しない） */
function registerProject(dirPath: string): RegisterResult {
  // 事前検証は ProjectStore と共通の validateProjectDir に集約
  // （hooks マージより先に弾くことで、無効パスへの .claude/ 作成を防ぐ）
  const valid = validateProjectDir(dirPath, projectStore.projects);
  if (!valid.ok) {
    return { ok: false, path: dirPath, error: valid.error };
  }
  const merged = mergeHooks(dirPath, projectStore.config.port, ALL_HOOK_EVENTS);
  if (!merged.ok) {
    // design.md 3.2(a) 失敗時: settings.json に書き込まず、登録も行わない
    logger.error(`hooks マージ失敗のため登録中止: ${dirPath} — ${merged.error}`);
    return { ok: false, path: dirPath, error: merged.error };
  }
  // statusLine 転送（260712_3 案A）は付加機能のため、失敗しても登録は続行する（ログのみ）
  const sl = mergeStatusLine(dirPath, projectStore.config.port);
  if (!sl.ok) logger.warn(`statusLine 設定失敗（登録は続行）: ${dirPath} — ${sl.error}`);
  else if (sl.skipped === true) logger.info(`statusLine は既存のユーザー設定を尊重（設定せず）: ${dirPath}`);
  const added = projectStore.addProject(dirPath);
  if (!added.ok || added.project === undefined) {
    removeHooks(dirPath, ALL_HOOK_EVENTS); // 追加に失敗したらマージを巻き戻す
    removeStatusLine(dirPath);
    return { ok: false, path: dirPath, error: added.error };
  }
  logger.info(`プロジェクト登録: ${dirPath} (hooks 書込=${merged.changed}, statusLine=${sl.skipped === true ? "skip" : String(sl.changed)})`);
  return { ok: true, path: dirPath, projectId: added.project.id };
}

/** 登録解除の本体（設定画面の IPC と右クリックメニューの両方から呼ぶ。260712_2 でハンドラから抽出） */
function unregisterProjectById(id: string): OpResult {
  const project = projectStore.getProject(id);
  if (project === null) return { ok: false, error: "プロジェクトが見つかりません" };
  const removed = removeHooks(project.path, ALL_HOOK_EVENTS);
  if (!removed.ok) {
    // design.md 4.2 除去: パース失敗時は中断（手動対応を促す）。登録は残す
    logger.error(`hooks 除去失敗: ${project.path} — ${removed.error}`);
    setStatus(`hooks を除去できません（手動確認が必要）: ${removed.error ?? ""}`);
    return { ok: false, error: removed.error };
  }
  const slRemoved = removeStatusLine(project.path);
  if (!slRemoved.ok) logger.warn(`statusLine 除去失敗（解除は続行）: ${project.path} — ${slRemoved.error}`);
  projectStore.removeProject(id);
  stateStore.removeProjectSessions(id); // 解除済みプロジェクトのセッションを保持し続けない（メモリ整理）
  logger.info(`プロジェクト登録解除: ${project.path} (hooks 除去=${removed.changed}, statusLine 除去=${slRemoved.changed})`);
  broadcast();
  return { ok: true };
}

/**
 * 再接続（260712_2）: transcript 走査で「直近まで動いていた」セッションを復元する。
 * アプリ再起動（セッションは揮発）後や切断誤検知からの復帰の手動導線。
 */
function reconnectProject(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  const found = scanLiveSessions(project.path);
  let revived = 0;
  for (const s of found) {
    const ok = stateStore.reviveSession({
      sessionId: s.sessionId,
      projectId: id,
      lastEventAt: s.mtimeMs,
      transcriptPath: s.transcriptPath,
      workText: s.workText,
    });
    if (ok) revived += 1;
  }
  logger.info(`再接続: ${project.name} — 走査 ${found.length} 件 / 復元 ${revived} 件`);
  setStatus(
    revived > 0
      ? `再接続: ${project.name} のセッション ${revived} 件を復元しました`
      : `再接続: ${project.name} に動作中のセッションは見つかりませんでした`
  );
}

/** 表示クリア（260712_2）: タイルのセッション表示のみ消す（登録・hooks は維持。次のイベントで再表示される） */
function clearProjectDisplay(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  stateStore.removeProjectSessions(id);
  logger.info(`表示クリア: ${project.name}`);
  setStatus(`${project.name} の表示をクリアしました`);
}

/** 登録解除は hooks 除去を伴う破壊的操作のため、メニューからは確認を挟む（260712_2） */
async function confirmAndUnregister(id: string): Promise<void> {
  const project = projectStore.getProject(id);
  if (project === null || win === null) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "登録解除",
    message: `${project.name} を登録解除しますか？`,
    detail: `タイルを削除し、${project.path} の .claude/settings.json から本アプリの hooks を除去します。`,
    buttons: ["登録解除", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    const result = unregisterProjectById(id);
    if (!result.ok && result.error !== undefined) setStatus(result.error);
  }
}

function wireIpc(): void {
  ipcMain.handle("get-snapshot", () => buildSnapshot());

  ipcMain.handle("register-projects", (_e, paths: string[]): RegisterResult[] => {
    const results = paths.map((p) => registerProject(p));
    broadcast();
    return results;
  });

  ipcMain.handle("unregister-project", (_e, id: string) => unregisterProjectById(id));

  // タイル右クリックメニュー（260712_2）。ネイティブ Menu を popup し、確定処理は main 側で完結する
  ipcMain.handle("show-tile-menu", (_e, id: string) => {
    const project = projectStore.getProject(id);
    if (project === null || win === null) return;
    const menu = Menu.buildFromTemplate([
      { label: "再接続（動作中のセッションを拾い直す）", click: () => { reconnectProject(id); } },
      { label: "表示クリア（登録は維持）", click: () => { clearProjectDisplay(id); } },
      { type: "separator" },
      { label: "登録解除（hooks も除去）…", click: () => { void confirmAndUnregister(id); } },
    ]);
    menu.popup({ window: win });
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
  // Windows のトースト通知（切断お知らせ。260712_2）は AppUserModelID が無いと表示されないことがある
  app.setAppUserModelId("terminal-app");
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
      const r = mergeHooks(p.path, projectStore.config.port, ALL_HOOK_EVENTS);
      if (!r.ok) logger.warn(`hooks 追補失敗: ${p.path} — ${r.error}`);
      else if (r.changed) logger.info(`hooks を追補（不足イベントの追記/再追記）: ${p.path}`);
      // statusLine 転送（260712_3 案A）も同経路で追補（既存プロジェクトへ再登録なしで行き渡る）
      const sl = mergeStatusLine(p.path, projectStore.config.port);
      if (!sl.ok) logger.warn(`statusLine 追補失敗: ${p.path} — ${sl.error}`);
      else if (sl.skipped === true) logger.info(`statusLine は既存のユーザー設定を尊重（設定せず）: ${p.path}`);
      else if (sl.changed) logger.info(`statusLine 転送を追補: ${p.path}`);
    }
  }

  // design.md 10 章「UI は起動継続」: 先にウィンドウを表示し、listen 失敗時は
  // ステータス表示＋エラーダイアログで設定変更を案内する（ダイアログはモーダルで
  // メインプロセスを止めるため、ウィンドウ表示前に出すと起動自体が固まる）
  wireIpc();
  createWindow();

  const server = createAppEventServer();
  eventServer = server;
  try {
    await server.listen();
  } catch (e) {
    // 表示するポートは「実際に bind を試みたポート」を正とする（260712 課題C:
    // 旧実装は設定値 projectStore.config.port を表示しており、実試行ポートと食い違う
    // ダイアログ（表示 41999 / 実 bind 41321）を出していた）
    const attemptedPort = resolveAttemptedPort(e, server.targetPort);
    const text = buildListenErrorText(e, attemptedPort);
    logger.error(`受信サーバの起動に失敗 (port=${attemptedPort}): ${String(e)}`);
    setStatus(text.status);
    // 自動キャプチャ実行（検証・証跡採取）ではモーダルを出さない（無人実行がハングするため）
    if (capturePath === undefined) {
      dialog.showErrorBox(text.title, text.body);
    }
  }

  // 切断検知の定期掃引（260712_2）。デモ実行はシードに transcript が無く対象外
  if (!demoMode) {
    livenessTimer = setInterval(sweepLiveness, DISCONNECT_CHECK_INTERVAL_MS);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  if (livenessTimer !== null) clearInterval(livenessTimer);
  void eventServer?.close();
  logger.info("terminal-app 終了");
});
