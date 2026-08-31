# AI モード macOS アプリ受け入れ確認

> **配布状態**: この受け入れは保持実装の検証記録であり、一般配布ではAIモードと
> モード切替を非表示・起動不可のままにする。Code内のAxiomは引き続き提供する。

AI モードは、機能一覧や単体テストではなく、**パッケージした macOS アプリで実際に文書を
書き、組版し、終了後に続きから作業できるか**で判定する。正本は Code と共通の
ワークスペースにある `.tex` であり、旧構造化文書ストアは受け入れ対象にしない。

## 合格条件

- ユーザーは AI では PDF と会話を中心に作業できる。必要なら Code で同じ `.tex` を開ける。
- AI の完了報告だけを根拠にしない。ディスク上のソース、実 `latexmk`、生成 PDF を確認する。
- Code / AI / 文書 / ワークスペースを切り替えても、古い保存・組版・PDF・会話が混ざらない。
- 実行中の次メッセージ、停止、undo、アプリ再起動後の復元が実際に動く。
- 認証、Free 枠、Axiom モデル、Pro 制限、課金導線が Code と同じ状態を示す。
- パッケージは UI サーバーを自己完結で同梱し、外部 UI や開発サーバーを必要としない。

## LLM 利用を増やさない回帰方針

- 実 LLM を使う受け入れ操作は、同じシナリオを繰り返さない。実ソース・実 PDF・tool 履歴の
  証跡が取れた時点で、そのシナリオの有料再走は終了する。
- 以後の回帰確認は mock provider と決定論的な tool 呼び出しで行う。ただし組版だけは
  `BuildService` と実 `latexmk` を使い、生成 PDF を `pdftotext` まで確認する。
- `tests/agent-multi-request-real-build.test.cjs` は、同じ文書に対する追記、既存文と式の修正、
  label/ref 追加、章末問題追加の4種類を順に適用し、各依頼の直後に実組版する。LLM/APIは呼ばない。

## S1 — 第4章「調和振動子」

次の6つを論理的な受け入れ指示とする。実走済みの指示は、回帰のためだけには再送しない。
複数の未確認項目を一度の修正依頼へまとめた場合も、各項目をソースと PDF で個別に判定する。

1. 「学部向け量子力学の教科書の第4章として、調和振動子の章を書いて。代数的解法から座標表示、不確定性まで」
2. 「\([a,a^\dagger]=1\) からエネルギー固有値を出すところが飛んでいる。数演算子の固有値が非負整数になる理由を段階的に」
3. 「基底エネルギーが \(\hbar\omega/2\) になることを定理として立てて、証明を分けて」
4. 「エルミート多項式の漸化式の式を、座標表示の節から参照して」
5. 「\(\langle x^2\rangle\) と \(\langle p^2\rangle\) の書き方が節ごとに違う。期待値は \(\langle\cdot\rangle_n\) に統一して」
6. 「章末問題を5問。うち2問は計算問題、3問は導出問題」

各ターン後に次を機械確認する。

- 対象 `main.tex` の mtime と内容が変わった
- `latexmk` が成功し、対象文書の PDF だけが更新された
- PDF のページ数が0でなく、依頼した見出し・式・問題が `pdftotext` で読める
- AI の返答と紙面の内容が一致する

## アプリ操作の横断確認

| # | 操作 | 合格条件 | 状態 |
|---|---|---|---|
| 1 | パッケージ起動 | 内蔵 Next が動的 loopback port で起動し AI 画面と PDF が出る | OK |
| 2 | Code → AI | 実行中処理を停止し、未保存 Code buffer を保存してから切り替わる | OK |
| 3 | AI → Code | AI の編集が同じ Monaco model とディスクに見え、後の保存で戻らない | OK |
| 4 | 文書切替 | 文書別の PDF、会話、undo、組版 target が混ざらない | OK |
| 5 | workspace 切替 | 同名 relative path でも古い read / preview / format / build が出ない | OK |
| 6 | 組版失敗 | 最後に成功した PDF を保持し、修正後に対象文書だけ更新する | OK |
| 7 | 連投 | 実行中に送った次の依頼を FIFO で処理する | OK（決定論回帰） |
| 8 | 停止 | backend の terminal state を待って停止し、次の依頼を送れる | OK（決定論回帰） |
| 9 | undo | 1ターンの全変更をまとめて戻し、再組版する | OK |
| 10 | 再起動 | 会話と undo が復元され、終了直前の変更も失われない | OK |
| 11 | PDFクリック | SyncTeX 逆引きで正しい段落を選び、CAS 直接編集後に再組版する | OK |
| 12 | モデル | Axiom 1.0 / Axiom 1.0 Pro だけを表示し、Free では Pro を実行できない | OK |
| 13 | 利用枠 | 匿名またはログイン済み Free が実行でき、表示は token のみ | OK |
| 14 | 課金導線 | Basic / Pro の実プランと金額が Checkout まで一致し、決済完了・Webhook・アプリ反映まで動く | OK（実Checkout） |
| 15 | 子process復旧 | 内蔵 UI process を停止後、再接続で新portの UIへ戻る | OK |
| 16 | 終了 | アプリ終了後に内蔵 UI process と loopback listener が残らない | OK |

## S1 内容チェック

| # | 項目 | 状態 | 根拠 |
|---|---|---|---|
| 1 | 主題だけで章の初稿を作る | OK | 実 LLM 1ターン目。実 `main.tex` と7ページPDFで章全体を確認。 |
| 2 | 固有値導出の粒度を会話で直す | OK | 数演算子の正値性、下降列、非負整数をソースと紙面で確認。 |
| 3 | 定理と証明を分ける | OK | PDFの定理4.1「基底エネルギー」と独立した証明を確認。 |
| 4 | エルミート多項式の式を本文から参照する | OK | 漸化式 (4.18) と座標表示からの参照を確認。 |
| 5 | 期待値表記を章内で統一する | OK | `\langle\cdot\rangle_n` の統一をソースで確認。 |
| 6 | 指定内訳どおり章末問題を5問作る | OK | PDFで計算2問、導出3問を確認。 |

状態は `未` / `OK` / `NG（再現と原因）`。回避策で先へ進んだ項目は OK にしない。

## 将来の規模試験

S1 合格後に、第3・4・6章、章末問題と解答、全15章、索引・記号一覧の順で規模を上げる。
旧実装にあった 2 MiB JSON、500 revision、`ltjsarticle` 固定、目次・画像不可という上限は
`.tex` 正本への移行で受け入れ条件から消えた。以後の上限は、実ワークスペースで大きな `.tex` と
画像を使い、Code 共通のファイル・組版経路を計測して判断する。

## 実走記録

### 2026-08-29 macOS arm64

- app: `/Users/wedd/tex64-internal/dist/mac-arm64/TeX64.app` を
  `/Applications/TeX64.app` へ同一バイトで配備。実行ファイル SHA-256 は
  `b99049dfbb6fe63909bfd50c2cab77305666e069f17194b4f1c798f153c50ff3`。
- Developer ID 署名を `codesign --verify --deep --strict` で確認。ローカル受け入れ用の
  `.app` であり、このビルド単体には notarization ticket を付けていない。
- workspace: `/tmp/tex64-ai-final-e2e.Fod5qE`
- source: `main.tex` SHA-256
  `8c69b6642acf260755298c75fa4ca38a124b01f187cffc46a50ac7a5c323bb67`
- PDF: 7ページ、156,952 bytes。目次、定理4.1、式参照、章末問題5問を `pdftotext` で確認。
- 実 LLM は2ターンだけ使用した。1ターン目で初稿、2ターン目で残る5指示をまとめて実行し、
  以後は再送していない。回帰は mock / 決定論 tool 実行と実 `latexmk` だけで行った。
- Code の実ビルド成功後、意図的な未定義コマンドで失敗させても直前PDFのSHA-256が不変で、
  修正後の再ビルドが成功することを確認した。
- エージェントがファイル編集後に `compile_document` を呼ばず正常終了した場合も、追加のAI呼び出しを
  行わず最後に1回だけ実組版する。モデルが組版済みなら重複せず、組版失敗時は再開可能な状態を
  維持する3経路をmock providerで固定した。完了後のUI側の重複組版も廃止し、中断時の部分変更だけを
  Electron側で停止・通信失敗を含めて1回組版する。再接続したUIもこの確定結果を使うため重複組版しない。
  組版失敗時は同じ内容を再試行せず、永続メッセージまたはlive errorで未完了を明示する。
- 当時の root `node:test` は890件中887件合格。旧ライブ専用表示の既知項目3件は、
  その表示経路自体の撤去に伴い後日削除した。
- `/Applications/TeX64.app` のAI画面で内蔵Next、loopback listener、texlabが動いている状態から
  `Cmd+Q`を一度だけ実行し、本体、Helper、内蔵Next、texlab、listenerがすべて終了したことを
  processとportの両方で確認した。
- スクリーンショット:
  `/private/tmp/tex64-ai-final-success-2026-08-29.png`、
  `/private/tmp/tex64-ai-final-mode-2026-08-29.png`
- 100%割引を適用した本番Checkoutを1回だけ完了し、請求合計が0であることを確認した。
  `checkout.session.completed` と、その直後に行った検証用subscription解約の
  `customer.subscription.deleted` は、どちらも本番WebhookがHTTP 200で受理した。
- 解約後のStripe由来レコードは履歴とevent orderingのため保持しつつ、ユーザー向けの実効状態を
  `Free / active` に変換する。本番APIをアプリと同じ認証コードで再取得し、FreeでAI利用可能な
  状態へ戻ったことを確認した。実LLMは追加で呼んでいない。
- 旧購入完了URLは本番で `/checkout/complete?checkout=success` へ307転送される。Chromeで
  再ログイン、ナビゲーション、Download導線がない完了画面を確認し、`TeX64に戻る` の
  `tex64://billing/complete?checkout=success` からインストール済みmacOSアプリが起動して
  entitlementを再取得することを確認した。スクリーンショットは
  `/private/tmp/tex64-checkout-complete-production.png`。
