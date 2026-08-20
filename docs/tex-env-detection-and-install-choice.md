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

## 5. 初回起動（オンボーディング）

`web-src/app/onboarding-ui.ts` + `#onboarding`。**TeX が無いときだけ**出るゲートで、
launcher より上（z-index 30）に出て `body.has-onboarding` で下を隠す。

1. **TeX がある** → ゲートは出ない。そのまま launcher / エディタ。
2. **無い** → 2 択カード（ライト＝おすすめ / フル）。**容量と所要時間は必ず併記**。
3. **導入中** → ゲージ（％）＋残り時間＋フェーズ（`パッケージを導入中… (120/218)`）。
4. **完了** → ゲートが自分で閉じてエディタが出る。クリック不要。

失敗したら文言を出して 2 択に戻す。「あとで」は localStorage に記録して二度と聞かない
（Environment 画面からいつでも入れる）。

### 残り時間の出し方

進捗バーは**時間に対して線形ではない**。light は install-tl（バー 0→80%）が約 15 秒、
パッケージ導入（80→98%）が約 95 秒で、full は逆に scheme-full のダウンロードが大半を占める。
そのため `経過 ÷ ％` で外挿すると「80% で残り 10 秒」と嘘をつく。

`timeFractionForPercent(percent, variant)` でバー％を**経過時間の割合**に写してから
`経過 ÷ 割合` で総所要を推定する。推定は指数平滑（下げ 0.5 / 上げ 0.15）で、
**上がることも許す**（参照機より遅い環境では上がるのが真実。単調減少に固定すると
「まもなく完了」で止まったまま延々待たせることになる）。

## 6. UI

Environment 画面は状態で 3 つに分岐する:

- **ready** — 検出した環境名とパスを 1 行で表示。system の場合は
  「この Mac に既にある TeX を検出しました。そのまま使います。」。ボタンなし。
  （managed かつ light のときだけ「フルパッケージを追加導入」を出す）
- **missing** — 2 枚のカード（**ライト＝おすすめ**（左）/ フル）。容量と所要時間を明記。
- **installing** — 既存の実 % プログレスバー。文言は variant で出し分け。

検出レポートが取れなかった場合は、従来の単一ボタンにフォールバックする。

## 6.5 パッケージ管理（Packages 画面）

`electron/services/tex-package-manager.cjs` + `web-src/app/settings-packages-ui.ts`。

### 何ができるか

| 操作 | 実装 | 備考 |
| --- | --- | --- |
| 一覧・検索 | `tlmgr info --data name,installed,size,shortdesc` | **ローカル DB・ネット不要**。8,103 件を 1 回読んでクライアント側で絞る |
| ファイル名で検索 | `tlmgr search --file` | 約 1 秒。名前・説明の即時結果の**後ろに追加** |
| CTAN を直接検索 | `tlmgr search --global` | 約 4 秒・ネット。カタログに無い新しいものを探す逃げ道 |
| 中身を見る | `tlmgr info --list` | 行を開くと収録ファイル一覧 |
| 追加 | `tlmgr install` | |
| 削除 | `tlmgr remove`（`--dry-run` 前置） | 拒否理由をそのまま提示 |
| 一括更新 | `tlmgr update --self --all` | ボタン 1 つ |

### UI の決定事項（ユーザー確認済み 2026-08-20）

- **1 つのリストに統合**。導入済み/未導入は、緑のドット・名前の濃さ・ボタンの形
  （塗り＝導入 / 枠線＝削除）で**ラベルを読まずに分かる**ようにする。
  上部にフィルタチップ（すべて / 導入済み / 未導入）＋件数。
- **即時検索 + 「CTAN を直接検索」の併用**。普段は待ち時間ゼロ、
  見つからないときだけネットを叩く。
- ランクは 完全一致 > 前方一致（短い名前優先） > 部分一致 > 説明一致。
  表示は 120 件で打ち切り、「N 件中 M 件を表示中」と明示する。

### system TeX への書き込み（方針変更）

managed ツリーは無認証。**system TeX（MacTeX 等）も操作可能**にしたが、
`osascript ... with administrator privileges` で **macOS の認証ダイアログ**を出す。
アプリがパスワードに触れることはない。

パッケージ名は `isValidPackageName()`（`^[A-Za-z0-9][A-Za-z0-9._+-]*$`）を通さないと
コマンドラインに載らない。`buildPrivilegedScript()` は shell と AppleScript の
二重クォートを行い、**実際に osascript を通して往復するテスト**で
`$VAR` / バッククォート / セミコロン / 引用符がすべてリテラルとして届くことを確認している。

### 実測（2026-08-20、使い捨て managed ツリー）

```
catalogue: 4,916 件（arch 別バイナリを除外後）/ installed: 197
install tikz-cd        -> ok、ファイル検索でも引ける
remove pgf             -> 拒否。理由「beamer が必要としている」を提示
remove tikz-cd         -> ok、カタログに反映
update --self --all    -> ok
```

## 7. 実測（2026-08-20、macOS arm64 / 実走）

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

## 8. 既知の残件

- 新規 UI 文字列は en / ja のみ（`uiText` の第 2 引数）。Environment 画面は元から
  zh / ko / fr / de / es の辞書エントリを持っておらず、部分翻訳になると画面内で
  言語が混ざるため、画面ごとまとめて多言語化するのが筋。
- `light` を選んだ場合の初回ビルドは、パッケージ取得のぶんだけ待ち時間が出る。
  現状ログに `[tex64] Installed missing package(s): …` を残すだけで、ビルド中の
  UI には「パッケージ取得中」を出していない。

## 9. テスト

- `tests/tex-env-detect.test.cjs` — banner 解析、kpsewhich 照合、所有者判定、
  網羅度の段階、推奨アクション。
- `tests/tex-install-variants.test.cjs` — variant 解決、profile の scheme 行、
  パッケージリスト、marker、ログ解析、tlmgr search 解析、managed 以外への書き込み拒否。
- `tests/build-package-repair.test.cjs` — 失敗 → インストール → 再ビルド（依存連鎖を
  複数ラウンド）、および「入れるものが無ければ再ビルドしない」「ループが有界」
  「installer 未配線なら従来通り」。
- `tests/onboarding-eta.test.mjs` — 時間曲線、遅い環境で推定が伸びること、
  バーが巻き戻らないこと、残り時間の文言。
- `tests/tex-package-manager.test.cjs` — カタログ CSV 解析、ファイル検索、削除拒否の
  解析、**パッケージ名の検証**（`pgf; rm -rf /` 等を全て拒否）、
  特権コマンドのクォート（実 osascript 往復）。
- `tests/settings-packages-ui.test.mjs` — 検索ランク、フィルタ、件数、容量表記。
- `tests/e2e/packages-flow.test.cjs` — 実 tlmgr カタログ（5,000 件超）に対して実走。
  検索・フィルタ・ファイル名検索・行展開・CTAN 検索。**破壊的操作は押さない**
  （実 TeX を変更してしまうため、ラベルと有効性の確認に留める）。
- `tests/e2e/onboarding-flow.test.cjs` — 実 Electron でゲートを実走。
  「TeX があれば出ない」「無ければ 2 択＋容量が必ず出る」「ゲージと残り時間」
  「完了で勝手に閉じてエディタが出る」「失敗したら 2 択に戻る」「あとでが効く」。
  **この e2e が配線バグを 2 件検出した**（`handleEnvInstallProgress` が bridge に
  繋がっておらず設定画面の進捗バーが最初から死んでいた／`handleEnvDetectResult` も同様）。
