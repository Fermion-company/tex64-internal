# zotero-20261031 — Zotero 連携の確認

## 目的

エディタのコンテキストメニュー「Zotero から引用を挿入…」と、そのダイアログの「.bib を Zotero と同期」を実機で確かめる。
この Mac に Zotero は入っていないので、Zotero の代わりに `mock-zotero.cjs` を立てて 3 経路のうち 2 つ（Better BibTeX JSON-RPC、Zotero 7 ローカル API）を模した。Web API（`https://api.zotero.org`）は実キーがないため未確認。

## 道具

| ファイル | 内容 |
| --- | --- |
| `mock-zotero.cjs` | `http://127.0.0.1:23119` で `POST /better-bibtex/json-rpc`（`user.groups` / `item.search` / `item.export`）と `GET /api/users/0/...` `GET /api/groups/4242/...`（`format=bibtex` 対応）を返す。個人ライブラリ 4 件 + グループ「Lab Group」2 件。`MOCK_BBT=0` で BBT を閉じ、`MOCK_LOCAL=0` でローカル API も閉じる。`PUT /mock/bump?key=<itemKey>` で題名を変え、同期の差分を作る |
| `drive.mjs` | Playwright で worktree のアプリを起動し、`test-workspace` の複製（`RUN_DIR/project`、メインは `main.tex`）に対して一連の操作を行う。結果は `RUN_DIR/result.json`、画面は `shots/` |

```sh
RUN_DIR=/tmp/zotero-run SHOTS_DIR=$PWD/testing/zotero-20261031/shots node testing/zotero-20261031/drive.mjs
```

手で触るときは `node testing/zotero-20261031/mock-zotero.cjs` を立てたまま `npx electron .` で開く。

## 手順と結果（2026-10-31、評価 r2 反映後）

| # | 操作 | 結果 |
| --- | --- | --- |
| 1 | BBT あり。空行で右クリック →「Zotero から引用を挿入…」→ `turing` → Enter | `\cite{turing1950computing}`。`main.tex` に `\bibliography` は無いが直下の `refs.bib` に追記し、状態行で `\bibliography{refs}` の追加を促す（`references.bib` は作らない） |
| 2 | Settings → Zotero でライブラリを「Lab Group」に | 状態行が `Better BibTeX · Lab Group — Better BibTeX: 接続中 · …` |
| 3 | `\cite{turing…}` の中にカーソルを置いて `attention` → Enter | `\cite{turing1950computing,vaswani2017attention}`（`,key` 追記）。エントリには `% zotero: bbt:7/VASWANI17` |
| 4 | mock 側で Vaswani の題名を変えて「.bib を Zotero と同期」 | `refs.bib: 更新 1 · 変更なし 1`（手書きの 3 件は数えない） |
| 5 | BBT を閉じてローカル API のみ | ライブラリ選択は名前で引き継がれ `この PC の Zotero · Lab Group`。`attention` を再挿入しても同じ item key を見て `既存`、キーも同じ |
| 6 | 続けて `hinton` を挿入 | カーソルが直前の `\cite{…}` の直後なので `\cite{vaswani2017attention,hinton2006fast}`。ローカル API に citekey が無いので BBT 既定形で `hinton2006fast` を生成。`% zotero: groups:4242/HINTON2006` |
| 7 | 同期 | BBT 時代の `bbt:…` 注記もライブラリを総当たりして照合。`更新 2 · 変更なし 1` |
| 8 | 両方閉じる | ダイアログは `Zotero を起動するか、設定 → Zotero で API キーを入れてください。` の 1 文。経路ごとの内訳は Settings のみ |

スクリーンショットは `shots/00-context-menu.png` 〜 `10-settings-unreachable.png`。
