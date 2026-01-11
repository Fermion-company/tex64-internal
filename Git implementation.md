# Git implementation

## 現状

- `web-src` に Git UI のソースが存在しない。
- 生成物として `Resources/web/app/git-ops-ui.js` / `git-panel-ui.js` が残っている。
- `electron` 側に Git ハンドラ/サービスが未実装のため、Gitメッセージは処理されない。

## 関連ファイル

- `Resources/web/index.html`: Git 用の DOM ID が定義されている（非表示）。
- `web-src/app/types.ts`: Git の型定義のみ存在。

## 実装を進める場合

- `web-src` に Git UI を移植し、`electron/handlers` + `electron/services` で Git 操作を実装する。

## ユーザーメモ
最初はいらないかもしれない
