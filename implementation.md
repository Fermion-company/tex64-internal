# TeX64 実装状況（実装同期版）

最終更新: 2026-03-05
対象バージョン: `package.json` 上 `0.1.5`

このファイルは、現在のコード実装を 1 ファイルで把握できるように再整理した実装同期ドキュメントです。

## 1. 現在地（要約）

- [x] Electron デスクトップアプリとして起動・プロジェクト管理・編集・ビルド・PDF/SyncTeX 連携が実装済み
- [x] Math WYSIWYG（MathLive）と数式 OCR（ONNX/Tesseract fallback）を実装済み
- [x] AI Chat / Agent 実行・差分適用・Undo・利用量管理を実装済み
- [x] 認証（OAuth）、サブスク機能判定、アップデート配信確認を実装済み
- [x] 単体テスト / E2E / nightly テストの土台あり
- [ ] Ghost Completion は暫定的に無効化中（フラグで停止）

## 2. システム構成

### 2.1 デスクトップ（Electron）

- エントリ: `electron/main.cjs`
- プリロード: `electron/preload.cjs`, `electron/pdf-preload.cjs`
- 主要責務:
  - セキュアな BrowserWindow 起動（contextIsolation + preload）
  - 単一起動制御（single-instance lock）
  - IPC ルーティングの集中登録（workspace/build/files/search/settings/env/platform/auth/update/agent）
  - 定期アップデートチェック（起動後 + 6 時間間隔）
  - PDF サブウィンドウ連携

### 2.2 レンダラ（Web UI）

- エントリ: `web-src/main.ts` → `web-src/app/main-init.ts`
- 主要責務:
  - Monaco ベース編集体験（タブ/分割表示）
  - ワークスペースツリー、ファイル操作、検索、アウトライン
  - ビルド実行・ログ・Issues 表示
  - SyncTeX forward/reverse の UI 連携
  - Math WYSIWYG / 数式キーボード / OCR 挿入
  - AI Chat UI・差分プレビュー/適用/Undo
  - 認証・利用量・アップデート UI の状態反映
- ブリッジ:
  - `web-src/app/bridge-sender.ts`（送信）
  - `web-src/app/bridge-handlers.ts`（受信）

### 2.3 API / Platform 層

- API:
  - `api/ai-chat.js`（legacy）
  - `api/v2/ai/chat.js`, `api/v2/ai/completion.js`（現行）
  - `api/v2/auth/*`, `api/v2/me/features.js`, `api/v2/internal/subscription.js`
- 共通ライブラリ: `api/v2/_lib/*`
  - JWT、OAuth/PKCE、環境設定、DB/ユーザー文脈、quota 消費管理、Gemini 呼び出し等

## 3. 機能別実装状況

### 3.1 ワークスペース・ファイル

- `electron/services/workspace.cjs` を中心に実装
- 実装済み:
  - プロジェクト作成/オープン、recent projects
  - ルート TeX 解決（`!TEX root` 考慮）
  - ファイル作成/保存/リネーム/移動/コピー/削除
  - Undo（移動/削除の復元）
  - `.tex64/settings.json` ベース設定保存
  - テキスト抜粋、画像/PDF プレビュー補助

### 3.2 ビルド・PDF・SyncTeX

- ビルドサービス: `electron/services/build/*`
- 実装済み:
  - `latexmk` 実行（engine/profile/outDir/extraArgs）
  - 問題解析（log から issue 抽出）
  - PDF パス探索（outdir/fls/fdb/recent file を併用）
  - `xypdf` 異常時の pdflatex リトライ導線
  - Build cancel/clean
- SyncTeX:
  - `electron/services/synctex/*`
  - forward/reverse 双方向、候補スコアリング、再試行、パス正規化を実装

### 3.3 エディタ補助（フォーマット/索引/検索）

- フォーマット: `electron/services/formatter.cjs`
  - `latexindent` 利用 + fallback formatter
  - インデント/整列/空行/verbatim/custom env 設定対応
- 索引: `electron/services/indexer.cjs`
  - label/ref/citation/section/figure/table/todo 抽出
- 検索: `electron/services/search.cjs`
  - `.tex` 対象全文検索 + プレビュー

### 3.4 Math WYSIWYG / OCR

- Math UI:
  - `web-src/math-wysiwyg/*` + `web-src/mathlive/*`
  - ブロック挿入・編集・プレースホルダ付き matrix/aligned 系処理
- OCR:
  - `electron/services/math-ocr/*`
  - ONNX pix2tex 推論、失敗時 Tesseract fallback
  - 候補スコアリングと LaTeX 正規化を実装

### 3.5 AI Chat / Agent

- ハンドラ: `electron/handlers/agent.cjs`
- サービス: `electron/services/agent/*`
- 実装済み:
  - セッション開始/再開/中断
  - ツール呼び出しループ（read-only 並列処理含む）
  - 提案差分の apply/undo（run 単位 undo 含む）
  - 端末セッション実行、ファイル操作ツール、Web ツール
  - 監査ログ・状態永続化・自動ビルド連携
- 制限:
  - Ghost Completion は `GHOST_COMPLETION_TEMP_DISABLED = true` で停止中

### 3.6 認証・課金・利用量・アップデート

- `electron/services/platform-access/*` に集約
- 実装済み:
  - OAuth セッション管理（safeStorage 利用可能時は暗号化）
  - アクセストークン更新
  - AI 利用可否・利用量判定
  - 送信/返信 API の正規化
  - update manifest 取得、ダウンロード/適用ハンドラ
  - フィードバック/エラー報告 API

## 4. IPC / ハンドラ実装範囲

- `electron/main.cjs` から登録される主要チャネル:
  - workspace/project/files/search/settings
  - build/clean/cancel/synctex
  - env checks/install
  - platform state/auth/usage/update
  - agent run/resume/abort/apply/undo
  - feedback/error report

## 5. テスト状況

- 単体: `tests/unit/*`
  - build/update/auth/storage/subscription
  - agent runtime/edit/build
  - blocks/math WYSIWYG/OCR
- E2E: `tests/e2e/*`
  - math-wysiwyg-ui
  - ai-chat-apply-undo
- Nightly: `tests/nightly/*`
  - blocks fuzz/perf 系

## 6. 既知の制約・未完了項目

- Ghost Completion は意図的に無効化中（再有効化時は品質検証が必要）
- 外部依存コマンド（`latexmk`, `latexindent` 等）が未導入環境では機能制限あり
- AI/API 系は環境変数・認証状態・quota 状態に依存

## 7. 実行/開発コマンド（主要）

- 開発起動: `npm run dev`
- Web build: `npm run web:build`
- 単体テスト: `npm run test:unit`
- E2E（Math WYSIWYG）: `npm run test:e2e:math-wysiwyg-ui`
- E2E（AI apply/undo）: `npm run test:e2e:ai-chat-apply-undo`
- nightly: `npm run test:nightly`

## 8. 更新ポリシー（このファイル）

- 仕様ではなく「実装事実」を優先して更新する
- 大規模変更時は、最低でも以下を同期する:
  - 機能別実装状況（第 3 章）
  - 既知制約（第 6 章）
  - テスト状況（第 5 章）
