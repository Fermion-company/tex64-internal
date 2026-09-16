# 製品活動の計測

パッケージ版のみ、疑似匿名のinstallation IDとOS・arch・version・配布経路を公式APIへ送る。開発起動とE2E headlessでは送信しない。原稿・ファイル名・パス・コンパイラログは送らない。

- 既存のactivityはUTC日に1回、前面のアプリから送信する。
- BuildServiceが新しいPDFの出力を成功として確定した後、`first_pdf`を初回だけ送信する。Code・Axiomのビルドが共通の判定を使う。失敗、キャンセル、PDF不在、古いPDFの保持、cleanは成功に含めない。
- 通信失敗は編集・ビルドを止めない。次の成功時に再試行する。サーバーがmilestoneを受理したと明示するまではローカル完了印を付けない。
- サーバーはinstallation IDとmilestoneで重複を防ぐ。既存利用者のアップデート後の初回観測も含み、初めてインストールした人数とは呼ばない。
- 日別活動・集計・保存期間は公式サイトの`docs/growth/operations.md`とプライバシーポリシーで管理する。
