# Pro 作図キャンバス E 実装仕様 — 対称オーナメント配置

C/D の続き。鏡映は `tx=W, sx=-1`（シンボル座標は絶対座標で焼かれているため）、
四隅はシンボルの絶対 bounds から導出する。

## 純関数（`canvas-math.ts`）

```ts
export const mirrorInstanceTransform = (artboardWidth: number): Transform

export const cornerInstanceTransforms = (
  bounds: Bounds,
  artboardWidth: number,
  artboardHeight: number,
  inset: number,
): [Transform, Transform, Transform, Transform]
```

- 左下、右下、左上、右上の順に返す。
- 左右の鏡映は `sx=-1`、上下の鏡映は `sy=-1` を使う。
- 各コーナーで symbol bounds の最寄り 2 辺が `inset` の位置に来るようにする。

## UI（`canvas-ui.ts`）

- Symbols セクションの「選択を対称シンボル化」は、選択をシンボル化した後、
  identity と `mirrorInstanceTransform(scene.width)` の 2 インスタンスを追加する。
- シンボル行の「四隅に配置」は、inset と bounds から 4 インスタンスを追加し、
  1 グループとして選択する。
- どちらも snapshot → render → scheduleCompile の既存パターンを使う。

図一覧 UI は持たない。現在の図を直接 Draw で編集する。
