# Pro 作図キャンバス G1 — インタラクション基盤の刷新（mathcha 系 UX）

Codex との設計協議（2026-08-13、task-msqz4ubh）の合意事項に基づく第 1 ラウンド。
UX と描画感を最優先する。対象: `canvas-ui.ts`（+ theme.css、canvas-math.ts の純関数追加）。
`data-tool` / `data-action` / ID / イベント名は不変。

## 1. 選択モデル

```ts
type Selection = { ids: Set<string>; primaryId: string | null };
```

- 書き込み可能な `selectedId` 変数は廃止。ヘルパー経由のみ:
  `replaceSelection(id)`, `toggleSelection(id)`, `clearSelection()`,
  `selectedIdOne(): string | null`（ids.size===1 のときの primaryId）, 
  `topLevelSelectedObjects(): SceneObject[]`, `selectionBounds(): Bounds | null`,
  `replaceSelectedId(oldId, newId)`。
- primaryId = 最後に選択された ID。単一オブジェクト用 UI（インスペクタのスタイル・
  シンボル化・回転/リサイズハンドル）は **ids.size===1 のときだけ**表示・有効。
- 選択対象は `draw(..., interactive=true)` が data-id を付けるトップレベルのみ（現行同様）。
- undo/redo・symbol 編集モード出入りで `clearSelection()`。
- 回転で rect/ellipse をラップするとき: wrapper id は **pointerdown 時に `newObjectId()` で
  1 回だけ生成して drag state に保持**し、毎フレーム同じ id を使う（`rot-` 接頭辞の
  決定的 id は衝突リスクがあるため廃止）。ラップ後 `replaceSelectedId`。

## 2. ポインタ操作の再定義

- **Shift ドラッグ回転は廃止**（回転は回転ハンドルのみ）。Shift+クリック = 選択トグル。
- クリック（選択済みメンバー上・Shift なし）= 選択維持で複数移動開始。
  未選択オブジェクト上 = 選択置換 + 移動開始。空白クリック = 全解除。
  空白ドラッグ = **マーキー選択**（矩形に**触れた**トップレベルを選択。半透明 accent 塗り
  + 枠の矩形を選択レイヤに描画）。
- `point(event)` を分離: `rawPoint(event)`（無スナップ）と、grid スナップは移動/描画の
  **delta 決定時**に適用。スナップ優先順位: raw delta → grid → （G2 のガイド補正）。
  Alt はスナップ無効（現行踏襲）。
- `drag.moved` は**スクリーン px 閾値**（4px）で判定（グリッドセル内の微動でクリック扱い
  になる現行問題の修正）。
- 複数移動: drag に `ids: string[]` と pointerdown 時の集約 bounds を保持。毎フレーム
  `cloneScene(drag.before)` 復元 → 全 id に同一 dx/dy を `moveObject`。

## 3. キーボード

- `onKey` の**先頭**でモード裁定: 入力要素（input/select/textarea/contenteditable）に
  フォーカスがあれば return（stopPropagation もしない）。
- Escape ラダー: ペン確定 → シンボル編集終了 → 選択解除 → キャンバスを閉じる（1 押下 1 段）。
- Delete/Backspace: 選択全削除。**Cmd/Ctrl+D**: 複製（grid step だけ右上にオフセット、
  複製側を選択）。**矢印キー**: ナッジ 1 unit、Shift+矢印 = grid step。
- Cmd/Ctrl+G: **選択全体を 1 グループに**（現行の単一オブジェクト版を拡張）。
  Shift+Cmd/Ctrl+G: 単一選択のグループを解除（現行）。
- ツールショートカット V/P/L/R/E/T/C は現行の入力除外つき挙動を維持。

## 4. ホイール / ズーム

- `wheel` リスナ（passive: false, preventDefault）:
  - **Ctrl/Cmd+wheel（ピンチ含む）= カーソル位置固定ズーム**。協議で確定した式:
    `r = newZoom/oldZoom; newPan = d - (d - oldPan) * r`（d = カーソルの中心からの
    クライアント座標オフセット。x,y 各軸）。zoom は 0.25〜4 にクランプ。
  - 素の wheel / トラックパッド 2 本指 = パン（`panX -= deltaX; panY -= deltaY`）。
- ズームリセットボタンは「fit」動作に変更: zoom=1, pan=0（表示は現行 % のまま）。

## 5. ホバー & 選択クローム（描画感の核）

- **ホバー**: pointermove（ドラッグ外）で `[data-id]` ヒットを追跡し、ホバー中オブジェクトの
  bounds に細い accent-soft のアウトライン（`.pro-canvas-hover`、selection レイヤの下）。
  ドラッグ中・マーキー中は消す。カーソル: オブジェクト上は `move`、ハンドル上は方位カーソル
  （nw-resize 等）、回転ハンドルは `grab`。
- **選択クローム刷新**: 
  - アウトライン: 1px（`vector-effect: non-scaling-stroke`）の accent 実線（破線をやめる）。
  - ハンドル: **7×7px の白い正方形 + accent 枠**（circle をやめる。screen-constant:
    サイズは `7/scale`）。
  - 回転ハンドル: 上辺中央から `stem` 線を伸ばした先に白丸 + accent 枠。
  - 複数選択: 各オブジェクトに細アウトライン + 全体に集約 bounds の枠（ハンドルなし）。
- **紙の存在感**: paper 矩形に drop-shadow（SVG filter か CSS filter。薄く 2 段）。
  アートボード外の stage 背景をわずかに暗く（現行 --panel-muted のまま可、paper の影で
  区別がつけば良い）。グリッド線はズームに応じて `vector-effect: non-scaling-stroke`。

## 6. canvas-math.ts 追加（純関数・テスト対象）

```ts
export const zoomAtPoint = (view: {panX,panY,zoom}, cursorOffset: Vec, newZoom: number)
  : { panX: number; panY: number }   // §4 の式
export const marqueeHits = (rect: Bounds, objects: Array<{id: string; bounds: Bounds}>): string[]
  // intersect（触れたら選択）
```

- `tests/pro-canvas-ux-math.test.mjs`（新規）: zoomAtPoint がカーソル下のシーン点を不変に
  保つこと（screenToScene で検証）、marqueeHits の intersect 判定・境界ケース。

## 7. 検証

- `tsc` クリーン、既存全テスト + 新テスト green。
- UI 変更は担当エージェントにかかわらず、実画面で目視監査し、必要な画面と操作のスクリーンショットを確認記録に残す。

## 制約

- 依存追加なし。旧シーンの TikZ 出力不変（生成系は触らない）。
- インスペクタの単一選択 UI は現行を維持（複数選択時は「N 個を選択中」+ G2 で整列 UI を
  足すまでは操作なしの表示のみで良い）。
- スタイルチップ: 複数選択時は**互換オブジェクト全部に適用**（group/code を除く）。
  is-active は全員一致のときのみ。
