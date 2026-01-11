# Search implementation

## 目的

- ワークスペース内の `.tex` を検索し、結果から該当行へジャンプする。

## 主要ファイル

- `web-src/app/search-ui.ts`: 入力/結果描画/クリック処理。
- `electron/services/search.cjs`: `.tex` を走査して最大200件まで返す。
- `electron/handlers/workspace.cjs`: `search` を受信して結果を送信。
- `web-src/app/editor-session.ts`: `jumpToFileLine` でジャンプ。

## フロー

- 検索入力 → `postToNative({ type: "search" })` → `updateSearch` で結果反映。

## 制約

- 検索対象は `.tex` のみ。
- 最大200件で打ち切り。

## ユーザーメモ
これも表示を調整