# Pro 作図キャンバス G2 — 描画感（スマートガイド・整列・制約・ペン）

G1 の基盤（Selection モデル・raw/snap 分離・クローム）の上に「描く手応え」を足す。
対象: canvas-ui.ts / canvas-math.ts / theme.css。data 属性・ID・イベント名は不変。

## 1. スマートガイド（協議済み設計）

- canvas-math.ts に純関数:

```ts
export type SnapLine = { value: number; kind: "min" | "center" | "max" };
export const collectSnapLines = (others: Bounds[], artboard: { width: number; height: number })
  : { x: SnapLine[]; y: SnapLine[] }   // 各 bounds の min/center/max + アートボード 0/中央/端
export const snapBoundsToLines = (bounds: Bounds, lines: { x: SnapLine[]; y: SnapLine[] }, threshold: number)
  : { dx: number; dy: number; guides: { x?: number; y?: number } }
  // 動かした bounds の min/center/max を候補と比較し、軸ごとに絶対値最小の補正を 1 つ採用。
  // タイブレーク: center 一致 > 端一致。閾値超は補正 0・ガイドなし。
```

- canvas-ui.ts: move / resize / draw ドラッグで適用。
  - pointerdown 時に **選択外トップレベルの bounds + アートボードを 1 回だけ収集**して
    drag にキャッシュ（協議どおり。ドラッグ中は不変のため）。
  - 優先順位: raw delta → grid snap → **ガイド補正**（グリッド後に上書き適用。
    ガイドが効いたときはガイド優先）。Alt で grid・ガイドとも無効（現行踏襲）。
  - 閾値: `5 / scale`（スクリーン 5px 相当）。
  - ガイド描画: objects の上・selection の下に `.pro-canvas-smart-guides` レイヤ。
    該当軸の値に**アートボード全幅/全高のヘアライン**（magenta #ff36b0、
    non-scaling-stroke、pointer-events none）。ドラッグ終了で消す。
    PNG エクスポート除去リストに追加。

## 2. 寸法ツールチップ

- ドラッグ中（draw/resize/move）にカーソル近くへ小チップ（`.pro-canvas-size-chip`、
  overlay 直下の HTML div。SVG 外）:
  - draw/resize: `W × H`（unit 付き、小数 1 桁）
  - move: `X, Y`（選択 bounds の左下）
- pointerup で消す。ズームやテーマで崩れない固定スタイル（12px、panel-strong 背景）。

## 3. 整列・分配（複数選択インスペクタ）

- 複数選択時のインスペクタに「整列」セクション: 6 ボタン（左/中央/右・上/中央/下）+
  分配 2 ボタン（横等間隔・縦等間隔）。アイコンはインライン SVG プリミティブ。
- canvas-math.ts 純関数:

```ts
export const alignDeltas = (bounds: Bounds[], mode: "left"|"centerX"|"right"|"top"|"centerY"|"bottom")
  : Vec[]   // 各オブジェクトへの移動量（選択全体の集約 bounds 基準）
export const distributeDeltas = (bounds: Bounds[], axis: "x"|"y"): Vec[]
  // 3 個以上。端 2 つは固定し、中間を等間隔に（mathcha/AI と同じ）。2 個以下は全ゼロ。
```

- 適用は snapshot → 各オブジェクトへ moveObject → render。分配は選択 3 個未満で disabled。

## 4. 重なり順

- 単一/複数選択時のインスペクタ「配置」セクションに 4 ボタン:
  最前面 / 前面へ / 背面へ / 最背面（`currentObjects()` 配列内の並べ替え。複数選択は
  相対順を保って移動）。ショートカット Cmd/Ctrl+] / [（Shift 付きで最前/最背）。
  入力フォーカス除外は既存 onKey の裁定に従う。

## 5. 制約描画（Shift）

- rect/ellipse ドラッグ中 Shift = 正方形/正円（|dx|,|dy| の大きい方に揃える。
  ellipse は rx=ry）。line ドラッグ中 Shift = 水平/垂直/45° スナップ。
- resize ドラッグ中 Shift = 縦横比維持（コーナーハンドルのみ。辺ハンドルは無視）。
- Shift 状態は pointermove の `e.shiftKey` で毎フレーム判定（押し直しに追従）。

## 6. ペンの描画感

- ペン使用中: 確定済みアンカーに小さい丸（`.pro-canvas-pen-anchor`、screen-constant
  半径 3/scale）を表示。最後のアンカー→カーソルの**ゴーストセグメント**
  （accent 40% の直線プレビュー、`.pro-canvas-pen-ghost`）を pointermove（ドラッグ外）で更新。
- 始点近傍（クローズ判定距離内）でカーソルが始点上のとき始点アンカーを強調（半径 1.5 倍）
  — 「閉じられる」ことの提示。
- これらは selection レイヤと同様に PNG エクスポートから除外。

## 7. fit ズーム

- ズーム表示ボタン（zoom-reset）を fit に: クリックで zoom=1・pan=0（現行）に加え、
  **Shift+クリックで選択にフィット**（選択 bounds が stage の 70% に収まる zoom/pan を計算。
  選択なしなら通常 fit）。title で説明。

## 8. テスト

- `tests/pro-canvas-guides-math.test.mjs`（新規）: collectSnapLines（アートボード線含む）、
  snapBoundsToLines（閾値内/外、center 優先タイブレーク、軸独立）、alignDeltas 6 モード、
  distributeDeltas（3 個等間隔・2 個ゼロ・端固定）。

## 制約

- G1 と同じ（依存なし・生成系不変・既存テスト無改変 green・体験規範: ホバー/ドラッグ中に
  全再描画を増やさない。ガイド計算は pointerdown キャッシュ + フレーム内 O(候補数)）。
