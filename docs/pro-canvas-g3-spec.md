# Pro 作図キャンバス G3 — 編集の深さ（インラインノード編集・アンカー編集）

G1/G2 の上の最終ラウンド。協議済みの契約（task-msqz4ubh の回答 5）に従う。

## 1. インラインノード編集（prompt() 全廃）

- **一級状態** `editingNodeId: string | null` を持つ。
- 発火: ノードツールでのクリック（新規作成後すぐ編集開始）/ select ツールで node を
  **ダブルクリック**。
- エディタ: `.pro-canvas-inline-editor` の `<input>`（contenteditable 不可）。
  - `data-role="node-editor"` と `data-object-id="<id>"` を付与（driver 契約）。
  - 生成時に `.value` を設定してから focus + select()。
  - 位置: `sceneToScreen(node.at, view())` で node 上に重ねる（render/zoom/pan/resize の
    たびに再配置。render() 内で editingNodeId があれば位置更新）。
  - フォントサイズはズームに追従（`4mm 相当 × scale` 程度、最低 12px）。
- キー契約: Enter = 確定（1 回だけ）/ Esc = キャンセル / どちらも preventDefault +
  stopPropagation。blur = 確定（キャンセル済みなら何もしない）。Shift+Enter も確定。
- 確定時: 値が変わったときのみ snapshot → node.latex 更新 → render + scheduleCompile。
  **空文字で確定した新規ノードは削除**（空ノードを残さない）。
- 編集中は下の node を選択状態のまま維持。`onKey` は editingNodeId が非 null なら
  最初に return（既存の入力フォーカス裁定に加えて明示チェック）。
- 既存の `prompt("LaTeX", ...)` 経路は全廃。

## 2. パスアンカー編集

- **一級状態** `anchorEdit: { pathId: string } | null`。
- 発火: select ツールで path を**ダブルクリック**。終了: Esc（ラダーの最上段に挿入:
  インラインエディタ → アンカー編集終了 → ペン確定 → シンボル編集終了 → 選択解除）
  または他オブジェクトのクリック。
- 表示: 対象 path の全アンカー（start + 各 segment の to）に screen-constant の
  白角ハンドル（`.pro-canvas-anchor`、5px 相当）。cubic セグメントは選択中アンカーの
  前後の制御点（c1/c2）を小丸 + アンカーからの細線（`.pro-canvas-anchor-control`）で表示。
- 操作: アンカードラッグ = 該当点を移動（grid/ガイドスナップは grid のみ適用）。
  制御点ドラッグ = c1/c2 移動（スナップなし）。**Alt+クリックでアンカー上** = 
  line↔cubic のトグル（cubic 化は前後 1/3 位置に制御点を生成、line 化は制御点破棄）。
  ドラッグは既存の drag 機構に `kind:"anchor"` を足す（before クローン復元方式を踏襲、
  undo は moved 時のみ積む）。
- アンカー編集中は通常の選択クローム（ハンドル・回転）を出さない（パスの細アウトラインのみ）。
- 選択レイヤ同様 PNG エクスポート除外。

## 3. こまごまの磨き（監査で見えた分）

- インスペクタの disabled ボタンに視覚差（opacity .4）を与える（現状 disabled が
  見た目で分からない）。
- ノードの SVG 近似テキスト: フォントを serif（Latin Modern に寄せて `font-family:
  Georgia, 'Times New Roman', serif`）にして実描画との乖離を減らす（実フォントは
  Live コンパイルが正）。
- code オブジェクトのプレースホルダ枠に `</>` ラベルだけでなく tikz 先頭 20 文字の
  プレビュー（等幅 2.5px、text-soft）を 1 行表示。

## 4. テスト

- 純関数化できる部分: アンカー列挙とパス更新を canvas-math.ts に
  `pathAnchors(path): Vec[]（参照）` 相当は既存構造で足りるため**新設しない**。
  代わりに line↔cubic トグルの変換を純関数
  `toggleSegmentKind(path, anchorIndex): void`（canvas-math.ts、in-place）にして
  `tests/pro-canvas-anchor-math.test.mjs` でテスト（line→cubic の 1/3 制御点、
  cubic→line、anchorIndex 0（start）は何もしない）。

## 制約

- G1/G2 と同じ。driver 契約: `[data-role=node-editor]` を fill → Enter で確定できること。
  ダブルクリックで `.pro-canvas-anchor` が現れること。
