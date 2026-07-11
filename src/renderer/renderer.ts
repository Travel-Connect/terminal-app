/**
 * ③ UI（renderer）: タイルグリッド / 空状態 / 設定 / ステータスバー（design.md 6 章、モック面 1a〜1f）。
 * ES モジュールとしてビルドする（index.html で type="module" 読み込み）。表示整形の純関数は
 * ./format.ts に分離（単体テスト対象）。main とは preload の window.terminalApp 経由でのみ通信する。
 */
import { fmtElapsed, fmtRelative, fmtStatusCounts } from "./format.js";

type Api = Window["terminalApp"];
type Snapshot = Awaited<ReturnType<Api["getSnapshot"]>>;
type Project = Snapshot["projects"][number];
type SessionView = Snapshot["sessions"][string];
type SessionState = SessionView["state"];
type ThemeSetting = Snapshot["config"]["theme"];
type ClickTarget = Project["clickTarget"];

const api = window.terminalApp;

let snap: Snapshot | null = null;
let currentView: "main" | "settings" = "main";
let projectsExpanded = false;
let localMessageTimer: number | undefined;

/** 折りたたみの閾値（面 1d「他10件を表示」相当。先頭 N 件のみ表示し残りを畳む） */
const PROJECT_FOLD_LIMIT = 5;

const tileEls = new Map<string, HTMLButtonElement>();

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (el === null) throw new Error(`要素が見つかりません: ${sel}`);
  return el as HTMLElement;
}

/* ---------------- 表示テキスト（design.md 6.2 / 5.1） ---------------- */

const STATE_META: Record<SessionState, { label: string; icon: string; cls: string }> = {
  waiting: { label: "待機", icon: "◌", cls: "state-waiting" }, // ◌
  running: { label: "実行中", icon: "", cls: "state-running" }, // アイコンはスピナー
  done: { label: "完了", icon: "✓", cls: "state-done" }, // ✓
  confirm: { label: "確認待ち", icon: "?", cls: "state-confirm" },
  error: { label: "エラー", icon: "⚠", cls: "state-error" }, // ⚠
  disconnected: { label: "切断", icon: "⊘", cls: "state-disconnected" }, // 260712_2: SessionEnd 不達のまま更新途絶
};

function tileStatusText(session: SessionView | undefined): string {
  if (session === undefined) return "待機・イベント待ち";
  if (session.state === "running") {
    const elapsed = session.runningSince !== undefined ? fmtElapsed(Date.now() - session.runningSince) : "実行中";
    // statusLine 転送のメトリクス（260712_3 案A: 「↓ 70.5k tokens · thinking xhigh」相当）を併記。
    // 未転送・取得不能時は経過時間のみ（フォールバック）
    return session.statsText !== undefined && session.statsText !== "" ? `${elapsed} · ${session.statsText}` : elapsed;
  }
  const meta = STATE_META[session.state];
  return `${meta.label}・${fmtRelative(Date.now() - session.lastEventAt)}`;
}

/** タイルのステータス行を更新（renderGrid と 1 秒毎の時刻更新で共用。差分がある時だけ DOM を触る） */
function updateTileStatus(el: HTMLElement, session: SessionView | undefined): void {
  const statusEl = el.querySelector(".tile-status") as HTMLElement;
  const text = tileStatusText(session);
  if (statusEl.textContent !== text) statusEl.textContent = text;
}

/* ---------------- テーマ（design.md 6.5 / REQ-13） ---------------- */

function resolveTheme(setting: ThemeSetting): "light" | "dark" {
  if (setting === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return setting;
}

function applyTheme(): void {
  if (snap === null) return;
  document.documentElement.dataset.theme = resolveTheme(snap.config.theme);
}

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());

/* ---------------- タイルグリッド（面 1a / 1b） ---------------- */

function createTile(project: Project): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "tile state-waiting";
  el.setAttribute("role", "listitem");
  el.dataset.id = project.id;

  const glow = document.createElement("span");
  glow.className = "tile-glow";
  const name = document.createElement("span");
  name.className = "tile-name";
  const center = document.createElement("span");
  center.className = "tile-center";
  const spinner = document.createElement("span");
  spinner.className = "tile-spinner";
  const icon = document.createElement("span");
  icon.className = "tile-icon";
  // 現在の作業テキスト（260712 課題B: UserPromptSubmit の prompt 由来。未取得時は非表示）
  const work = document.createElement("span");
  work.className = "tile-work";
  work.hidden = true;
  const status = document.createElement("span");
  status.className = "tile-status";
  center.append(spinner, icon, work);
  el.append(glow, name, center, status);

  el.addEventListener("click", () => {
    // クリックで前面化（REQ-05）。失敗メッセージは main からステータスバーへ届く
    void api.focusProject(project.id);
  });
  el.addEventListener("contextmenu", (e) => {
    // 右クリック = プロジェクト操作メニュー（260712_2: 再接続・表示クリア・登録解除）。
    // メニュー本体は main 側のネイティブ Menu（クリック確定処理も main が持つ）
    e.preventDefault();
    void api.showTileMenu(project.id);
  });
  return el;
}

function renderGrid(): void {
  if (snap === null) return;
  const grid = $("#tile-grid");
  const empty = $("#empty-state");
  const projects = snap.projects;

  // 空状態（面 1c / REQ-09）
  empty.hidden = projects.length > 0;
  grid.style.display = projects.length > 0 ? "" : "none";

  const seen = new Set<string>();
  for (const project of projects) {
    seen.add(project.id);
    let el = tileEls.get(project.id);
    if (el === undefined) {
      el = createTile(project);
      tileEls.set(project.id, el);
      grid.appendChild(el);
    }
    const session = snap.sessions[project.id];
    const state = session === undefined ? "waiting" : session.state;
    const cls = `tile ${STATE_META[state].cls}`;
    if (el.className !== cls) el.className = cls; // 同一値の再代入を避けて発光アニメを継続させる
    const nameEl = el.querySelector(".tile-name") as HTMLElement;
    const iconEl = el.querySelector(".tile-icon") as HTMLElement;
    if (nameEl.textContent !== project.name) nameEl.textContent = project.name;
    const icon = STATE_META[state].icon;
    if (iconEl.textContent !== icon) iconEl.textContent = icon;
    // 現在の作業テキスト（260712 課題B）。取得できないセッション・待機タイルは非表示（フォールバック）
    const workEl = el.querySelector(".tile-work") as HTMLElement;
    const work = session?.workText ?? "";
    if (workEl.textContent !== work) workEl.textContent = work;
    workEl.hidden = work === "";
    updateTileStatus(el, session);
  }
  // 登録解除されたタイルを取り除く
  for (const [id, el] of tileEls) {
    if (!seen.has(id)) {
      el.remove();
      tileEls.delete(id);
    }
  }
}

/* ---------------- ステータスバー（REQ-10 / design.md 6.1） ---------------- */

function renderStatusbar(): void {
  // 件数は main の StateStore.counts（Snapshot.counts）を正とし、ここでは整形のみ（重複実装の一本化）
  $("#status-counts").textContent = snap === null ? "0 セッション" : fmtStatusCounts(snap.counts);
  const msgEl = $("#status-message");
  const msg = snap?.statusMessage ?? "";
  // ローカル一時メッセージ表示中は上書きしない
  if (localMessageTimer === undefined && msgEl.textContent !== msg) {
    msgEl.textContent = msg;
  }
}

function showLocalMessage(text: string, ms = 6000): void {
  const msgEl = $("#status-message");
  msgEl.textContent = text;
  if (localMessageTimer !== undefined) window.clearTimeout(localMessageTimer);
  localMessageTimer = window.setTimeout(() => {
    localMessageTimer = undefined;
    renderStatusbar();
  }, ms);
}

/* ---------------- 設定（面 1d / 1f） ---------------- */

function renderSettings(): void {
  if (snap === null) return;

  // テーマ 3 択
  document.querySelectorAll<HTMLButtonElement>("#theme-seg button").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeChoice === snap?.config.theme);
  });

  // 常に手前を規定にする（起動時の既定値。REQ-07 / design.md 8 章）
  const aot = $("#aot-toggle") as HTMLInputElement;
  aot.checked = snap.config.alwaysOnTopDefault;

  // 通知音は MVP では常に OFF・無効（REQ-12 / AC-18）。HTML 側で disabled 固定
  const sound = $("#sound-toggle") as HTMLInputElement;
  sound.checked = snap.config.notifySound.enabled; // 常に false のはず

  // プロジェクト一覧
  const list = $("#project-list");
  list.textContent = "";
  const projects = snap.projects;
  const visible = projectsExpanded ? projects : projects.slice(0, PROJECT_FOLD_LIMIT);
  for (const project of visible) {
    list.appendChild(createProjectRow(project));
  }
  const more = $("#btn-more-projects") as HTMLButtonElement;
  const hiddenCount = projects.length - visible.length;
  if (hiddenCount > 0) {
    more.hidden = false;
    more.textContent = `他${hiddenCount}件を表示`;
  } else if (projectsExpanded && projects.length > PROJECT_FOLD_LIMIT) {
    more.hidden = false;
    more.textContent = "折りたたむ";
  } else {
    more.hidden = true;
  }
}

function createProjectRow(project: Project): HTMLElement {
  const row = document.createElement("div");
  row.className = "project-row";

  const info = document.createElement("div");
  info.className = "project-info";
  const name = document.createElement("div");
  name.className = "project-name";
  name.textContent = project.name;
  const p = document.createElement("div");
  p.className = "project-path";
  p.textContent = project.path;
  info.append(name, p);

  const actions = document.createElement("div");
  actions.className = "project-actions";

  // クリックで開くアプリ: [Cursor｜ターミナル] 2 択（REQ-06 / 面 1d）
  const seg = document.createElement("div");
  seg.className = "segmented small";
  (["cursor", "terminal"] as ClickTarget[]).forEach((target) => {
    const btn = document.createElement("button");
    btn.textContent = target === "cursor" ? "Cursor" : "ターミナル";
    btn.classList.toggle("is-active", project.clickTarget === target);
    btn.addEventListener("click", () => {
      void api.setClickTarget(project.id, target);
    });
    seg.appendChild(btn);
  });

  // 登録解除（REQ-11。モック未記載・設計追加: design.md 6.4）
  const remove = document.createElement("button");
  remove.className = "btn-remove";
  remove.title = `${project.name} を登録解除（hooks も除去）`;
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    void (async () => {
      const result = await api.unregisterProject(project.id);
      if (!result.ok && result.error !== undefined) showLocalMessage(result.error);
    })();
  });

  actions.append(seg, remove);
  row.append(info, actions);
  return row;
}

/* ---------------- ビュー切替・タイトルバー ---------------- */

function switchView(view: "main" | "settings"): void {
  currentView = view;
  $("#view-main").hidden = view !== "main";
  $("#view-settings").hidden = view !== "settings";
  ($("#btn-settings") as HTMLButtonElement).classList.toggle("is-active", view === "settings");
}

function renderTitlebar(): void {
  if (snap === null) return;
  ($("#btn-pin") as HTMLButtonElement).classList.toggle("is-active", snap.pinned);
}

/* ---------------- 全体レンダリング ---------------- */

function render(): void {
  applyTheme();
  renderTitlebar();
  renderGrid();
  renderStatusbar();
  if (currentView === "settings") renderSettings();
}

/** 1 秒毎に時刻表示のみ更新（経過時間・相対時刻。DOM 再構築はしない = NFR-07 に配慮） */
window.setInterval(() => {
  if (snap === null) return;
  for (const [id, el] of tileEls) {
    updateTileStatus(el, snap.sessions[id]);
  }
}, 1000);

/* ---------------- D&D 登録（REQ-01 / 面 1c: ウィンドウ全面が受け付け領域） ---------------- */

let dragDepth = 0;

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth += 1;
  $("#drop-overlay").hidden = false;
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("#drop-overlay").hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  const files = e.dataTransfer?.files;
  if (files === undefined || files.length === 0) return;
  const paths: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const p = api.getPathForFile(file);
      if (p !== "") paths.push(p);
    } catch {
      /* パス解決不能の項目はスキップ */
    }
  }
  if (paths.length === 0) return;
  void (async () => {
    const results = await api.registerProjects(paths);
    const errors = results.filter((r) => !r.ok);
    if (errors.length > 0) {
      showLocalMessage(errors.map((r) => r.error ?? "登録に失敗しました").join(" ／ "));
    }
  })();
});

/* ---------------- イベント結線 ---------------- */

function wireControls(): void {
  $("#btn-pin").addEventListener("click", () => {
    if (snap === null) return;
    void api.setPinned(!snap.pinned); // 常に手前の即時切替（REQ-07）
  });
  $("#btn-theme").addEventListener("click", () => {
    if (snap === null) return;
    const next = resolveTheme(snap.config.theme) === "dark" ? "light" : "dark";
    void api.setTheme(next);
  });
  $("#btn-settings").addEventListener("click", () => {
    switchView(currentView === "settings" ? "main" : "settings");
    render();
  });
  $("#btn-back").addEventListener("click", () => {
    switchView("main");
    render();
  });
  $("#btn-min").addEventListener("click", () => api.windowAction("minimize"));
  $("#btn-max").addEventListener("click", () => api.windowAction("maximize"));
  $("#btn-close").addEventListener("click", () => api.windowAction("close"));

  document.querySelectorAll<HTMLButtonElement>("#theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.dataset.themeChoice as ThemeSetting | undefined;
      if (choice !== undefined) void api.setTheme(choice);
    });
  });

  ($("#aot-toggle") as HTMLInputElement).addEventListener("change", (e) => {
    void api.setAlwaysOnTopDefault((e.target as HTMLInputElement).checked);
  });

  $("#btn-more-projects").addEventListener("click", () => {
    projectsExpanded = !projectsExpanded;
    renderSettings();
  });
}

/* ---------------- 起動 ---------------- */

api.onSnapshot((s) => {
  snap = s;
  render();
  // NFR-01 のログ差分計測: 描画完了を main へ通知（verification.md 3.2）
  window.requestAnimationFrame(() => api.notifyRendered(s.revision));
});

void (async () => {
  wireControls();
  // --view=settings 起動（設定画面の検証・証跡用）
  if (new URLSearchParams(window.location.search).get("view") === "settings") {
    switchView("settings");
  }
  snap = await api.getSnapshot();
  render();
})();
