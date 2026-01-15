# Project implementation

## 目的

- プロジェクト単位の設定（メインTeX/環境レジストリ）を管理する。

## 主要ファイル

- `web-src/app/root-selector-ui.ts`: メインTeXの選択/自動検出。
- `web-src/app/env-registry-ui.ts`: math/table 環境の有効/無効・追加/削除（検出は数式のみ）。
- `web-src/app/env-registry.ts`: 環境定義の基礎データ。
- `electron/services/workspace.cjs`: `.tex64/settings.json` に rootFile を保存。

## データ/保存

- `.tex64/settings.json`: rootFile (manual/auto)。
- localStorage:
  - `tex64.custom-env-registry`
  - `tex64.disabled-env-registry`

## 反映

- 環境変更は数式ブロック自動検出の判定に使用される。

## ユーザーメモ
シンプルに実装し直す
