# TeX64 Code ワークスペース設計

旧 Pro モードは廃止済み。画面上のモードは Code | AI の 2 つだけで、Code は Pro 統合前の
editor-session をそのまま使う。旧 Pro から Code に残す新機能は TikZ 作図キャンバスだけ。

## Code のビューア

- PDF は既存の分割表示を有効にして右グループの通常ビューアで開く。
- 画像・テキスト・PDF のタブは `editor-session` が一貫して所有する。
- Real-time Preview は `code-live-preview.ts` から Code / AI の既存 PDF ビューアへ配布する。別ウィンドウや専用 iframe は使わない。
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

PNG 化、SVG 取り込み、AI 画像変換、`.sty` 書き出し、任意 TikZ コードオブジェクト、グラフの
新規作成 UI は置かない。通常の画像挿入、ソース編集、コンパイルで代替できる処理をキャンバスへ重複実装しない。

主な実装:

- `web-src/app/pro-canvas/`
- `web-src/app/pro-editor-insert.ts`

`pro-` という内部識別子は既存の図データ、イベント名、CSS、テストとの互換性のため残す。
製品上の Pro モードや権限制御を意味しない。

## 撤去済みの旧 Pro 機能

- ソース左・プレビュー右の固定ワークスペース
- Preview の Capture / OCR ツールバー
- スタッシュと AI 一括編集
- 専用の文書構造ドロワー
- ペインの折り畳み、レイアウト選択、手動ファイル Open
- 汎用プログラミング言語ファイルの Code への統合
- キャンバス内の重複エクスポート・取り込み導線

通常の Outline、アプリ全体の数式画像取り込み、Axiom は別機能なので撤去対象ではない。

## 検証

```bash
npx tsc -p web-src/tsconfig.json
node --test tests/pro-canvas-*.test.mjs
```
