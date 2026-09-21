# testing/

このプロジェクトのテスト用フォルダはすべてここに置く（2026-09-21 規約）。`README.md` 以外は git 管理外。

| フォルダ | 用途 |
| --- | --- |
| `sandbox-pro/` | 316 ページの実文書（issue #52 ライブプレビューの E2E 原本。`scripts/e2e/live-preview-e2e.mjs` の既定 `SANDBOX`） |
| `sandbox-ed/` | TeX64 Education の教材プロジェクト（`Open in TeX64 Education.command` で起動） |
| `validation-20260919/` | CI 失敗ログと要件メモ |
| `live-preview-evidence/` | ライブプレビュー検証の記録（r28〜r31） |

- 原本は書き換えない。E2E は `RUN_DIR` に複製して使う。
- 組版の中間生成物（`.aux` `.log` `.synctex.gz` `.fdb_latexmk` `.pdf` 出力）は残さない。
- 新しい検証フォルダは `testing/<name>-<YYYYMMDD>/` に作る。

追跡対象（git 管理）: `test-workspace/`（サジェスト・エディタ確認用）、`test-sample-hover/`、`evidence/`（issue 検証記録）。
