# TODO

Claude にやってほしいタスクをここに書く。上から順に着手する。
会話の最初に「TODO.md 見て」と言えば拾える。

## やること


## 完了

- 数式サジェスト全ロジックの UX 監査（2026-07-07）: 実 arXiv 論文（数学/物理/CS、85 ファイル・数式内コマンド 11,386 出現）で打鍵シミュレーションを実施。標準コマンドの加重 top-1 は 97.3% → 欠落していた「コマンド名そのままのトリガー」18 件（mathrm/mathbf/mathcal/operatorname/langle/lfloor/cfrac/pmod/prime/dotsc 等）を追加して **99.9%**・退行ゼロ。「途中まで打つと出るのに最後まで打つと消える」パターンも解消。恒久回帰テスト tests/math-suggest-command-names.test.mjs を追加。sin→\sin は tier ランキングで解消済みを確認。

- アプリ内課金導線（2026-07-07）: Stripe Embedded Checkout をアプリ内モーダルで完結。使用量バナー（トークンのみ）・未ログイン時のログインCTA・決済後のエンタイトルメント反映ポーリング・設定 > アカウントからの入口を追加。プラン変更/解約は Stripe Customer Portal（アプリ内子ウィンドウ）。
- ボトムパネルのターミナル（2026-07-07）: Blocks タブの右に Terminal タブ（xterm + node-pty、ワークスペース cwd・ログインシェル・テーマ連動・IME 対応）。Ctrl+` で開閉、ヘッダーに新規セッションボタン。
- 設定欄の情報ページ: リンク先 7 つ（/terms /privacy /legal /docs /feedback /releases）全て実 URL で存在することを確認済み（2026-07-07）。

