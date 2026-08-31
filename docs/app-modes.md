# TeX64 デスクトップのモード

一般配布のデスクトップ版は **Code と AI**を提供し、トップバーで切り替える。
`tex64.appMode.v1` に最後の選択を保存し、廃止した `pro` 値だけを Code へ移行する。

- **Code** — LaTeXソース、通常PDF / Liveプレビュー、TikZ、Axiomチャットを扱う。
- **AI** — 同じワークスペースを紙面中心で扱い、会話から執筆・編集・組版する。

Code内のAxiomチャットと課金導線も引き続き提供する。

## AIモード実装の境界

- CodeからAIへ移る前に、開いている未保存バッファをすべて保存する。
- どちら向きの切替でも、実行中のAxiomと組版を中断し、実際に終了したことを確認してから画面を替える。
- プロジェクト切替でも同じ停止境界を使う。古い世代の組版、ファイル応答、SyncTeX応答は新しい
  ワークスペースへ適用しない。
- AIの会話・紙面・undoは `workspaceId + CodeのrootFile` 単位。AIが書いた内容はCode側の開いている
  Monaco modelにも保存済み内容として反映し、後の保存で古い内容へ戻さない。
- 段落の直接編集は全文上書きではなく、読取時のcontent hashを使うcompare-and-swapで行う。

## 認証・課金・モデル

Code内のAxiomで見せるモデルは `Axiom1.0` とPro限定の `Axiom1.0-pro` の2つ。認証、AI利用可否、
トークン利用量、プラン変更はCodeと同じElectron側の課金実装へ接続する。利用量として表示するのは
トークンだけで、内部コストやドル予算は出さない。

## アプリへの同梱

`services/tex64-ai` のNext.js standalone出力をアプリへ同梱し、ElectronがローカルUIサーバーとして起動する。
外部AI UIへフォールバックせず、ワークスペースのファイル取得はElectronの許可制bridgeだけを通す。

## 実装上の注意

- rendererは `web-src/` を編集し、`Resources/web/**/*.js` は `tsc` の生成物とする。
- `Resources/web/index.html` と `Resources/web/theme.css` は直接編集する。
- モード切替とguest境界の回帰確認は `tests/app-mode.test.mjs`、ワークスペース世代と組版相関は
  `tests/workspace-generation.test.cjs` と `tests/build-event-correlation.test.cjs` が担う。
- UI変更は型検査だけで終えず、パッケージしたmacOSアプリで主要操作を確認する。
