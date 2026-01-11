# Issues implementation

## 目的

- エラー/警告を集約表示し、クリックで該当行へジャンプする。

## 主要ファイル

- `web-src/app/issues-ui.ts`: リスト描画とクリック処理。
- `web-src/app/workspace-controller.ts`: 件数/状態/タブ警告の管理。
- `web-src/app/editor-session.ts`: `parseIssueDetail` / `focusIssue` でジャンプ。

## データフロー

- Main から `tex64UpdateIssues` → `workspace-controller.updateIssues` → `issues-ui.render`。

## 補足

- build/format/save 等の失敗も Issues に集約される。

## ユーザーメモ
issueの表示が正しくないことを治療