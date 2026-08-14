# Pro Canvas K: 曲線の見える化・直接編集・真の境界・自動スムース

ユーザー要望 3 点（2026-08-14）:
1. 「（曲線の）途中どこで曲げてるのかがわかりにくい上、それを調整する方法がない」
2. 「曲線の選択範囲が正方形に見えるようになってしまっててカッコ悪い」
3. 「Pro Mode なので、もっと曲線を綺麗に簡単に、ただしカスタマイズ性高く書く方法を」

対象: `web-src/app/pro-canvas/canvas-ui.ts` / `canvas-math.ts` / `pen-math.ts`（+必要なら scene.ts）+ `Resources/web/theme.css` + tests。electron/ 不変。scene モデル（PathSeg = line | cubic）は**不変**。TikZ 出力（`.. controls ..`）も不変。

制約（毎回同じ・厳守）: plain tsc / 新規 npm 依存なし / eval・new Function 禁止 / 生成 `Resources/web/app/**/*.js` 手編集禁止（theme.css は編集可）/ 既存の高密度 1 行スタイルに合わせる / 動的 title・placeholder に `data-no-i18n` / ドラッグ由来のシーン変更はメイン pointermove の分岐内（`scene=cloneScene(drag.before)` の後）/ 完了条件 `npx tsc -p web-src/tsconfig.json` 0 エラー + `node --test tests/*.test.cjs tests/*.test.mjs` 全 pass + 新規純関数テスト。テストは `Resources/web/app/pro-canvas/*.js`（tsc 生成物）から import する（`tests/pro-canvas-pen.test.mjs` 参照）。

既知の恒久 gotcha（pro-mode-design.md より、壊さない）:
- pen 状態はシーン配列への参照を持つ。undo/redo・ツール切替では既存どおり abort する（ゾンビ化防止）。
- ペン曲線の第 1 セグメントは c1 が始点に退化しうる。矢頭の接線は c1 → c2 → to のフォールバック（既存実装維持）。
- アンカーはスナップ・ハンドルは生座標。

---

## K3. パスの真の境界 + 選択見た目（「正方形」問題の根治）

### K3a. 境界計算

現状の問題: `allPoints`（canvas-ui.ts）が path の **c1/c2（制御点）までバウンディングに含める**。ハンドルが外へ張り出した曲線ほど選択枠・リサイズ枠・整列・スナップ・マーキーが実際のインクより大きな「正方形」になる。

- canvas-math.ts に純関数を追加:
  ```ts
  export const cubicExtremaPoints = (from: Vec, seg: { c1: Vec; c2: Vec; to: Vec }): Vec[]
  // 各軸の 3 次ベジェ微分（2 次方程式）の根 t∈(0,1) における曲線上の点 + to を返す（from は呼び手が持つ）
  export const pathTightBounds = (path: { start: Vec; segments: PathSeg[] }): Bounds
  // start + 各 line の to + 各 cubic の cubicExtremaPoints から min/max
  export const pathTightPoints = (path: { start: Vec; segments: PathSeg[] }): Vec[]
  // 同じ点集合を返す（group/instance の子として transform して使う用）
  ```
  2 次方程式は退化（a≈0）時に 1 次へフォールバック。数値は既存スタイルどおり素朴で良い。
- canvas-ui.ts: **`allPoints` はそのまま残す**（rotate / resize の「実点の変異対象」として使われているため。ここを変えると回転・リサイズが壊れる）。境界だけ別口にする:
  - `objectBounds` を「境界用の点集合」で計算するよう変更: path は `pathTightPoints`、group/instance の再帰でも子 path は tight 点を transform、他タイプは従来どおり。`repeat` は現状 `samplePathPoints`（曲線サンプル）なので既に tight、変更不要。
  - resize（drag.bounds）・整列・スナップ・マーキー・インスペクタ X/Y/W/H は `objectBounds` 経由なので自動的に締まる。resizeObject は従来どおり全実点（c1/c2 含む）を before→after でアフィン写像（before が tight になるだけで整合する）。

### K3b. 選択見た目

現状の問題: 曲線を 1 本選択すると白い正方形ハンドル 8 個が矩形状に並び、「正方形が選択されている」ように見える。

- **単一選択の path（isStraightLine でないもの）**:
  - 曲線に沿う `pro-canvas-selection-outline`（既存）は維持。
  - アンカー位置に小さな丸ドットを表示（r=2.5/scale、class `pro-canvas-path-dot`、pointer-events: none。closed の場合は末尾アンカー=始点を重複表示しない）。選択しただけで「どこで曲がっているか」が見える。
  - 8 個の正方形ハンドルを廃止し、**四隅のみ**の丸グリップに変更: tight bounds の nw/ne/se/sw に `circle` r=3/scale、`dataset.handle` は従来の値（"nw" 等）を入れて既存 resize ドラッグをそのまま活かす。class は `pro-canvas-handle pro-canvas-handle-nw` 等（cursor CSS 再利用）+ 追加 class `is-path-corner`。辺ハンドル（n/e/s/w）は出さない。
  - 回転ステム・回転ハンドルは維持（tight bounds 基準になる）。
  - anchorEdit 中はこれらを出さない（既存の `if(!anchorEdit)` ガード維持）。
- 他タイプ（rect/ellipse/group/…）の 8 ハンドルは現状維持。複数選択の bounds 矩形も現状維持（tight 化だけ効く）。
- パス選択時の hintbar: `ダブルクリックで頂点とハンドルを編集　端の□をドラッグで伸縮` → `ダブルクリック：頂点とハンドルを編集　四隅をドラッグ：伸縮`（直線 path の既存文言は維持）。

---

## K4. ペン刷新: クリック = 自動スムース通過点（Illustrator 曲線ツール方式）

現状の問題: クリックだけだと直線の折れ線にしかならず、綺麗な曲線を引くにはドラッグでハンドルを引き出す技術が要る（素人に無理）。タブ名は「曲線」なのに、クリックでは曲線にならない。

### 状態機械

```ts
type PenNode = { p: Vec; kind: "auto" | "corner" | "manual"; out: Vec | null }; // out は manual のみ
let pen: { path: <scene 内の path への参照>; nodes: PenNode[] } | null;
let penDrag: { anchor: Vec; handle: Vec | null; startClient: Vec; alt: boolean } | null;
```

- pointerdown（pen ツール）: 始点近接クリックでの close 判定・直前アンカー再クリックでの finish 判定は現状維持。それ以外は `penDrag = { anchor: p(スナップ済), handle: null, startClient, alt: e.altKey }`。
- pointermove（押下中）: 現状どおり 4px 閾値で `handle = cursor(生座標) - anchor`。
- pointerup: ノード追加 `{ p: anchor, kind: handle ? "manual" : (alt ? "corner" : "auto"), out: handle }` → `rebuildPenPath()`。初回は path をシーンに作ってから（snapshot は初回のみ、現状どおり）。
- `rebuildPenPath()`: `pen.path.start = nodes[0].p; pen.path.segments = buildPenSegments(nodes, pen.path.closed)`。

### 純関数（pen-math.ts）

```ts
export const buildPenSegments = (nodes: PenNode[], closed: boolean): PathSeg[]
```

- 各ノードの接線 T_i（out 方向のベクトル）:
  - manual → `out`（in 側は `-out` の対称。現状の penSegmentFor と同じ意味論）
  - corner → null（ハンドルなし）
  - auto → Catmull-Rom: `T_i = (P_{i+1} − P_{i−1}) / 6`。open パスの端は存在しない側を自分で置換（P_{−1}=P_0、P_{n+1}=P_n）。closed のときは添字を巡回（← これで**閉路が滑らかに閉じる**。既知の監査残「閉路が必ず角」の解消）。
- セグメント i（P_i → P_{i+1}）: 両端とも接線 null → `{type:"line",to}`。どちらかにあれば cubic: `c1 = P_i + (T_i ?? 0ベクトル)`、`c2 = P_{i+1} − (T_{i+1} ?? 0ベクトル)`。closed の最終セグメント（P_last → P_0）も同式。
- `penSegmentFor` は残してもよい（既存テストがある）。buildPenSegments が manual/corner のみの列で penSegmentFor 逐次適用と一致することをテストで保証。

### 挙動・視覚

- **クリック連打だけで滑らかな曲線**（中間 auto ノードの入り/出ハンドルは共線）。**Alt+クリックで角**。**ドラッグで従来の手動ハンドル**（その点だけ manual 固定、以後の auto 再計算の影響を受けない）。
- 新しい点を置くと直前 auto ノードの接線が再計算される（rebuild で自然にそうなる）。
- ゴーストプレビュー: カーソルを仮の auto ノードとして `buildPenSegments([...nodes, {p:cursor,kind:"auto",out:null}], false)` を計算し、**末尾 2 セグメント**（存在する分）をゴースト描画（確定時のジャンプを見せないため、影響を受ける直前セグメントもゴースト側で上書き表示）。penDrag 中のプレビューは現状の対称ハンドル表示を維持。
- **K1: 描画中の確定済みハンドル可視化**: pen アクティブ中、確定済み cubic セグメントの c1/c2 を「アンカー→制御点のヘアライン + 小ドット」で薄く表示（class `pro-canvas-pen-committed`、opacity .45 程度、pointer-events: none）。最後のノードの out ハンドルは通常濃度で表示。どこで曲げたかが描きながら見える。
- **close**: 始点クリックで `closed=true` → `rebuildPenPath()`（closed 巡回 Catmull-Rom）→ finish。
- **finish（Enter / 直前アンカー再クリック / close）で: `tool = "select"` に戻し、`anchorEdit = { pathId }` + `selectedAnchorIndex = 0` に入る**（plot 配置後に select へ戻す既存パターンと同じ）。描き終わった瞬間に全アンカー・全ハンドルが見え、そのまま調整できる。Esc 破棄・1 点破棄ガード・undo/redo 中の abort は現状維持（nodes 方式でも `path.segments.length` 判定は成立する）。
- pen の hintbar: `クリック：なめらかな曲線　Alt+クリック：角　ドラッグ：ハンドルで調整　始点クリックで閉じる　Enter で確定`

---

## K2. 頂点編集（anchorEdit）の強化

現状の問題: 表示されるのは選択中アンカーの隣接制御点だけ。ミラーなし・セグメント直接ドラッグなし・頂点追加/削除なし。closed パスは始点アンカーが二重表示され、片方だけ動かすと壊れる。

### K2a. 全ハンドル表示

- anchorEdit 中、**全** cubic セグメントの c1/c2 を表示: アンカー→制御点のヘアライン（class `pro-canvas-anchor-tether is-faint`、opacity .35）+ ドット r=2.5/scale（class `pro-canvas-anchor-control is-faint`）。`dataset.controlSegment` / `dataset.controlKey` を全ドットに付け、既存の control ドラッグがそのまま効くようにする。選択中アンカーの隣接分は現状の濃度・r=3/scale で強調（重複描画しない）。
- 退化した制御点（アンカーと同一座標、距離 < 1e-6）はドットを描かない（掴めない偽ドットを出さない）。

### K2b. スムーズミラー（対称ハンドル）

- control の pointerdown 時、同じアンカーを挟む反対側 control を特定する: `controlKey==="c1"`（segment i の出側、アンカー = i の from）→ 反対は segment i−1 の c2（存在し cubic のとき）。`"c2"`（segment i の入側、アンカー = i の to）→ 反対は segment i+1 の c1。closed パスでは巡回（segment −1 = 最終 segment、ただし最終 seg.to が start と同一である前提）。
- ドラッグ開始時点で両側ベクトル（control − anchor）がほぼ逆向き共線（両方の長さ > 1e-6 かつ cos < −cos(10°)）なら「スムーズ」と判定し drag に記録。pointermove 中、反対 control を「アンカーから、ドラッグ中 control の正反対方向・**自分の元の長さを維持**」に更新（Illustrator の標準挙動）。**Alt 押下中はミラーしない**（片側だけ動かして角に折る）。
- 純関数（canvas-math.ts）: `isMirrorPair(anchor: Vec, a: Vec, b: Vec): boolean` / `mirroredControl(anchor: Vec, dragged: Vec, oppositeLength: number): Vec`。

### K2c. セグメント直接ドラッグ = 曲げ（Illustrator のリシェイプ / Figma の bend）

- 純関数（canvas-math.ts）:
  ```ts
  export const nearestOnPath = (path, p: Vec): { segIndex: number; t: number; dist: number; point: Vec }
  // 各セグメントを 32 分割サンプルして最近傍（line は射影で厳密に）
  export const bendSegment = (seg: Extract<PathSeg,{type:"cubic"}>, t: number, delta: Vec): void
  // w1=3(1−t)²t, w2=3(1−t)t², s=w1²+w2² として c1 += delta·w1/s, c2 += delta·w2/s（最小ノルム解。曲線上の点 B(t) がちょうど delta 動く）
  ```
- anchorEdit 中、対象 path 本体への pointerdown（アンカー/コントロールのドット以外で、`data-id` が anchorEdit.pathId のとき）: `nearestOnPath` で {segIndex, t} を取り、`drag = { kind: "bend", segIndex, t: clamp(t, .15, .85), ... }`。pointermove（`scene=cloneScene(drag.before)` の後の分岐内）: 対象 seg が line なら cubic 化（toggleSegmentKind と同じ 1/3・2/3 の式）してから `bendSegment(seg, t, delta)`。delta は生座標差分（スナップしない）。
- pointerup の changed 判定リスト（undo push / 未移動時の scene 巻き戻し）に "bend" を追加。
- これまで「anchorEdit 中に path 本体をクリック」は選択維持のみだったので競合は軽微。path 以外のオブジェクトをクリックしたときの anchorEdit 解除（既存）は維持。

### K2d. 頂点の追加・削除

- **追加**: anchorEdit 中のダブルクリック（自前 lastClick 検出経路に追加）で、`nearestOnPath` の dist が 8/scale 以内かつアンカードット上でないとき、`splitSegmentAt` で分割。snapshot → `selectedAnchorIndex = segIndex + 1` → render。
  ```ts
  export const splitSegmentAt = (from: Vec, seg: PathSeg, t: number): [PathSeg, PathSeg]
  // cubic は de Casteljau、line は線形分割で 2 本の line
  ```
- **削除**: anchorEdit 中は Delete/Backspace を「選択オブジェクト削除」ではなく**選択アンカー削除**にする:
  ```ts
  export const removeAnchor = (path: { start: Vec; segments: PathSeg[]; closed: boolean }, index: number): boolean
  // index 0: start ← segments[0].to、segments.shift()。closed なら最終 seg.to も新 start に同期。
  // 末尾（open のみ）: segments.pop()。
  // 中間: 隣接 2 セグメントを 1 本の cubic に統合（c1 = 前 seg の c1（line なら from + (to−from)/3）、c2 = 後 seg の c2（line なら to − (to−from)/3）、to = 後 seg.to）。
  // 統合の結果 segments が空になるなら false を返し、呼び手がパスごと削除 + anchorEdit 解除 + clearSelection。
  ```
  snapshot → selectedAnchorIndex を clamp → render/scheduleCompile。
- **K2e. closed パスの始点二重アンカー解消**（既知の監査残）: closed のとき、アンカー列の末尾（最終 seg.to = start と同一点）は**描画しない**。アンカー index 0 のドラッグでは start と最終 seg.to を**両方**動かす（隣接 control の追従も両側: segments[0].c1 と最終 seg の c2）。
- anchorEdit 中の hintbar: `ドラッグ：頂点・ハンドル　セグメントをドラッグ：曲げ　ダブルクリック：頂点追加　Delete：頂点削除　Alt+クリック：直線⇄曲線　Esc で終了`

---

## CSS（theme.css、既存 8918 行付近のブロックに追記）

- `.pro-canvas-path-dot { fill: var(--accent); stroke: #ffffff; stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: none; }`
- `.pro-canvas-handle.is-path-corner { /* circle。既存 .pro-canvas-handle の fill/stroke を継承しつつ必要なら微調整 */ }`
- `.pro-canvas-anchor-tether.is-faint { stroke-opacity: .35; }` / `.pro-canvas-anchor-control.is-faint { fill-opacity: .8; }`
- `.pro-canvas-pen-committed { opacity: .45; pointer-events: none; }`

---

## テスト（node:test、`Resources/web/app/pro-canvas/*.js` から import）

- `cubicExtremaPoints` / `pathTightBounds`: ハンドルが大きく張り出す S 字で、tight bounds が制御点 bbox より小さく、かつ数値サンプル（t を 0..1 で 100 分割した最大最小）と誤差 1e-6 以内で一致。
- `buildPenSegments`: (a) auto 3 点で中間ノードの in/out が共線（(c1−P)×(P−c2)≈0）、(b) corner のみ → 全 line、(c) manual の out が c1 に、−out が c2 に入る（penSegmentFor 逐次適用と一致）、(d) closed 巡回で先頭ノードにも接線が付く。
- `bendSegment`: t=0.5, delta=(3,−2) で曲線上の B(0.5) がちょうど delta 移動（前後の評価値比較、1e-9）。
- `splitSegmentAt`: 分割後 2 セグメントの合成曲線が元とサンプル一致（両端 + 中間 5 点、1e-9）。
- `removeAnchor`: 中間削除で両端点不変・セグメント数 −1。index 0 / 末尾 / closed 同期 / 空になったら false。
- `isMirrorPair` / `mirroredControl`: 共線判定の境界、長さ維持・方向反転。
- `nearestOnPath`: 直線上の点で t と dist が解析値どおり。

## 実装ノート（最終形・spec からの意図的な変更）

Opus 監査（重大3件）を受けて以下は spec と異なる最終実装になった。**コードが真**。

- **auto 接線は一様 Catmull-Rom `(P₊₁−P₋₁)/6` ではなく centripetal（α=.5）**。一様版は弦長が不均一だと短い弦で overshoot→ループする（L 字ブラケットで実測 59% 膨らみ）。片側弦長^.5 で重み付けした速度 + 開パス端は自然境界条件（端の制御点 = (端点+隣の制御点)/2）。
- **ゴーストプレビュー（slice(-2) 案）は廃止**。確定 ink とゴーストが二又に見える（Hausdorff 2.37mm 実測）ため、ペン描画中は**シーン上のパス自体を「カーソルを仮 auto ノードに含めた provisional 形状」で描画**する（draw() 内で pen.path のみ差し替え。カーソルが最終アンカーと同一点のときは仮ノードを足さない）。始点近傍では closed ビルドを描いて「閉じたらこうなる」を予告する。
- **Esc は破棄ではなく Enter と同じ「確定」**（Illustrator 準拠）。中途半端な「確定するが未選択」状態を排除。1 点のみの破棄ガードは finishPen 内で維持。
- **ペンのアンカーは Alt 押下中もグリッドに吸着**する（Alt=角 と Alt=吸着解除 の衝突を解消。角こそ位置を揃えたいため）。
- 閉パスは Alt+クリックを anchor 0 にも許可（閉じセグメントをトグル）。頂点削除の clamp は closed で `segments.length-1`（Delete 連打でのパス丸ごと消滅を防止）。
- 0 セグメントの path は TikZ / .sty 出力から除外（ペン 1 クリック中断の残骸対策）。

## 実装順

K3（bounds + 選択見た目）→ K2（anchorEdit 強化）→ K4/K1（pen 刷新）。各段で tsc + 既存テスト。

## 検証（Claude 側で実施、Codex の完了条件ではない）

- driver: クリック 4 連打 → 全セグメント cubic で滑らか / Alt+クリック混在で角 / ドラッグで manual。finish 後に select ツール + anchorEdit に入っている。
- 選択: 曲線 1 本選択で正方形 8 ハンドルが出ない・選択枠がインクに沿う（制御点はみ出しなし）。
- anchorEdit: 全ハンドル表示・ミラー・bend・頂点追加/削除・closed の始点一体化。
- 実コンパイル: 曲線シーンの TikZ が pdflatex を通る。
