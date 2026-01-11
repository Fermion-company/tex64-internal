# Settings implementation

## 目的

- エディタ共通の設定（コンパイル/SyncTeX/整形）を管理する。

## 主要ファイル

- `web-src/app/settings-ui.ts`: UIと localStorage の読み書き。
- `web-src/app/build-ops-ui.ts`: 整形/ビルド時に設定を参照。
- `electron/services/env.cjs`: TeX/latexmk の検出/インストール。

## 保存キー

- `tex64.compileEngine`
- `tex64.editor.autoSynctexOnBuild`
- `tex64.editor.pdfViewerMode`
- `tex64.editor.alignEnv`
- `tex64.editor.formatSettings`

## 環境チェック

- `env:check` / `env:install` を Main に送信し結果を表示。
