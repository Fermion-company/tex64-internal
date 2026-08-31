# Pro Canvas L: 選択した曲線の制御点／挿入コードのコメント削減

ユーザー要望 2 点（2026-08-14）:
1. 「選択モードで曲線を選択した時に、制御点の操作のための表示が出てこない」
2. 「（draw モードで）ソースコードのおびただしい数のコメントアウトが入るのはやめて」

対象: `web-src/app/pro-canvas/canvas-ui.ts`（L1）/ `web-src/app/pro-canvas/figure-codec.ts`（L2）+ tests。`electron/` 不変。scene モデル不変。TikZ 出力（`\draw` 等の本体）不変。

制約（毎回同じ・厳守）: plain tsc / 新規 npm 依存なし / eval・new Function 禁止 / 生成 `Resources/web/app/**/*.js` 手編集禁止 / `canvas-ui.ts` は既存の高密度 1 行スタイルに合わせる（`figure-codec.ts` は既存どおり普通の複数行スタイル）/ 動的 title・placeholder に `data-no-i18n` / ドラッグ由来のシーン変更はメイン pointermove の分岐内 / 完了条件 `npx tsc -p web-src/tsconfig.json` 0 エラー + `node --test tests/*.test.cjs tests/*.test.mjs` 全 pass。テストは `Resources/web/app/pro-canvas/*.js`（tsc 生成物）から import する。

---

## L1. 選択しただけで制御点が見える・触れる

### 現状の問題

パスを 1 回クリックで選択しても、出るのは「曲線沿いアウトライン + 小さなドット（`pro-canvas-path-dot`、pointer-events: none）+ 四隅グリップ + 回転」だけ。頂点ハンドル・制御点ハンドル（`pro-canvas-anchor-layer`）は `anchorEdit` 状態のときにしか描かれず、`anchorEdit` に入る唯一の導線は**ダブルクリック**。ユーザーには「制御点が存在すること自体」が見えない。

### 方針

`anchorEdit` を「モード」から「選択の派生状態」に変え、**深さ 2 段**にする。

- **レベル 1（選択しただけ）**: 頂点□・制御点○・テザー線を表示し、**ドラッグで直接動かせる**。曲線本体のドラッグは従来どおり**移動**。Delete は**オブジェクト削除**（従来どおり）。四隅グリップ・回転ハンドルも従来どおり出す。
- **レベル 2（ダブルクリック = 深い編集、`deep`）**: レベル 1 に加えて、曲線本体ドラッグ = **曲げ（bend）**、曲線上ダブルクリック = **頂点追加**、Delete = **頂点削除**、Esc = レベル 1 に戻る（選択は維持）。四隅グリップ・回転は従来どおり隠す（＝「今は曲線そのものを編集している」の合図）。

### 実装（canvas-ui.ts）

1. 型を `anchorEdit: { pathId: string; deep: boolean } | null` に変更（L149 の宣言）。

2. **派生関数を追加**し、`render()` の先頭（DOM を作る前）で必ず呼ぶ:

   ```ts
   const syncAnchorEdit=()=>{const one=tool==="select"&&!pen&&!plotEdit&&!editingNodeId&&selection.ids.size===1?walk(currentObjects(),selection.primaryId!):null;if(one?.type!=="path"){anchorEdit=null;return;}if(anchorEdit?.pathId!==one.id){anchorEdit={pathId:one.id,deep:false};selectedAnchorIndex=0;}};
   ```

   これにより「単一パス選択 ⇔ anchorEdit あり」が常に一致する。`deep` は同じパスを選び続ける限り保持され、選択が変わればリセットされる。

3. L326（pointerdown）の `if(anchorEdit&&id!==anchorEdit.pathId)anchorEdit=null;else if(anchorEdit&&!id)anchorEdit=null;` は**削除**（派生に一本化）。

4. `deep` でゲートする箇所（**ここが漏れると移動・削除が壊れる**）:
   - L326 の bend 分岐: `if(anchorEdit&&id===anchorEdit.pathId&&...)` → `if(anchorEdit?.deep&&id===anchorEdit.pathId&&...)`。レベル 1 では素通りして `kind:"move"` に落ちること（**曲線本体をドラッグして図形を動かせること**が回帰チェック項目）。
   - L332（pointermove のカーソル）: `anchorEdit&&nextHoveredId===anchorEdit.pathId?"crosshair"` → `anchorEdit?.deep&&…?"crosshair"`。レベル 1 は `"move"`。
   - L341（自前ダブルクリック検出の頂点追加）: `const editPath=anchorEdit&&completed.kind==="bend"?…` → `anchorEdit?.deep&&completed.kind==="bend"?…`。
   - L351（Delete / Backspace の頂点削除）: `if((e.key==="Delete"||e.key==="Backspace")&&anchorEdit)` → `&&anchorEdit?.deep`。レベル 1 の Delete は従来のオブジェクト削除へ落ちること。
   - L349（Esc）: `if(anchorEdit){anchorEdit=null;render();return;}` → `if(anchorEdit?.deep){anchorEdit.deep=false;render();return;}`（選択は維持したままレベル 1 に戻る）。
   - 頂点□・制御点○のドラッグ開始分岐（L326 前半、`anchorEdit&&(anchorIndex!==undefined||controlSegment!==undefined)`）は **`deep` でゲートしない**。レベル 1 で触れることが今回の要望そのもの。Alt+クリックの直線⇄曲線トグルも両レベルで有効のまま。

5. `deep` を立てる場所:
   - `activateForEdit`（L382）の path 分岐: `anchorEdit={pathId:object.id,deep:true}`（同じパスなら `anchorEdit.deep=true` にして `selectedAnchorIndex` は保持）。
   - `finishPen`（L346）: `anchorEdit={pathId:path.id,deep:true}`（描いた直後は深い編集のまま、という K の挙動を維持）。

6. 選択レイヤ（L300）:
   - ガード `if(!anchorEdit)` → `if(!anchorEdit?.deep)`。
   - `isStraightLine(selected[0])` 分岐の**頂点□描画は削除**（アンカーレイヤが同じ□を描くため二重になる）。直線パスは「アンカーレイヤのみ・四隅グリップと回転なし」を維持したいので、分岐自体は残して中身を空にするのではなく、`else if(selected[0].type==="path")` 側で `isStraightLine` のときは四隅グリップ・回転ステムを出さない形に統合してよい（どちらでも可、結果が同じであること）。
   - パス分岐の `pro-canvas-path-dot` の円を描くループは**削除**（アンカーレイヤの□に置き換わる）。CSS クラス `.pro-canvas-path-dot` が未使用になるなら theme.css からも消す。
   - 四隅グリップ（`is-path-corner`）と回転ステム・回転ハンドルはレベル 1 で従来どおり出す。
   - L325 の `target.dataset.pathId && target.dataset.anchorIndex` 分岐は、直線パス専用の入口が消えるとデッドコードになる。デッドになるなら削除する（`dataset.pathId` を書く箇所が他に無いことを grep で確認してから）。

7. ヒントバー（L314）:
   - `anchorEdit?` → `anchorEdit?.deep?` に変更（既存文言はそのまま）。
   - 単一パス選択（レベル 1）の文言を差し替え:
     - 直線: `"端の□をドラッグ：伸縮　ダブルクリック：頂点の追加・削除"`
     - 曲線: `"○をドラッグ：曲線を調整　四隅：伸縮　ダブルクリック：頂点の追加・削除"`

### L1 の検証（見た目ではなく挙動）

- 曲線を 1 回クリック → 頂点□と制御点○とテザーが出る。○をドラッグすると曲線が変わる。
- 同じ曲線の**線の上**をドラッグ → 図形が移動する（曲がらない）。
- Delete → オブジェクトが消える（頂点だけ消えない）。
- ダブルクリック → 四隅グリップが消え、線の上のドラッグで曲がる／線の上のダブルクリックで頂点が増える／Delete で頂点が減る。
- Esc → レベル 1 に戻る（選択は残る）。もう一度 Esc で従来どおりの挙動。
- ペンで描き終わった直後はレベル 2（K の挙動）。

---

## L2. 挿入コードの `%%` コメント行を 1 行にする

### 現状の問題（実測）

`encodeFigureBlock`（figure-codec.ts）は scene の JSON をそのまま base64 にして **100 文字ごとに `%% tex64-figure+ …` 行**を吐く。実測:

| パスのセグメント数 | `%%` コメント行数 | TikZ 本体行数 |
|---|---|---|
| 3 | 10 | 6 |
| 8 | 21 | 11 |
| 15 | 37 | 18 |
| 40 | 95 | 43 |

さらに JSON には `1.7899999999999998` のような浮動小数のゴミがそのまま入り、TikZ 本体（3 桁丸め）と**同じ座標を二重に**持っている。加えて `% requires \usetikzlibrary{…}` の行が本文に入るが、挿入時は `planFigureInsert` がプリアンブルに `\usepackage` / `\usetikzlibrary` を自動追加しているので**重複した無駄**。

### 目標

挿入結果を「コメント 1 行 + TikZ 本体」にする:

```
%% tex64-figure v2 h=fee3ad91 eJx…（1 行、折り返しなし）
\begin{tikzpicture}[x=1mm, y=1mm]
  \draw (1,1) .. controls (1.2,1.31) and (1.49,1.79) .. (1.73,1.9);
\end{tikzpicture}
```

（エディタの word wrap は既定 off（`settings-ui/runtime.ts` の `editorWordWrapEnabled: false`）なので、長い 1 行は画面上でも 1 行。**チャンク分割はしない**。）

### 実装（figure-codec.ts）

1. **数値の正規化**: `JSON.stringify(scene, (key, value) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value)`。6 桁固定なのでユーザーが入力しうる値（プロットの `domain` 6.28319 等）は変わらず、浮動小数のゴミだけ落ちる。
2. **LZSS 圧縮**（自前・依存なし・同期・決定的）。`figure-codec.ts` 内に置く。プロトタイプで round-trip 検証済みの実装:

   ```ts
   // window 4096 / match 3..18 / 8 トークンごとに 1 フラグバイト（LSB から。1=リテラル, 0=マッチ）
   export const lzssCompress = (input: Uint8Array): Uint8Array => {
     const out: number[] = [], n = input.length, chains = new Map<number, number[]>();
     let i = 0;
     while (i < n) {
       const flagIndex = out.length; out.push(0);
       let flags = 0;
       for (let bit = 0; bit < 8 && i < n; bit++) {
         let bestLen = 0, bestOff = 0;
         const key3 = () => input[i] << 16 | input[i + 1] << 8 | input[i + 2];
         if (i + 2 < n) {
           const chain = chains.get(key3());
           if (chain) for (let c = chain.length - 1, tried = 0; c >= 0 && tried < 64; c--, tried++) {
             const pos = chain[c], off = i - pos;
             if (off > 4096) break;
             let len = 0;
             while (len < 18 && i + len < n && input[pos + len] === input[i + len]) len++;
             if (len > bestLen) { bestLen = len; bestOff = off; if (len === 18) break; }
           }
         }
         const remember = () => { if (i + 2 < n) { const key = key3(); let chain = chains.get(key); if (!chain) chains.set(key, chain = []); chain.push(i); } };
         if (bestLen >= 3) { const token = (bestOff - 1) << 4 | (bestLen - 3); out.push(token >> 8 & 255, token & 255); for (let k = 0; k < bestLen; k++) { remember(); i++; } }
         else { flags |= 1 << bit; remember(); out.push(input[i]); i++; }
       }
       out[flagIndex] = flags;
     }
     return Uint8Array.from(out);
   };

   export const lzssDecompress = (data: Uint8Array): Uint8Array => {
     const out: number[] = [];
     let i = 0;
     while (i < data.length) {
       const flags = data[i++];
       for (let bit = 0; bit < 8 && i < data.length; bit++) {
         if (flags >> bit & 1) out.push(data[i++]);
         else { const token = data[i] << 8 | data[i + 1]; i += 2; const start = out.length - ((token >> 4) + 1), len = (token & 15) + 3; for (let k = 0; k < len; k++) out.push(out[start + k]); }
       }
     }
     return Uint8Array.from(out);
   };
   ```

   バイト列 ⇄ 文字列は `TextEncoder` / `TextDecoder`、バイト列 ⇄ base64 は `btoa`/`atob`（Node 用に既存の `declare const Buffer` フォールバックを踏襲）。既存の `base64EncodeUtf8` / `base64DecodeUtf8` は v1 の復号で使うので**残す**。

3. **v2 の書式**（1 行のみ）:

   ```
   %% tex64-figure v2 h=<fnv1a32(body)> <base64(lzssCompress(utf8(json)))>
   ```

   正規表現: `/^%% tex64-figure v2 h=([0-9a-f]{8}) ([A-Za-z0-9+/=]+)$/`（`h=` は小文字 8 桁、`fnv1a32` の出力そのまま）。

4. **`% requires` 行を挿入ブロックから外す**: `encodeFigureBlock` 内で `generateTikz(scene).code` から `/^% requires(?::|\s|$)/` の行を落とす（`buildStandaloneDoc` と同じフィルタ）。`generateTikz` 自体は変更しない（既存テストが `% requires` を assert している）。ハッシュ対象の body は**落とした後**のテキスト。

5. **v1 の復号は残す**（既存文書が開けなくなるのを防ぐ）。`decodeFigureBlockAt` は v1 の従来の `%% tex64-figure+` チャンク経路と、v2 のヘッダ行から直接 payload を取る経路に分岐する。v1 ブロックを canvas で開いて保存し直すと v2 で書き戻る（＝古い巨大ブロックは編集のたびに縮む）。

### L2 のテスト（`tests/pro-canvas-codec.test.mjs` を更新 + 追加）

- `encodeFigureBlock(scene)` の出力に含まれる `%%` 始まりの行が**ちょうど 1 行**であること（40 セグメントの曲線を含む scene でも 1 行）。
- v2 ブロックの round-trip: `decodeFigureBlockAt` が元 scene と deep-equal（テスト用 scene の数値は 6 桁以内にする）、`detached === false`。
- **v1 固定文字列**（このコミット以前の形式のリテラル）を decode できること。
- 既存の「broken base64 returns null」は v2 のヘッダ行を壊す形に書き換え。
- `lzssCompress`/`lzssDecompress` の round-trip: (a) 実 scene の JSON、(b) 疑似乱数バイト列（seed 固定・自前 LCG、`Math.random` は使わない）、(c) 空・1 バイト・同一バイト 5000 個の縮退ケース。
- 挿入ブロックに `% requires` 行が含まれないこと（`arrows.meta` を要求する scene で確認）。`generateTikz` 側の既存テストは変更しないこと。

---

## 完了条件

- `npx tsc -p web-src/tsconfig.json` が 0 エラー。
- `node --test tests/*.test.cjs tests/*.test.mjs` が全 pass（`tests/nightly` は対象外）。
- 上の L2 テストを追加済み。L1 は DOM 依存のため単体テストなし（tsc + 実走で確認する）。
