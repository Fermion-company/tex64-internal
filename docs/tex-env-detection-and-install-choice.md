# TeX 環境の自動判定と完全版インストール

## 方針

TeX64 の managed install は 1 種類だけで、`scheme-full`（CTAN 全パッケージ）を
`/Users/Shared/TeX64/texlive/<year>` へ導入する。軽量版、段階導入、初回の
パッケージ選択は設けない。

## 自動判定

`electron/services/tex-detect.cjs` と `EnvService.detectEnvironment()` が次を調べる。

- engine / latexmk / SyncTeX などの有無
- TeX64 管理下か system TeX か
- TeX Live / MiKTeX、年、root
- `kpsewhich` による代表パッケージの網羅度

既存環境が十分ならインストール画面を出さず、その環境をそのまま使う。system TeX は
ビルドに利用できるが、TeX64 から書き込まない。

## 初回導入

TeX が無い場合だけ `web-src/app/onboarding-ui.ts` のゲートを表示する。操作は
「TeX Live を導入」の 1 つで、`install-tl` の profile は常に
`selected_scheme scheme-full` を含む。

導入中は install-tl / tlmgr の実進捗を表示する。scheme-full は処理時間の大半が
install-tl の 0〜80% に集中するため、`timeFractionForPercent()` でバーの割合を
経過時間割合に写してから残り時間を推定する。

managed root の `tex64-install.json` には `variant: "full"` を記録する。旧開発版の
`variant: "light"` を見つけた場合だけ、既存ツリーに `tlmgr install scheme-full` を
実行して完全版へ昇格し、marker を `full` に書き換える。

## 検証

- `tests/tex-env-detect.test.cjs`: 検出・所有者・網羅度・推奨アクション
- `tests/tex-install-variants.test.cjs`: 全 target の full 正規化、profile、marker
- `tests/onboarding-eta.test.mjs`: full 用時間曲線と残り時間
- `tests/e2e/onboarding-flow.test.cjs`: 単一導入アクション、進捗、完了/失敗遷移
