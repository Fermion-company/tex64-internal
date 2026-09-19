# TeX64 Code ワークスペース設計

旧 Pro モードは廃止済み。画面上のモードは Code | AI の 2 つだけで、Code は Pro 統合前の
editor-session をそのまま使う。旧 Pro から Code に残す新機能は TikZ 作図キャンバスだけ。

## Code のビューア

- PDF は既存の分割表示を有効にして右グループの通常ビューアで開く。
- 画像・テキスト・PDF のタブは `editor-session` が一貫して所有する。
- Real-time Preview は `code-live-preview.ts` から Code / AI の既存 PDF ビューアへ配布する。通常 Build の表示設定が別ウィンドウなら同じ状態をその PDF ビューアにも配布し、ライブ専用ウィンドウは作らない。
- 固定プレビューペイン、専用ヘッダー、専用 splitter、専用比率設定は作らない。
- PDF の紙面はテーマで反転しない。ダークテーマでも原稿どおりの色で表示する。

主な実装:

- `web-src/app/editor-session/`
- `web-src/app/code-live-preview.ts`
- `web-src/app/viewer.ts`
- `Resources/web/pdf-viewer.html`

## Code に残す旧 Pro 機能: TikZ 作図

TikZ 作図キャンバスは、基本図形を描いて本文へ TikZ コードとして挿入・再編集する機能に限定する。

- 選択、曲線、直線、矩形、楕円、数式ラベル
- グリッド吸着、Undo / Redo、ズーム
- TikZ コードの挿入と埋め込みメタデータからの再編集
- 過去に作成されたコードオブジェクトやグラフの読込・描画は互換性のため維持するが、新規作成 UI は出さない

現在のUIにはPNG化、SVG取り込み、AI画像変換、`.sty`書き出し、任意TikZコードオブジェクト、グラフの新規作成はない。通常の画像挿入、ソース編集、コンパイルで代替できる処理をキャンバスへ重複実装しない。

主な実装:

- `web-src/app/pro-canvas/`
- `web-src/app/pro-editor-insert.ts`

`pro-` という内部識別子は既存の図データ、イベント名、CSSとの互換性のため残す。
製品上の Pro モードや権限制御を意味しない。

通常のOutline、アプリ全体の数式画像取り込み、Axiomはそれぞれ独立した機能。検証は [../AGENTS.md](../AGENTS.md) に従う。
