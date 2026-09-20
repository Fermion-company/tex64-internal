# リアルタイムプレビューの実機 E2E

`live-preview-e2e.mjs` は Playwright で Electron アプリを起動し、316 ページの sandbox プロジェクトの複製に対して「開く → canonical 収束 → Build → PDF の位置決め → キャレット → warm 待ち → 入力 → 観測」を行う。issue #52 の Build 後ライブプレビュー（hold・viewport handoff・受理版ゲート）と canonical-anchor の確認に使う。

## 前提

- `/Applications/TeX64.app` と他のエンジンを止めておく（エンジンは同時に 1 つ。`pgrep -x lualatex | wc -l` が 0）。ドライバは lualatex が 30 を超えたら止まる。
- sandbox（既定 `~/Desktop/tex64-pro-sandbox`）の `main.tex` と `content/ch16.tex` のハッシュは既定値と一致すること（`MAIN_SHA`・`CH16_SHA` で変更可）。原本は複製して使い、書き換えない。
- checkpoint の上限はアプリが搭載メモリで決める（16 GB なら 12）。`TDOM_MAX_CHECKPOINTS` を渡すとその run だけ固定できる。

## 実行

```bash
RUN_DIR=/path/to/run ENGINE_DIR=$HOME/Desktop/tdom-engine node scripts/e2e/live-preview-e2e.mjs
```

主な環境変数:

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `RUN_DIR` | 必須 | プロジェクト複製・profile・ログ・スクリーンショットの置き場 |
| `ENGINE_DIR` | 必須 | tdom-engine のチェックアウト（`TDOM_ENGINE_DIR` として渡す） |
| `APP_DIR` | リポジトリ | 起動するアプリ |
| `SKIP_BUILD` | 0 | 1 なら Build せず Live のまま測る |
| `TARGET_PAGE` | 163 | PDF を合わせるページ |
| `WARM_WAIT_MS` | 6000 | キャレット設置から入力までの待ち（warm 完了待ち） |
| `TYPE_TEXT` / `TYPE_DELAY_MS` | `X` / 0 | 入力する文字列と打鍵間隔 |
| `BACKSPACES` / `BACKSPACE_AFTER_MS` | 0 / 4000 | 入力後に消す文字数と時刻 |
| `SCENARIO` | なし | `stale-canonical`（古い版の canonical が入力中に届く）、`restart-held`（Build の hold 中にエンジンを落とす） |
| `CROSS_FILE` / `CROSS_LINE` / `CROSS_TEXT` / `CROSS_PAGE` / `CROSS_SHA` | なし | 最初の入力（と `BACKSPACES`）の後に別ファイルを開き、`CROSS_LINE` 行末の `。` の前に `CROSS_TEXT` を入力する（issue #52 D の章またぎ確認）。`CROSS_PAGE` があれば入力前に PDF をそのページへ動かす。`CROSS_SHA` は開いたモデルの原本一致確認 |
| `CROSS_NO_WARM` / `CROSS_SAMPLE_COUNT` | なし / 24 | `CROSS_NO_WARM=1` で warm を待たずに即打鍵する（cold keystroke、tdom docs/10 §10.4a: 応答は予算内、組版結果は後から `update` で届く）。`CROSS_SAMPLE_COUNT` は打鍵後 500ms ごとの記録回数 |

新しい profile では起動直後に Settings（runtime onboarding）と更新告知が開くので、ドライバが閉じる。新しい profile の初回 Build は PDF を開かない（Build 後に PDF を開くのは auto SyncTeX の結果で、キャレットが前文にあると同期先がない）。ドライバは renderer が要求していない `openFile` を送り、host が PDF を押し込むときと同じ経路で secondary group に出す。Build しない場合は Live の枠をツールバーのページ入力で目的ページへ動かす。

## 出力

`RUN_DIR` に `driver.jsonl`（段階の記録）、`sse.jsonl`（エンジンの report と anchor の結果）、`samples.jsonl`（100ms ごとの PDF 表示状態）、`shots/`（入力からの経過 ms を名前にしたスクリーンショット）。

## 期待値（Apple M4・16GB、2026-09-11〜12、エンジン 80af71a）

- Build → 163 ページ → ch16:33 の `iii` の後に `X`（r28）: 入力 +0.57 秒で resident 更新と anchor 準備完了、+0.74 秒で同じ activation のまま Live、163 ページの正しい位置に `X`。canonical は約 100 秒後に置換。ページ移動・iframe 再生成なし。
- Build なしで `XYZ` を 150ms 間隔、5 秒後に 3 文字削除（r29）: 各打鍵に anchor（proof 241〜286ms）。最後の削除で原文に戻ると anchor は作られず、canonical（原文と同じ）へ戻る。
- `SCENARIO=stale-canonical`（r30b）: X（rev3）と Y（rev4）は anchor。rev3 の canonical が +68 秒に届いても表示は XY のまま。その後の Z（rev5）は `canonicalAnchorRefused: base-generation` になり、表示は base（rev2）の「iii。」へ巻き戻る（rev5 の canonical +170 秒まで）。既知の不具合（引き継ぎ資料）。
- `SCENARIO=restart-held`（r31）: Build の hold 中にエンジンの server を kill しても静的PDFが 163 ページのまま所有し、復旧後の新しい activation も held（`build-held`）。その後の X は +0.55 秒で anchor、+0.62 秒で Live。
- lualatex の同時数は最大 16〜18 程度。
