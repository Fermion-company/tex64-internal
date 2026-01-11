# AI implementation

## 目的

- サイドバーの AI チャットで提案を出し、差分プレビュー経由で適用する。

## 主要ファイル

- `web-src/app/ai-chat-ui.ts`: チャット/提案 UI 管理。
- `web-src/app/diff-modal.ts`: AI 適用の差分プレビュー。
- `web-src/app/ui-events.ts`: `aiApply` の確定/キャンセル。
- `web-src/app/bridge-handlers.ts`: `agent:*` イベント受信。
- `web-src/app/bridge-sender.ts`: `agent:*` 送信。
- `electron/services/agent.cjs`: LLM ループと提案管理。
- `electron/services/agent-tools.cjs`: ツール宣言。
- `electron/services/agent-llm.cjs`: Gemini proxy 呼び出し。
- `electron/handlers/agent.cjs`: IPC ハンドラ。
- `electron/main.cjs`: message ルーティング。

## ループ/ツール

- system prompt は `buildSystemPrompt` で構築。
- 最大反復回数: 6。
- ツール:
  - `list_files`
  - `read_file`
  - `read_files` (最大10件)
  - `search_files`
  - `get_project_structure`
  - `propose_write`
  - `propose_patch`
  - `propose_delete`
  - `propose_rename`
  - `propose_create_directory`

## 安全制約

- ブロック対象: `.tex64` / `node_modules` / `Resources`。
- テキスト拡張子のみ読み書き可。
- 1ファイル最大 1MB。
- 変更は提案のみで自動適用しない。

## 適用フロー

- `propose_*` で提案を生成 → `agent:proposal` で UI に通知。
- UI が差分モーダルを表示 → `agent:apply` で適用。
- `applyProposal` が write/patch/delete/rename/mkdir を実行 → workspace/index を更新。

## 設定

- `tex64-user-settings.json`:
  - `agent.temperature`
  - `agent.maxOutputTokens`
- 既定 proxy: `https://tex64.vercel.app/api/ai-chat`
- 上書き: `TEX64_AI_PROXY_URL`

## ユーザーメモ

