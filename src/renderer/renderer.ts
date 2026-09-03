/**
 * ③ UI（renderer）: タイルグリッド / 空状態 / 設定 / ステータスバー（design.md 6 章、モック面 1a〜1f）。
 * ES モジュールとしてビルドする（index.html で type="module" 読み込み）。表示整形の純関数は
 * ./format.ts に分離（単体テスト対象）。main とは preload の window.terminalApp 経由でのみ通信する。
 */
import { fmtElapsed, fmtRelative, fmtStatusCounts, fmtUnlinkedLabel, isUnlinked } from "./format.js";

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

/** 未接続タイルのツールチップ（260903_1）。復帰導線（右クリック →「立ち上げる」）まで案内する */
const UNLINKED_HINT: Record<ClickTarget, string> = {
  cursor: "Cursor でこのフォルダを開いているウィンドウが見つかりません。右クリック →「立ち上げる」で開けます",
  terminal: "このフォルダを開いているターミナルのウィンドウが見つかりません。右クリック →「立ち上げる」で開けます",
};

/** 未接続タイルの件数（260903_1）。ステータスバーのトグルラベル用 */
function countUnlinked(s: Snapshot): number {
  return s.projects.filter((p) => isUnlinked(s.windowPresence[p.id], s.sessions[p.id]?.state)).length;
}

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
  // 見出し行 = プロジェクト名 + 手動ステータスバッジ（260727_1。未割り当て時は hidden）
  const head = document.createElement("span");
  head.className = "tile-head";
  const name = document.createElement("span");
  name.className = "tile-name";
  const badge = document.createElement("span");
  badge.className = "tile-badge";
  badge.hidden = true;
  head.append(name, badge);
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
  el.append(glow, head, center, status);

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
  let visibleCount = 0;
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
    // 未接続（260903_1）: 対象アプリのウィンドウ無し＋実行中／確認待ちでない → 灰色。非表示設定なら隠す
    const unlinked = isUnlinked(snap.windowPresence[project.id], state);
    const cls = `tile ${STATE_META[state].cls}${unlinked ? " is-unlinked" : ""}`;
    if (el.className !== cls) el.className = cls; // 同一値の再代入を避けて発光アニメを継続させる
    const hidden = unlinked && !snap.config.showUnlinked;
    if (el.hidden !== hidden) el.hidden = hidden;
    if (!hidden) visibleCount += 1;
    const hint = unlinked ? UNLINKED_HINT[project.clickTarget] : "";
    if (el.title !== hint) el.title = hint;
    const nameEl = el.querySelector(".tile-name") as HTMLElement;
    const iconEl = el.querySelector(".tile-icon") as HTMLElement;
    if (nameEl.textContent !== project.name) nameEl.textContent = project.name;
    // 手動ステータスバッジ（260727_1）。未割り当ては非表示でレイアウトを崩さない
    const badgeEl = el.querySelector(".tile-badge") as HTMLElement;
    const badge = project.customStatus ?? "";
    if (badgeEl.textContent !== badge) badgeEl.textContent = badge;
    badgeEl.hidden = badge === "";
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
  // 未接続タイルをすべて隠して表示が空になったときの案内（260903_1）。未登録の空状態とは別
  $("#all-hidden-note").hidden = !(projects.length > 0 && visibleCount === 0);
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
  // 未接続タイルの表示／非表示トグル（260903_1）。プロジェクト未登録時は出さない
  const toggle = $("#unlinked-toggle");
  if (snap === null || snap.projects.length === 0) {
    toggle.hidden = true;
    return;
  }
  toggle.hidden = false;
  const label = fmtUnlinkedLabel(countUnlinked(snap));
  const labelEl = $("#unlinked-label");
  if (labelEl.textContent !== label) labelEl.textContent = label;
  ($("#unlinked-check") as HTMLInputElement).checked = snap.config.showUnlinked;
}

/* ---------------- 表示名の変更ダイアログ（260903_2） ---------------- */

let renameTargetId: string | null = null;

/** タイル右クリック →「表示名を変更…」（main から rename-request）と設定画面の ✎ の両方から開く */
function openRenameDialog(projectId: string): void {
  if (snap === null) return;
  const project = snap.projects.find((p) => p.id === projectId);
  if (project === undefined) return;
  renameTargetId = projectId;
  $("#rename-folder").textContent = project.path;
  const input = $("#rename-input") as HTMLInputElement;
  input.value = project.name;
  $("#rename-dialog").hidden = false;
  input.focus();
  input.select();
}

function closeRenameDialog(): void {
  renameTargetId = null;
  $("#rename-dialog").hidden = true;
}

/** 確定。空はフォルダ名へ戻る（main 側の規則）。拒否（上限超過等）はダイアログを開いたままメッセージ表示 */
async function submitRename(): Promise<void> {
  if (renameTargetId === null) return;
  const value = ($("#rename-input") as HTMLInputElement).value;
  const result = await api.setProjectName(renameTargetId, value);
  if (!result.ok) {
    showLocalMessage(result.error ?? "表示名を変更できませんでした");
    return;
  }
  closeRenameDialog();
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

  // 手動ステータスの選択肢一覧（260727_1）
  const statusList = $("#status-list");
  statusList.textContent = "";
  for (const s of snap.config.customStatuses) {
    statusList.appendChild(createStatusRow(s));
  }

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

/** 手動ステータス 1 件の行（260727_1）: ラベル＋使用数＋削除ボタン */
function createStatusRow(statusName: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "status-row";

  const name = document.createElement("span");
  name.className = "status-name";
  name.textContent = statusName;

  const usage = document.createElement("span");
  usage.className = "status-usage";
  const count = snap === null ? 0 : snap.projects.filter((p) => p.customStatus === statusName).length;
  usage.textContent = count > 0 ? `${count} 件で使用中` : "";

  const remove = document.createElement("button");
  remove.className = "btn-remove";
  remove.title = `「${statusName}」を削除（使用中のタイルからも外れます）`;
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    if (snap === null) return;
    void api.setCustomStatuses(snap.config.customStatuses.filter((s) => s !== statusName));
  });

  const info = document.createElement("div");
  info.className = "project-info";
  info.append(name, document.createTextNode(" "), usage);
  row.append(info, remove);
  return row;
}

/** 設定画面の入力欄から手動ステータスを追加（260727_1）。空・重複は追加しない */
function addStatusFromInput(): void {
  if (snap === null) return;
  const input = $("#status-input") as HTMLInputElement;
  const name = input.value.trim();
  if (name === "") return;
  if (snap.config.customStatuses.includes(name)) {
    showLocalMessage(`「${name}」は既にあります`);
    return;
  }
  void api.setCustomStatuses([...snap.config.customStatuses, name]);
  input.value = "";
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

  // 表示名の変更（260903_2）: 右クリックメニューと同じダイアログを設定画面からも開ける
  const rename = document.createElement("button");
  rename.className = "btn-edit";
  rename.title = `${project.name} の表示名を変更`;
  rename.textContent = "✎"; // ✎
  rename.addEventListener("click", () => openRenameDialog(project.id));

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

  actions.append(rename, seg, remove);
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
  const overlay = $("#drop-overlay");
  if (overlay.hidden) {
    // ドラッグ開始時に一度だけ types を記録（ドラッグ中は getData 不可のため types のみ）
    const dt = e.dataTransfer;
    api.dndLog(`dragenter: types=[${dt === null ? "" : Array.from(dt.types).join(", ")}] effectAllowed=${dt?.effectAllowed ?? "-"}`);
  }
  overlay.hidden = false;
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  // Cursor（VS Code 系）は effectAllowed=copyMove 等で渡してくるため、受け側の効果を明示して drop を確実に許可する
  if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "copy";
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
  const dt = e.dataTransfer;
  if (dt === null) return;
  // エクスプローラからのドロップ: 実ファイルのパスを webUtils で解決
  const filePaths: string[] = [];
  for (const file of Array.from(dt.files)) {
    try {
      const p = api.getPathForFile(file);
      if (p !== "") filePaths.push(p);
    } catch {
      /* パス解決不能の項目はスキップ */
    }
  }
  // Cursor（VS Code 系）からのドラッグは files が空のため、DataTransfer の中身を
  // 丸ごと main へ渡してパス抽出（drop-paths.ts）と診断ログ出力を main 側で行う
  const types = Array.from(dt.types);
  const data: Record<string, string> = {};
  for (const t of types) {
    try {
      const v = dt.getData(t);
      if (v !== "") data[t] = v.slice(0, 8000);
    } catch {
      /* getData 不能なタイプはスキップ */
    }
  }
  void (async () => {
    const results = await api.registerDrop({ filePaths, types, data });
    const errors = results.filter((r) => !r.ok);
    if (errors.length > 0) {
      showLocalMessage(errors.map((r) => r.error ?? "登録に失敗しました").join(" ／ "));
    }
  })();
});

/* ---------------- イベント結線 ---------------- */

/** フォルダ選択ダイアログで登録（260727_1: Cursor D&D 不能の代替導線。タイトルバー＋空状態の 2 か所から呼ぶ） */
async function pickProjects(): Promise<void> {
  const results = await api.pickProjects();
  const errors = results.filter((r) => !r.ok);
  if (errors.length > 0) {
    showLocalMessage(errors.map((r) => r.error ?? "登録に失敗しました").join(" ／ "));
  }
}

function wireControls(): void {
  $("#btn-add-project").addEventListener("click", () => {
    void pickProjects();
  });
  $("#btn-pick-empty").addEventListener("click", () => {
    void pickProjects();
  });
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
  $("#btn-restart").addEventListener("click", () => api.windowAction("restart"));
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

  // 手動ステータスの追加（260727_1）: ボタンまたは Enter で確定
  $("#btn-add-status").addEventListener("click", () => addStatusFromInput());
  ($("#status-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") addStatusFromInput();
  });

  // 未接続タイルの表示／非表示（260903_1）
  ($("#unlinked-check") as HTMLInputElement).addEventListener("change", (e) => {
    void api.setShowUnlinked((e.target as HTMLInputElement).checked);
  });

  // 表示名の変更ダイアログ（260903_2）: Enter／保存で確定、Esc／キャンセル／背景クリックで閉じる
  $("#rename-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void submitRename();
  });
  $("#rename-cancel").addEventListener("click", () => closeRenameDialog());
  $("#rename-dialog").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeRenameDialog();
  });
  ($("#rename-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRenameDialog();
  });
}

/* ---------------- 起動 ---------------- */

api.onSnapshot((s) => {
  snap = s;
  render();
  // NFR-01 のログ差分計測: 描画完了を main へ通知（verification.md 3.2）
  window.requestAnimationFrame(() => api.notifyRendered(s.revision));
});

// タイル右クリック →「表示名を変更…」（260903_2）。メニュー本体は main のネイティブ Menu、入力 UI はこちら
api.onRenameRequest((id) => openRenameDialog(id));

void (async () => {
  wireControls();
  // --view=settings 起動（設定画面の検証・証跡用）
  if (new URLSearchParams(window.location.search).get("view") === "settings") {
    switchView("settings");
  }
  snap = await api.getSnapshot();
  render();
})();
