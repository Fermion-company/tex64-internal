# Blocks implementation

## 目的

- 数式/表ブロックの検出・編集・挿入を行う。

## 主要ファイル

- `web-src/app/blocks/auto-detect.ts`: カーソル位置からブロック検出/ハイライト。
- `web-src/app/blocks/detect.ts`: LaTeX テキストのブロック解析。
- `web-src/app/blocks/edit-session.ts`: 検出状態の管理と切替。
- `web-src/app/blocks/input-ui.ts`: 数式/表入力UI。
- `web-src/app/blocks/insert-flow.ts`: 差分プレビュー → 挿入/置換。
- `web-src/app/blocks/format.ts`: インデント調整。
- `web-src/app/blocks/mathlive.ts`: MathLive 初期化とフォールバック。
- `web-src/app/math-keyboard-ui.ts`: 数式キーボード UI。
- `web-src/app/env-registry-ui.ts`: math/table 環境レジストリ。
- `electron/handlers/misc.cjs`: `blocks:save` を受信。
- `electron/services/blocks.cjs`: `.tex64/blocks.json` に履歴保存。

## フロー

- カーソル移動 → 自動検出 → ブロックハイライト。
- 入力UIで編集 → 差分プレビュー (`diff-modal`) → 確定。
- 確定時に `blocks:save` を送信して履歴保存。

## 制約

- `.tex` のみ挿入可。
- verbatim 系は検出対象外。
- テーブル検出は環境レジストリに依存。

## ユーザーメモ

