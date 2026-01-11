# Files implementation

## 目的

- ワークスペースのファイルツリー表示とファイル操作（作成/削除/移動など）。

## 主要ファイル

- `web-src/app/file-tree-ui.ts`: モーダル/ショートカット/コンテキストメニュー/操作要求。
- `web-src/app/file-tree-render.ts`: ツリー描画と DnD UI。
- `web-src/app/file-tree-utils.ts`: パス正規化・バリデーション・DnD payload。
- `web-src/app/workspace-controller.ts`: `updateWorkspace` payload を保持。
- `electron/handlers/workspace.cjs`: open/create/rename/delete/move/copy/undo を受信。
- `electron/services/workspace.cjs`: 実ファイル操作と `.tex64/.trash` への退避。

## UIフロー

- ファイルクリック → `requestOpenFile` → `openFile` IPC。
- 右クリック → 独自メニュー → 操作種別に応じ `postToNative`。
- DnD → `moveItem` を送信（親配下への移動は禁止）。
- `⌘C/⌘X/⌘V/⌘Z` → copy/cut/paste/undo。

## IPC/Bridge

- Renderer → Main: `openFile`, `createFile`, `createFolder`, `renameItem`, `deleteItem`,
  `moveItem`, `copyItem`, `undoFileOperation`, `revealInFinder`。
- Main → Renderer: `updateWorkspace`, `tex64OpenFileResult`, `tex64RenameResult`。

## 状態/保存

- localStorage:
  - `tex64.tree.<workspaceRootKey>`: フォルダ展開状態。

## ガード/制約

- `..` / 絶対パスは禁止、ファイル名の末尾 `/` は禁止。
- 未保存がある対象の rename/move は拒否。
- DnD payload は `application/x-tex64-item` を使用。

## ユーザーメモ
