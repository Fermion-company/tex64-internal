# testing/

テスト用の文書・ドライバ・計測記録はすべてここに置く。git で追跡するのは `README.md`、`test-workspace/`、`test-sample-hover/`、`evidence/` だけ。

## 規則

- 新しい検証フォルダは `testing/<name>-<YYYYMMDD>/` に作り、README に目的・ドライバ・結論を書く。
- 原本（`sandbox-pro/` など）は書き換えない。E2E は `RUN_DIR` に複製して使う。
- 組版の中間生成物（`.aux` `.log` `.synctex.gz` `.fdb_latexmk` `.fls`）は残さない。
- 計測の `runs/<name>/` に残すのはログ（`*.log`・`*.jsonl`・`result.json`）とスクリーンショットだけにする。`profile/`・`tdom-work/`・`fixture/`・`project/`・`work/` は、計測が終わったら消す（再生成できる）。

## 原本

| フォルダ | 内容 |
| --- | --- |
| `sandbox-pro/` | 316 ページの jlreq 文書。大規模文書のライブプレビュー計測の原本 |
| `sandbox-ed/` | TeX64 Education の教材プロジェクト（`Open in TeX64 Education.command`） |
| `stress-docs-20260921/` | ストレステスト用の 20 文書（`% EDIT:` の位置で打鍵） |
| `test-workspace/`・`test-sample-hover/` | 手で触って確かめる作業フォルダ（追跡） |

## 検証の記録

| フォルダ | 内容 |
| --- | --- |
| `demo-videos-20260927/` | 大・小・装飾の 3 文書の打鍵デモ動画と、プレビュー反映の計測（tex64-internal #102〜#104）。アプリ実機ドライバ `record.mjs`（動画は `VIDEO=1` のときだけ）、集計 `analyze.py` |
| `large-typing-20260924/` | 大規模文書の打鍵反映（tex64-internal #61・#81〜#97）。API ドライバ `large-typing.mjs`、アプリ実機ドライバ `app-*.mjs` |
| `kk-packages-20260925/` | lua-ul・KKluaverb・KKsymbols の確認（#97） |
| `pdf-jump-find-save-20260924/` | ジャンプ・PDF 内検索・保存状態（#78〜#80） |
| `baseline-grammar-20260924/` | 左端アクセントバーの置き換えの撮り比べ |
| `lightweight-20260921/` | 軽量化の実測（#70〜#75）、テスト用アプリの起動道具 |
| `stress-results-20260921/` | 20 文書のストレステスト（#62〜#69） |
| `validation-20260919/` | CI 失敗ログと要件メモ |
| `live-preview-evidence/` | ライブプレビュー検証の記録（issue #52、r28〜r31） |
| `evidence/` | 公開ワークフローの検証記録（追跡） |
| `archive/` | 退避したパッチと古い worktree の記録 |
