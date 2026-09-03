# terminal-app

Claude Code の並行セッションを監視する Windows 11 常駐タイルダッシュボード（Electron）。
**どのセッションが止まったかをひと目で識別し、1 クリックで対象ウィンドウ（Cursor / ターミナル）に切り替える。**

- 要件: `docs/spec.md`（REQ / NFR / AC / OPEN の正本）
- 設計: `docs/design.md`（モジュール分割・hooks 連携・UI はモック面 1a〜1f 準拠）
- 検証: `docs/verification.md`（V-01〜V-20）／実行記録: `docs/verification-results.md`

## 動作要件

- Windows 11 / Node.js 22+ / npm
- `curl.exe`（Windows 10+ 同梱。hooks からのイベント送信に使用）

## セットアップ

```
npm install
npm run build
```

## 起動

```
npm start
```

- フォルダをウィンドウへドラッグ&ドロップするとプロジェクトが登録され、
  対象の `.claude/settings.json` に **Stop / Notification / UserPromptSubmit の 3 イベント**の
  hooks が自動追記される（既存設定は保全・バックアップ `settings.json.terminal-app.bak` 作成・冪等。
  UserPromptSubmit はプロンプト送信＝実行開始の検知用 — タイルが「実行中」（スピナー＋経過時間）になる）。
- **起動時追補**: アプリ起動時に登録済み全プロジェクトの hooks を冪等に再マージし、不足イベントのみ
  追記する。旧 2 イベント構成で登録済みのプロジェクトにも**再登録なしで** UserPromptSubmit が行き渡る。
- 自アプリ分の hooks は command 内の URL パス `/terminal-app/event` で識別する（`terminal-app` を
  パスに含むだけのユーザー自身の hook は除去・置換の対象にならない）。
- タイルをクリックすると、そのプロジェクトに設定した対象（Cursor / ターミナル）を前面化する。
- **未接続タイル**: クリックで開く対象アプリ（Cursor / ターミナル）でそのフォルダを開いているウィンドウが
  見つからないタイルは灰色で表示される（約 5 秒ごとに判定。実行中・確認待ちのタイルは誤判定で隠さないよう対象外）。
  ステータスバー右端の「未接続を表示」トグルで非表示にでき、設定は再起動後も保持される。
  右クリック →「立ち上げる」で対象アプリを開くと数秒で通常表示に戻る。
- **表示名**: タイル右クリック →「表示名を変更…」または設定画面の ✎ で、フォルダ名とは別の表示名を付けられる
  （空にするとフォルダ名へ戻る。前面化・切断検知の対象探索はフォルダ名のまま）。
- 登録解除は設定画面（歯車アイコン）の各プロジェクト行の × ボタン。自アプリ分の hooks のみ除去する。
- トースト通知・サウンドは次期スコープ（REQ-12）。設定 UI は無効表示のみで音は鳴らない。

## テスト・検証

| コマンド | 内容 |
|----------|------|
| `npm test` | 単体・統合テスト（Vitest。hooks マージ/除去・状態遷移・HTTP 受信・永続化） |
| `npm run typecheck` | main / renderer / tests の型検査 |
| `npm run lint` | ESLint |
| `npm run smoke:win32` | Win32 FFI（ウィンドウ列挙・前面化 API）のスモーク確認 |
| `node scripts/verify-injection.mjs <出力先>` | デモ起動＋擬似イベント注入（UserPromptSubmit→実行中を含む）＋バインド確認（verification.md 3.4 / 3.7）を自動実行し証跡を残す |
| `node scripts/verify-upgrade.mjs <出力先>` | 旧 2 イベント構成サンドボックスへの起動時追補（before/after）と UserPromptSubmit 注入→実行中表示を実測し証跡を残す（実 %APPDATA%・実プロジェクトに非接触） |
| `node scripts/verify-real-session.mjs <出力先>` | 実 `claude -p` セッション＋マージ済み実 hook コマンドで、hooks 整備→実行中→完了→再起動保持→未起動時の無害性を通しで実測し証跡を残す（専用ポートで実稼働アプリと共存） |
| `node scripts/verify-foreground.mjs <出力先>` | 実ターミナルウィンドウを開き、前面化（V-09 #8）と最小化からの復元＋前面化（#9）を GetForegroundWindow / IsIconic で実測する（実行中は一瞬フォーカスが移る） |
| `node scripts/verify-unlinked-rename-e2e.mjs [出力先]` | デモ起動を CDP（remote-debugging）で操作し、未接続タイルの灰色表示・トグル非表示・config 保持と、表示名の変更ダイアログ（保存／上限拒否／空でフォルダ名復帰）を実 IPC 往復で確認し、スクリーンショットを残す |

検証・証跡用の起動フラグ（`npx electron . <flags>`）:

- `--demo` — モック面 1b 相当の 12 タイルをシードして起動（一時データディレクトリ使用。実設定・実 hooks に触れない）
- `--demo-count=16` — 16 タイル（NFR-05 の確認用）
- `--view=settings` — 設定画面を初期表示
- `--theme=light|dark|auto` — テーマの一時上書き
- `--capture=<path> [--capture-delay=<ms>]` — スクリーンショット PNG を保存して自動終了

## 構成（design.md 3.1 のモジュール分割に対応）

```
src/
  main/
    event-server.ts    … ① イベント受信サーバ（127.0.0.1:41321、POST /terminal-app/event）
    state-store.ts     … ② 状態ストア（スキーマ検証・4 状態遷移・cwd 最長一致・直近セッション優先）
    project-store.ts   … ② の永続化（%APPDATA%\terminal-app\projects.json / config.json）
    hooks-manager.ts   … ④ hooks 設定マネージャ（settings.json の安全マージ/除去・バックアップ・アトミック書き込み）
    window-control.ts  … ⑤ ウィンドウ制御（koffi/user32: EnumWindows・SetForegroundWindow・復元）
    index.ts           … 結線・BrowserWindow・IPC・多重起動禁止・受信→描画レイテンシログ
    demo.ts / logger.ts / paths.ts / constants.ts
  preload/index.ts     … contextBridge（window.terminalApp）
  renderer/            … ③ UI（タイルグリッド / 空状態 / 設定 / ステータスバー。モック 1a〜1f 準拠）
tests/                 … Vitest（verification.md 5 章の単体・統合枠）
scripts/               … build 補助・スモーク・注入検証
```

## データ・ログの場所

- 設定・登録情報: `%APPDATA%\terminal-app\`（`projects.json` / `config.json`）
- ログ: `%APPDATA%\terminal-app\logs\app.log`（日次ローテーション・7 日保持）
- 環境変数 `TERMINAL_APP_DATA_DIR` でデータディレクトリを差し替え可能（テスト・デモ用）
- 環境変数 `TERMINAL_APP_WINDOW_POLL_MS` で未接続タイル判定（ウィンドウ列挙）の間隔を変更可能（既定 5000ms。検証用）

## 既知の制約（MVP）

- アプリ未起動中のイベントは取りこぼす（design.md 3.3 の採用仕様）
- エラー検知の網羅範囲（クラッシュ等）は OPEN-03 として技術検証待ち。受信形式は design.md 4.8 で定義済み
- セッション状態は揮発（再起動で全タイル「待機」に戻る）
