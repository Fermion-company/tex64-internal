# TeX 環境の自動判定と 2 択インストール

> ブランチ `feat/tex-env-detect-and-install-choice` の試作。
> 現行 CLAUDE.md の「ワンクリックで scheme-full 一択」方針を、ユーザー指示により
> 「自動判定 + 2 択」に拡張した検証実装。採用が決まったら CLAUDE.md 側の方針記述を
> 更新する必要がある（未更新のまま）。

## 1. なぜ

- **既に TeX がある人に 5 GB を再ダウンロードさせるのは不合理**。MacTeX を持っている
  ユーザーには「あなたの TeX を使います」とだけ言えばいい。判定できれば、そもそも
  インストール画面に選択肢を出す必要がない。
- **無い人には、容量と「もう二度とパッケージのことを考えない」のトレードオフを 1 画面で示す**。
  ただし軽量側が「後で `.sty` が無いと言われる」体験になるなら選ばせてはいけない。
  そこで TinyTeX (<https://yihui.org/tinytex>) の設計を採る：**小さく入れて、
  足りないものはビルド時に自動で取ってくる**。

## 2. 自動判定

`electron/services/tex-detect.cjs`（純粋関数）+ `EnvService.detectEnvironment()`（実行）。

プロセス起動は最大 2 回（`tlmgr --version` または engine の `--version`、および
`kpsewhich` 1 回）。結果は 10 秒キャッシュし、インストール後に無効化する。

判定する内容:

| 項目 | 方法 |
| --- | --- |
| エンジン/ツールの有無 | `findTexCommand`（managed → system → PATH の順） |
| 所有者 (`source`) | バイナリパスが managed root 配下か = `managed` / `system` / `none` |
| ディストリ種別と年 | `tlmgr --version` の `using installation:` 行と `TeX Live YYYY`、MiKTeX は banner |
| MacTeX / TinyTeX の別 | `/usr/local/texlive` 配下か、root に `.tinytex` トークンがあるか |
| **パッケージ網羅度** | `kpsewhich` に 20 個の代表ファイルを一括で渡し、返ったパスの basename で照合 |

網羅度は 3 段 + 2 状態: `full` / `recommended` / `minimal` / `broken`（core が欠け）/
`on-demand`（MiKTeX、または TeX64 が書き込める managed ツリー）。

代表ファイルは `PROBE_CORE`（article.cls, amsmath.sty, …）、`PROBE_RECOMMENDED`
（tikz, biblatex, unicode-math, luatexja, …）、`PROBE_FULL`（revtex4-2.cls,
IEEEtran.cls, ctex.sty＝scheme-full にしか入らない collection の目印）。
これで **BasicTeX / TinyTeX-0 のような薄い環境を「TeX はある」と誤判定しない**。

最終的に `recommendation.action` を返す:

- `use-existing` — そのまま使う（インストールボタンを出さない）
- `install` — TeX が無い / core が欠けている / latexmk・synctex が無い
- `expand` — TeX はあるがパッケージが薄い

## 3. インストールの 2 択

`INSTALL_VARIANTS`（`electron/services/env.cjs`）:

| variant | scheme | 追加パッケージ | 目安 |
| --- | --- | --- | --- |
| `light`（**既定・おすすめ**） | `scheme-infraonly` | `LIGHT_INSTALL_PACKAGES`（175 個） | 約 530 MB / 約 2 分 |
| `full` | `scheme-full` | collection-* 数点（scheme-full に含まれるので実質 no-op） | 約 5 GB / 30–60 分 |

`light` の内訳（`electron/services/tex-packages.cjs`）:

1. `TINYTEX_BASE_PACKAGES`（94）— TinyTeX の `pkgs-custom.txt` そのまま。
   4 エンジンで LaTeX が動く最低限。
2. `TEX64_ESSENTIAL_PACKAGES` — TeX64 の用途（数式・TikZ＝Pro canvas の出力先・
   文献・LuaTeX 日本語・beamer など）。
3. `KK_STYLESHEET_PACKAGES` — **`kkbookmaker/reference/styles/mainset-expl3tr.sty`
   の読み込み連鎖を全部**（jlreq / tabularray / luwa-ul / paracol / wrapfig2 /
   chemfig / modernruler / marginnote / needspace / varwidth / everyshi /
   bxcjkjatype / ifptex / pdfcol / makeindex …）＋その依存
   （ninecolors / functional / diagbox / pict2e / luacolor / lua-ul / simplekv）。
   `tlmgr search --file` で TL パッケージ名に解決済み。
   `kksymbols` / `kkluaverb` / `kkran` も CTAN パッケージなので含む。

**light の合格条件は「この本のスタイルが light だけでビルドできること」**。
リストを削るときはこの前提を壊さないこと。

- ツリーのレイアウト（TEXDIR/TEXMF*）は 2 択で完全に同一。よって **light → full の
  昇格は再インストールではなく `tlmgr install scheme-full`** で済む。
- どちらで入れたかは managed root の `tex64-install.json` に記録し、
  「フルパッケージを追加導入」ボタンの出し分けに使う。**記録が無いツリーは
  「不明」であって light ではない**（marker 導入以前の full かもしれないので、
  light 要求が既存の full ツリーを再インストール・再ラベルしないよう `variant: null`
  を返す）。
- リストは repository 側の改名・廃止で必ず陳腐化するので、`tlmgr install` は
  `allowFailure: true`。成否の判定は最後の `lualatex` / `latexmk` / `synctex` の
  検出で行う。
- TeX Live の**パッケージ名は LaTeX のパッケージ名と一致しない**ことがある
  （empheq は mathtools、subcaption は caption、tabularx は tools に同梱）。
  リストを変更したら `tlmgr install --dry-run` で名前解決を確認すること。

## 4. 足りないパッケージの自動取得（light を成立させる条件）

TinyTeX の `parse_packages()` に相当する処理:

1. ビルド失敗時、ログから欠けているファイル名を抽出（`extractMissingFiles`）。
   画像・`.bib`・`.tex` は「著者の問題」なので除外する。
2. `tlmgr search --global --file /foo.sty` で所有パッケージを引く
   （`collection-*` / `scheme-*` は除外＝数 GB の巻き添えを防ぐ）。
3. `tlmgr install` して再ビルド。**最大 5 ラウンド**繰り返す
   （パッケージは依存を引く: mdframed → zref → needspace。各ラウンドで見えるのは
   LaTeX が止まった 1 ファイルだけなので 1 回では足りない）。新規に入った
   パッケージが無くなったら打ち切る。

配線は `BuildService.setPackageInstaller()`（`electron/main.cjs` で `EnvService` に接続）。
`installMissingPackages()` は **managed tlmgr が無ければ即座に降りる**ので、
ユーザー自身の MacTeX / TinyTeX に書き込むことはない。

## 5. UI

Environment 画面は状態で 3 つに分岐する:

- **ready** — 検出した環境名とパスを 1 行で表示。system の場合は
  「この Mac に既にある TeX を検出しました。そのまま使います。」。ボタンなし。
  （managed かつ light のときだけ「フルパッケージを追加導入」を出す）
- **missing** — 2 枚のカード（**ライト＝おすすめ**（左）/ フル）。容量と所要時間を明記。
- **installing** — 既存の実 % プログレスバー。文言は variant で出し分け。

検出レポートが取れなかった場合は、従来の単一ボタンにフォールバックする。

## 6. 実測（2026-08-20、macOS arm64 / 実走）

| 項目 | 結果 |
| --- | --- |
| `scheme-infraonly` のベース導入 | 12.8 秒 |
| light 一式（175 → 依存解決後 218 パッケージ）導入 | **2 分 08 秒 / 531 MB** |
| 導入後の `detectEnvironment()` | `source: managed` / `ready: true` / `coverage: on-demand` / `managedVariant: light` |
| **`mainset-expl3tr.sty` の全読み込みを再現した文書のビルド** | **Build succeeded / 自動取得 0 件** |
| `\usepackage{mdframed}`（リスト外）のビルド | 3 ラウンドの自動取得を経て **Build succeeded** |

検証手順（再現可能）:

1. 使い捨ての root に light を実インストール。
2. `mainset-expl3tr.sty` とその `styles/*.sty` が読む CTAN パッケージを全部
   `\usepackage` する文書を実ビルド。
3. **合格条件は「自動取得 0 件」**。1 回目は 4 件（`kksymbols` / `luacode` /
   `zref` / `tikzfill`）取りこぼしていたので、それをリストに足して 0 件を確認した。
   ＝ 自動取得は保険であって、既知のスタイルは最初から入っている状態。

**全件監査（2026-08-20）**: `tlmgr info --data name`（TeX Live の全 8,103 パッケージ台帳）
と突き合わせ、light の 175 個・full の collection-* すべてが実在することを確認。
`KKsymbols` / `KKluaverb` / `KKran` も CTAN にある（`kksymbols` / `kkluaverb` / `kkran`）。

この監査が必要なのは、**`tlmgr install` は見つからない名前を黙って飛ばして先へ進む**ため
（`allowFailure: true` で回しているので終了コードも見ていない）。存在しない名前を
リストに混ぜても気づけず、あとで「なぜか .sty が無い」として表面化する。
そこで `parseUnavailablePackages()` で取得できなかった名前を拾い、
`installManagedTexlive()` の戻り値 `unavailable` と警告ログに出すようにした。
リストを変更したら、**`tlmgr install --dry-run` でも必ず名前解決を確認すること**。

## 7. 既知の残件

- 新規 UI 文字列は en / ja のみ（`uiText` の第 2 引数）。Environment 画面は元から
  zh / ko / fr / de / es の辞書エントリを持っておらず、部分翻訳になると画面内で
  言語が混ざるため、画面ごとまとめて多言語化するのが筋。
- `light` を選んだ場合の初回ビルドは、パッケージ取得のぶんだけ待ち時間が出る。
  現状ログに `[tex64] Installed missing package(s): …` を残すだけで、ビルド中の
  UI には「パッケージ取得中」を出していない。

## 8. テスト

- `tests/tex-env-detect.test.cjs` — banner 解析、kpsewhich 照合、所有者判定、
  網羅度の段階、推奨アクション。
- `tests/tex-install-variants.test.cjs` — variant 解決、profile の scheme 行、
  パッケージリスト、marker、ログ解析、tlmgr search 解析、managed 以外への書き込み拒否。
- `tests/build-package-repair.test.cjs` — 失敗 → インストール → 1 回だけ再ビルド、
  および「入れるものが無ければ再ビルドしない」「installer 未配線なら従来通り」。
