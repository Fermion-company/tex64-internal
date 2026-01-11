# Editor implementation

## 目的

- Monaco を中心とした編集体験、タブ/分割、ビューア、ビルド/整形/SyncTeX を統合する。

## 主要ファイル

- `web-src/app/editor-session.ts`: エディタ状態/タブ/dirty/IME保護。
- `web-src/app/editor-session-file-ops.ts`: open/save/auto-save の実処理。
- `web-src/app/monaco-setup.ts`: Monaco 初期化と補完登録。
- `web-src/app/editor-tabs-ui.ts`: タブ描画/ドラッグ/分割。
- `web-src/app/viewer.ts`: PDF/画像/非対応ビューア。
- `web-src/app/build-ops-ui.ts`: build/format/SyncTeX ボタン。
- `electron/handlers/build.cjs`: build/format/synctex を受信。
- `electron/services/build.cjs`: latexmk 実行。
- `electron/services/formatter.cjs`: latexindent 実行とフォールバック。
- `electron/services/synctex.cjs`: forward SyncTeX。
- `electron/handlers/workspace.cjs`: openFile/saveFile の受信。

## 編集/保存

- `openFile` → `tex64OpenFileResult` で内容を反映。
- `saveFile` → `tex64SaveResult` で保存結果を反映。
- auto-save は 400ms 遅延で実行。

## タブ/分割

- 2グループ（primary/secondary）を保持。
- タブ DnD でグループ間移動。
- 分割ボタンで表示切替。

## Monaco

- AMD ローダ経由で `monaco/vs/` を読み込み。
- `\ref{` / `\cite{` の補完を登録。

## ビューア

- PDF/画像は viewer を表示、非対応は placeholder。
- PDF は `pdf-viewer.html` iframe へ postMessage で同期。

## ビルド/整形/SyncTeX

- build/format は Main 側サービスへ委譲。
- SyncTeX は `.tex` のみ、ビルド成功時に自動 forward（設定で制御）。

## ユーザーメモ
予測を設定