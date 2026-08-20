# Pro 作図キャンバス UI 全面再設計仕様（F）

ハンズオン検証（2026-08-13）で判明した問題への対応。現状はテキストボタンが上下に 13 個並び、
階層がなく、スタッシュ/エディタが透けて被る。**Illustrator 系ツールの構造**に組み直す。

対象は `web-src/app/pro-canvas/canvas-ui.ts` の DOM 生成と `Resources/web/theme.css` のみ。
**機能・イベント配線・`data-tool` / `data-action` 属性・既存 ID はすべて維持**（driver とテスト
の互換のため）。加えて機能バグ 2 件を修正する（後述 §6）。

## 1. レイアウト構造

```
.pro-canvas-overlay            ← 完全不透明（§5）
  .pro-canvas-topbar
    (左) .pro-canvas-title「図キャンバス」 + ズーム群 [−][100%][+]
    (右) セグメントトグル [Snap][Live][Doc] ｜ [Undo][Redo]
  .pro-canvas-body             ← grid: 44px | 1fr | 280px
    .pro-canvas-rail           ← 縦アイコンツールレール
    .pro-canvas-stage          ← 既存 SVG。左下に .pro-canvas-status-chip
    .pro-canvas-inspector      ← セクション化（§3）
  .pro-canvas-footer
    (左) 「⋯ その他」ドロップダウン（SVG 取り込み / AI で TikZ 化 / .sty へ書き出し）
    (右) [キャンセル(ghost)] [画像として挿入(secondary)] [TikZ を挿入 / 更新(primary)]
```

## 2. ツールレール（左 44px）

- 7 ツールを **32×32 のアイコンボタン**で縦に並べる（`data-tool` は現行のまま）。
- アイコンは**インライン SVG のプリミティブ**（複雑なパス禁止。line/rect/circle/polyline で
  幾何的に描く。stroke=currentColor, stroke-width 1.5, viewBox 0 0 16 16）:
  - 選択: 矢印カーソル（polyline）/ ペン: 斜めのペン先（line+小三角）/ 直線: 斜め line
  - 矩形: rect / 楕円: ellipse / ノード: 「T」（line 2 本）/ コード: `</>`（polyline 2 個）
- hover でツールチップ（`title` 属性: 「選択 (V)」等）。
- **キーボードショートカット**: overlay 表示中、入力要素にフォーカスが無いとき
  V/P/L/R/E/T/C で切替（既存 onKey に追加。preventDefault は該当キーのみ）。
- アクティブは accent 背景 + 白アイコン。非アクティブは text-soft、hover で panel。

## 3. インスペクタ（右 280px、セクション化）

セクションヘッダは 11px・uppercase・letter-spacing 0.06em・text-soft。セクション間 16px。

1. **配置** — X/Y/W/H を **2×2 グリッド**（ラベルは input 内接頭辞ではなく 10px の上ラベル）。
2. **スタイル** —
   - 1 行目: 線色・塗り色を**スウォッチ 2 つ横並び**（各: 色 input + 「なし」チェックを
     スウォッチ右肩の小トグルに。ラベルは下に 10px）。
   - 2 行目以降: 線幅/二重罫/不透明度/角丸 を **2 列グリッド**の number input。
   - 破線 select + 矢印 2 つ（始/終）を 1 行にまとめる。
3. **セクションは「配置」「スタイル」の 2 つだけ**。かつて存在した「スタイル集」
   （named styles チップ + 「＋」）・「プロジェクト」（`\tikzset` 由来チップ）・
   「シンボル」（シンボル化 / 対称シンボル化 / シンボル一覧）の 3 セクションは
   **撤去済み**（2026-08-20）。ラベルが操作に直結せず、選択なしのときは
   無効チップが並ぶだけだったため。再導入しない。
   - シーン側の `scene.styles` / `scene.symbols` と instance / repeat の
     描画・TikZ 出力は**温存**（既存の図はそのまま開ける）。UI 導線だけを消した。
4. **選択なし時**は「配置」「スタイル」セクションを出さず、
   「オブジェクトを選択してください」の 1 行（text-soft）だけを出す。

## 4. トップバー / フッター

- トグルは **[吸着] だけ**（`data-action="snap"`、pill 枠 1 つ）。[TeX プレビュー]
  （`live`）と [プリアンブル]（`doc-preamble`）は**撤去済み**（2026-08-20）:
  プレビューはエンジンがあれば常時 ON、プリアンブルは読めれば常に適用（失敗時は
  自動でプリアンブルなしへフォールバック）。再導入しない。
- Undo/Redo はアイコンボタン（↺ ↻ の SVG、無効時 opacity .35）。
- ズームは [−][100%][+] を 1 グループの小ボタン（現行 data-action 維持）。
- フッター右: 「TikZ を挿入」（または更新）だけ accent の primary。「画像として挿入 (PNG)」は
  枠線のみの secondary。「キャンセル」は ghost（枠なし）。
- フッター左の **「⋯ その他」メニュー**: クリックでポップアップ（上方向）を開き、
  SVG 取り込み / AI で TikZ 化 / .sty へ書き出し の 3 項目（既存 data-action ボタンを
  メニュー項目として中に置く。外側クリック/Esc で閉じる。texize 不在時は AI 項目 disabled）。
- **ステータス**はフッターから **stage 左下のフローティングチップ**へ移動
  （`.pro-canvas-status-chip`、内容が空なら非表示。エラー時は danger 色の枠）。
  既存の `.pro-canvas-status` 要素をチップとして stage 内に置くだけで良い
  （setStatus のロジック不変）。

## 5. 面の不透明化と重なり順（バグ修正含む）

- `.pro-canvas-overlay` の背景を**確実に不透明**にする:
  `background: linear-gradient(var(--panel-strong), var(--panel-strong)), #10151c;`
  （トークンが半透明でも下の #10151c で遮蔽される）。rail/inspector/topbar/footer も同様の
  二層背景で不透明化。エディタやスタッシュが透けてはならない。
- ~~**キャンバス表示中はスタッシュを隠す**: theme.css に
  `body:has(.pro-canvas-overlay) .pro-stash { display: none !important; }`~~
  → 2026-08-20 にスタッシュがサイドバータブへ移り、オーバーレイが普通に覆うので不要になった（削除済み）。
- **ギャラリー modal が スタッシュ (z-index 45) の下に潜るバグ**: 
  `.pro-canvas-gallery-modal { z-index: 10005; }` を追加。

## 6. 機能バグ修正（ハンズオンで発見）

1. **スタイル適用がツール既定色に打ち消される**: ツールで作るオブジェクトが
   `style: { props: { draw: "#000000" } }` を持つため、named/project スタイル適用後に
   `\draw[spRule, draw=black]` とオーバーライドが出て色が黒に固定される。
   → **全ツールの新規オブジェクトを `style: {}` に変更**（node/pen/直線/矩形/楕円。
   DEFAULT_STYLE が黒線を供給するので TikZ 出力・SVG 近似とも従来と同一。既存テスト不変）。
2. §5 の z-index / スタッシュ被り。

## 7. 検証

- `tsc -p web-src/tsconfig.json` クリーン、既存 `node --test` 全 green（DOM 構造の変更は
  テスト対象外のはずだが、data 属性・ID を変えていないことを確認）。
- 見た目の最終確認は Claude 側で driver を再走して行う（Codex はスクショ不要）。

## 制約

- 依存追加なし。アイコンはインライン SVG プリミティブのみ（絵文字・画像ファイル禁止。
  ⊕ ⛶ ∿ ✎ × ⋯ ↺ ↻ の Unicode グリフはボタン文字として使用可）。
- `data-tool` / `data-action` / 既存 ID（pro-canvas-open 等）/ CustomEvent 名は不変。
- ロジック（イベントハンドラの中身・compile・codec・symbols）は §6-1 以外変更しない。
