# TODO

Claude にやってほしいタスクをここに書く。上から順に着手する。
会話の最初に「TODO.md 見て」と言えば拾える。

## やること

- AI モードの受け入れ確認: [docs/ai-mode-paper-e2e.md](docs/ai-mode-paper-e2e.md) の通り学部量子力学の教科書を S1 から実際に書き、チェックリストを埋める。

- tdom-core: galley ジョブ無応答の再発監視（2026-08-20 に対処済み、tdom-core 082439a）。fork 失敗の即時 FORKFAIL 通知・インフラ障害の全面再構築エスカレート・lineage 退役・forensics 記録を実装し、fault 注入テストで 3 経路とも治癒を確認。残る未確定点は「あの日のハングの一次原因が fork 失敗（EAGAIN/ENOMEM）か fork 済み子の deadlock か」だけで、再発時は update レポートの stats.diagnostics（`fork-failed` / `no child ever announced` / `killed child N`）で判別できる。


## 完了

- AI モード大改修「Base44 型ノーコード執筆」（2026-08-13）: モードスイッチャーをトップバー左（サイドバートグル右隣）に固定。tex64-ai に (1) build-first インテーク（主題があれば残りは委任で即執筆、質問は最大1問） (2) 会話的反復編集（内容のある文書への新規依頼は brief 再走なしの編集実行、エージェントの締めメッセージを resultNote として会話に表示） (3) 内製 PDF ビューア（pdfjs-dist）+ SyncTeX 由来の要素マップで PDF 上の節・段落・数式・図表をクリック選択 → AI 依頼のスコープ化（targetNodeId）/ その場で直接編集 (4) 手動編集・復元後の自動再コンパイル `POST /compile`（失敗時は直前紙面を保持し AI 修復導線） (5) 進捗チェックリスト `GET /runs/:id/events` (6) 変更履歴パネルと版の復元 `POST /restore`。migration 0010（result_note / target_node_id）。要素マップは latex.ts の `%%T64B/E` コメントマーカー（レイアウト影響ゼロ、実測検証済み）+ synctex-regions パーサ（実 lualatex + ltjsarticle 統合テスト付き）。artifact quality v3。suggestion-card（先回りチップ）は撤去し、選択チップに一本化。

- 数式サジェスト全ロジックの UX 監査（2026-07-07）: 実 arXiv 論文（数学/物理/CS、85 ファイル・数式内コマンド 11,386 出現）で打鍵シミュレーションを実施。標準コマンドの加重 top-1 は 97.3% → 欠落していた「コマンド名そのままのトリガー」18 件（mathrm/mathbf/mathcal/operatorname/langle/lfloor/cfrac/pmod/prime/dotsc 等）を追加して **99.9%**・退行ゼロ。「途中まで打つと出るのに最後まで打つと消える」パターンも解消。恒久回帰テスト tests/math-suggest-command-names.test.mjs を追加。sin→\sin は tier ランキングで解消済みを確認。

- アプリ内課金導線（2026-07-07）: Stripe Embedded Checkout をアプリ内モーダルで完結。使用量バナー（トークンのみ）・未ログイン時のログインCTA・決済後のエンタイトルメント反映ポーリング・設定 > アカウントからの入口を追加。プラン変更/解約は Stripe Customer Portal（アプリ内子ウィンドウ）。
- ボトムパネルのターミナル（2026-07-07）: Blocks タブの右に Terminal タブ（xterm + node-pty、ワークスペース cwd・ログインシェル・テーマ連動・IME 対応）。Ctrl+` で開閉、ヘッダーに新規セッションボタン。

- Issue #38 の修正と追加（2026-09-02）:
  - **ビルド対象**: ビルドボタンは「開いている .tex が属する文書」をビルドする（`% !TEX root` → ワークスペースルート配下なら親 → 自己完結文書なら自分 → それを include する兄弟 → ルート）。ネストした 2 つ目の `main.tex` で別文書の PDF が出る問題を解消（`workspace.resolveBuildTarget` / `tex-build-target.cjs`）。
  - **外部変更の反映**: `file-watcher.cjs` がワークスペースを監視し、未編集のバッファはカーソルを保ったまま再読込、未保存編集があるタブは上書きせず選択バーを出す。ファイルツリーも自動更新。
  - **スクロールバー**: Monaco の縦スライダーを常時表示（`scrollbar.vertical: "visible"`）＋コントラスト強化。
  - **ターミナル**: 複数タブ（Ctrl+T / Cmd+T）、2 ペイン分割、別ウィンドウ（`terminal-window.html` + `terminal-preload.cjs`）、終了済みセッションはキー入力で自動復帰、ファイルツリーから「内蔵ターミナルで開く」（その階層が cwd）。
  - **ファイル作成導線**: ファイルツリー下部の空白領域をホバーで光らせ、右クリックでワークスペース直下の New file / New folder / Paste / Finder / ターミナル。
  - **ソース管理**（新規サイドバータブ）: ブランチ表示・切替・作成、fetch/pull/push、ステージ/アンステージ/破棄、コミット、差分を Monaco 差分エディタで表示。マシンの `git` を実行するだけで、トークンは保存しない。
  - **スニペット**（新規サイドバータブ）: 一覧・検索・作成・編集・削除、global / workspace の 2 スコープ、Monaco 補完（prefix 入力 → `${1:...}` がタブストップ）、組み込み 5 件。
- 設定欄の情報ページ: リンク先 7 つ（/terms /privacy /legal /docs /feedback /releases）全て実 URL で存在することを確認済み（2026-07-07）。

