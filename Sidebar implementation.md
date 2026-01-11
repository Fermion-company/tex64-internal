# Sidebar implementation

## 目的

- 左サイドバーのタブ切替 / 可視性 / リサイズを担当する。

## 主要ファイル

- `web-src/app/config.ts`: TabKey とタブ表示文言の定義。
- `web-src/app/tab-controller.ts`: active tab の切替、パネル表示、`body.dataset.activeTab` 更新。
- `web-src/app/sidebar-ui.ts`: タブ表示/非表示の管理と右クリックメニュー。
- `web-src/app/sidebar-resizer-ui.ts`: リサイズバーのドラッグ処理。
- `web-src/app/ui-events.ts`: タブクリックのイベント登録。

## 挙動メモ

- 可視性は `tex64.sidebar.primaryTabs` に保存し、最低1タブは常に表示。
- リサイズは `--sidebar-panel-width` を更新し、Monaco の layout を再実行。
- 右クリックメニューは primary のみ対象（`.tab-group.secondary` は除外）。

## 状態/保存

- localStorage:
  - `tex64.sidebar.primaryTabs`: 表示タブ一覧。

## ユーザーメモ

