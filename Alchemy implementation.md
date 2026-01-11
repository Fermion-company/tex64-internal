# Alchemy implementation

## 目的

- 画面キャプチャ → OCR → TeX 挿入を行う。

## 主要ファイル

- `web-src/app/alchemy-convert.ts`: UI/設定/挿入処理。
- `web-src/app/capture-ui.ts`: ウィンドウ選択/切り取りモーダル UI。
- `web-src/app/magic-capture.ts`: ウィンドウ一覧取得とトリミング処理。
- `web-src/app/ocr.ts`: Tesseract で OCR 実行（キュー管理）。
- `web-src/app/snippet-builders.ts`: テキスト→TeX 変換。
- `web-src/app/blocks/format.ts`: 挿入時のインデント調整。
- `electron/preload.cjs`: `window.tex64Capture.listSources` を公開。
- `electron/services/user-settings.cjs`: OCR 言語設定保存。

## フロー

- 「キャプチャして変換」 → `tex64Capture.listSources` → 窓選択。
- 切り取り範囲を選択 → 画像 DataURL → OCR。
- OCR 結果を `buildTextSnippet` で TeX 化 → Monaco に挿入。

## 設定

- `alchemy:settings` を `tex64-user-settings.json` に保存。
- 言語は `ocrLanguage`（例: `jpn+eng`）。

## 制約

- `.tex` 以外には挿入不可。
- OCR 空結果はエラーとして Issues に通知。

## ユーザーメモ

