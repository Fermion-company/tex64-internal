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
- TeX Distribution は `lualatex` / `pdflatex` / `xelatex` / `uplatex` のいずれかを検出できれば利用可能扱い。
- `latexmk` / `latexindent` / `synctex` もチェック対象。
- `env:checkResult` は `bridge-handlers` 経由で Settings UI に反映される。
- `latexindent` / `synctex` のインストール導線は TeX Distribution（basictex）に紐付ける。
- 実行環境のボタンは常時表示で、検出済みでも更新/再インストールを実行できる。

## ユーザーメモ
内容を調整
