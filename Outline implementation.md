# Outline implementation

## 目的

- 現在ファイルの章節/TODO/ラベル/参考文献を一覧表示し、クリックでジャンプする。

## 主要ファイル

- `web-src/app/outline-ui.ts`: リスト描画と空状態メッセージ。
- `web-src/app/index-utils.ts`: 重複除去と引用フィルタ。
- `web-src/app/workspace-controller.ts`: `updateIndex` payload を保持。
- `electron/services/indexer.cjs`: .tex/.bib を走査してインデックス生成。

## データフロー

- Main が `updateIndex` を送信 → `workspace-controller` が保持 → `outline-ui` が再描画。
- 表示対象は active file のみ。

## ジャンプ

- `editor-session.ts` の `jumpToLocation` / `jumpToFileLine` を使用。

## 空状態

- ワークスペース未選択 / ファイル未選択 / 項目なしで文言を切替。

## ユーザーメモ
ラベル等の表示の論理を詰める
二画面にして、右側に表示
