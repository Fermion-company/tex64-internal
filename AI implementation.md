# AI implementation

## 目的

- サイドバーの AI チャットで提案を出し、差分プレビュー経由で適用する。

## 主要ファイル

- `web-src/app/ai-chat-ui.ts`: チャット/提案 UI 管理。
- `web-src/app/diff-modal.ts`: ブロック挿入や Git で使う差分モーダル。
- `web-src/app/bridge-handlers.ts`: `agent:*` イベント受信。
- `web-src/app/bridge-sender.ts`: `agent:*` 送信。
- `electron/services/agent.cjs`: LLM ループと提案管理。
- `electron/services/agent-tools.cjs`: ツール宣言。
- `electron/services/agent-llm.cjs`: Gemini proxy 呼び出し。
- `electron/handlers/agent.cjs`: IPC ハンドラ。
- `electron/main.cjs`: message ルーティング。

## ループ/ツール

- system prompt は `buildSystemPrompt` で構築。
- アクティブファイルのスナップショット（内容/未保存かどうか）を含める。長い場合は先頭のみ。
- 開いているタブの一覧とスナップショット（未保存含む）もコンテキストに含める。
- 出力の冒頭に「方針/理由」の短い要約を付けるルール。
- 最大反復回数: 12（`agent.maxIterations` で調整可）。
- ツール:
  - `list_files`
  - `read_file`
  - `read_files`
  - `search_files`
  - `get_project_structure`
  - `get_index` (ラベル/参照/引用/セクション等のインデックス)
  - `rename_latex_symbol` (label/cite/ref の一括リネーム)
  - `run_build` (ビルド検証)
  - `run_command` (ターミナル実行)
  - `get_app_settings` / `set_app_settings` (アプリ設定の参照/更新)
  - `propose_write`
  - `propose_patch` (複数ファイル/複数箇所・replaceAll 対応)
  - `propose_delete`
  - `propose_rename`
  - `propose_create_directory`

## 安全制約

- ブロック対象は既定でなし（`agent.blockedTopLevel` で設定可）。
- 既定で拡張子/サイズ/件数の制限なし（`agent.maxFileBytes` / `agent.maxReadFiles` で制限可）。
- バイナリは `encoding: base64` で読み書きできる。
- 変更は提案のみ（`agent.autoApply` 有効時は自動適用）。

## 適用フロー

- `propose_*` で提案を生成 → `agent:proposal` で UI に通知。
- チャット内の提案カードで差分を展開 → `agent:apply` で適用（`agent.autoApply` 有効時は自動適用）。
- `applyProposal` が write/patch/delete/rename/mkdir を実行 → workspace/index を更新。

## 設定

- `tex64-user-settings.json`:
  - `agent.temperature`
  - `agent.maxOutputTokens`
  - `agent.maxFileBytes` (任意)
  - `agent.maxReadFiles` (任意)
  - `agent.maxIterations` (任意)
  - `agent.stream` (任意: ストリーミング)
  - `agent.autoApply` (任意: 変更案の自動適用)
  - `agent.autoBuild` (任意: ビルド検証の自動実行)
  - `agent.openFileMaxBytes` (任意)
  - `agent.openFileMaxChars` (任意)
  - `agent.allowedTopLevel` (任意)
  - `agent.blockedTopLevel` (任意)
  - `agent.textExtensions` (任意: 置き換え)
  - `agent.extraTextExtensions` (任意: 追加)
- 既定 proxy: `https://tex64.vercel.app/api/ai-chat`
- 上書き: `TEX64_AI_PROXY_URL`

## UX

- 実行中は `agent:status` を段階的に更新し、進捗を表示する。
- ストリーミング応答時は `agent:messageDelta` で逐次表示する。
- 検索パネルからシンボルリネームを実行でき、提案は AI パネルに出る。

## ユーザーメモ
AIの動きを集中的に治療
