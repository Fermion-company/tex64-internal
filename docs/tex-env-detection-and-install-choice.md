# TeX 環境の自動判定と軽量インストール

## 方針

TeX 未導入ユーザーには、公式 TinyTeX-1 配布物を TeX64 の managed root
（macOS: `/Users/Shared/TeX64/texlive/<year>`、Windows: `%LOCALAPPDATA%\\TeX64\\texlive\\<year>`）へ展開する。実際の導入先は `electron/services/texlive-paths.cjs` に従う。

軽量環境にない `.sty` / `.cls` 等がビルドログに現れた場合、managed `tlmgr` で
ファイルを提供するパッケージを検索・導入し、同じ文書を自動で再ビルドする。
最大4回で打ち切り、同一パッケージを同じビルド中に再導入しない。

設定 > 環境から `scheme-full`（CTAN 全パッケージ）へ昇格できる。完全版は軽量版へ
ダウングレードしない。

## 自動判定

`electron/services/tex-detect.cjs` と `EnvService.detectEnvironment()` が次を調べる。

- engine / latexmk / SyncTeX などの有無
- TeX64 管理下か system TeX か
- TeX Live / TinyTeX / MiKTeX、年、root
- `kpsewhich` による代表パッケージの網羅度
- managed marker の `light` / `full`

既存環境が十分ならインストール画面を出さず、その環境をそのまま使う。system TeX は
ビルドに利用できるが、TeX64 から書き込まない。不足パッケージの自動導入も TeX64 の
managed `light` 環境だけを対象にする。

## 初回導入

TeX が無い場合だけ `web-src/app/onboarding-ui.ts` のゲートを表示する。操作は
「すぐにセットアップ」の1つで、公式 TinyTeX-1 の daily asset を取得する。
`tlmgr path add` は実行せず、TeX64 が管理する bin をプロセス PATH の先頭に加える。

ダウンロード中は Content-Length と受信バイト数から実進捗を表示する。展開・初期化も
同じ単調増加バーへ割り当てる。

managed root の `tex64-install.json` には `variant: "light"` を記録する。設定から完全版を
要求されたときだけ `tlmgr install scheme-full` を実行し、成功後に `variant: "full"` へ
書き換える。

## 不足パッケージの自動補完

ビルド失敗ログから安全なベース名だけを抽出し、次を実行する。

1. `tlmgr search --global --file /<file>`
2. 完全一致するファイルを含むパッケージ名を検証
3. managed `tlmgr install <package>`
4. 同じビルドを再実行

パスを含む検索語、許可していない拡張子、不正なパッケージ名は拒否する。検索・導入に
失敗した場合は元のビルドエラーをそのまま表示する。
