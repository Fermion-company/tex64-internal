# TeX64 Build成果・ライブプレビューcache設計

作成日: 2026-09-12  
更新日: 2026-09-13  
状態: 第1段階の既存PDF表示UIと成功Buildの静的成果cache captureは実装・配備済み。同一アプリ実行中のfresh Buildを既存canonical trust contractで採用する第2段階はsource実装・実機確認済みだが未配備。完全なhermetic input証明と、永続cacheからのauthority・ライブ準備状態の復元は未実装。

配備確認: TeX64 source `134a1699c81a7c621f5a6efbe3756154847d46cc`、TDOM engine `a9aff8b8689c55415e7142acc02729ec15e154b1`、installed `app.asar` SHA-256 `fce897361d6c818b1b5a6365eb1df083ee22e0581c6036f1d7e2304a0f332f1d`。実機で旧PDFの即時表示、成功時の差し替え、失敗時のlast-good保持、失敗時のcache generation・pointer不変を確認済み。

## 目的

通常Buildが成功した時点では、正しいPDFだけでなくSyncTeX、aux、tocなどの
組版成果も揃っている。これらをTDOMのcanonical正本として安全に取り込み、
同じ入力に対するTDOM側の全体LuaLaTeXを重複実行しない。さらに、検証可能な
成果だけをプロジェクト内の隠しcacheへ保存し、次回起動で再利用する。

このcacheはresident checkpointの保存ではない。PDFを復元できても、最初の
編集を局所組版するresident LuaLaTeXとカーソル周辺checkpointは別途起動・warm
する必要がある。

## 現在すでにある成果保護

通常Buildは既存PDFを消さず、`.tex64-build-*` の一時出力へ組版する。成功時だけ
新しいPDFとSyncTeXを同じ最終パスへ移し、失敗・中止・timeout時はlast-goodを
独立backupから復元する。

Build開始直後から既存PDFを表示して「更新中」を示し、成功後に同じタブで新PDFへ
差し替え、失敗時はlast-good PDFと明確な失敗表示を維持するUIは実装・配備済みである。
これは表示の継続であってライブ編集準備のcache復元ではない。また、成功BuildのPDF、
SyncTeX、許可したaux familyをhash付き静的成果として `.tex64/cache/live-preview/` へ保存する
処理も実装済みである。ディスクへ保存した成果は完全なimmutable input proofとtoolchain
fingerprintを持たないため、再起動後は`static-last-good`でありcanonical authorityには昇格しない。
同じアプリ実行中のmemory上のfresh候補だけは、第2段階の限定契約で採用できる。現在のTDOMは
canonical generationを最大4世代だけメモリ保持し、SVG、本文、bbox、pdf.js paint、
SyncTeX照会をメモリcacheする。`tdom-work` のcanonical PDF/SyncTeXは文書resetや
終了時に削除され、次回起動へは引き継がれない。

## 再利用できる情報とできない情報

通常Buildから安全に保存できる情報は次のとおり。

- PDFとSyncTeX。PDFはその入力snapshotの物理ページ正本、SyncTeXはソース行と
  物理ページ座標の対応に使う。
- aux、toc、lof、lot、out、bbl、bcf、run.xmlなどの収束済み補助情報。TDOMの
  次回canonicalとshipping baselineのseedに使える。
- 全ページgeometry、PDF/SyncTeXのSHA-256、ページ数。
- `.fls` と `.fdb_latexmk` から得た入力一覧と各入力のSHA-256。プロジェクト内の
  `.tex`、`.sty`、`.bib`、画像だけでなく、プロジェクト外ファイル、TeX package、
  class、font、format、外部ツールが読んだ入力も対象にする。
- LuaLaTeX実体、版、組版結果へ影響する引数・検索path・設定のschema。

ただし、Build終了後に`.fls`を読んで現在のfileをhashするだけでは、そのBuildが読んだ
bytesを証明できない。組版中に入力が変更されて元へ戻った場合や、`\directlua`、
shell escape、外部commandが`.fls`へ記録せずに読んだ入力を捕捉できないためである。
authority cacheには、コンパイラが実際に読む全入力を開始時にimmutable snapshotへ固定し、
そのsnapshotのhashをmanifestへ記録する方式を原則とする。代替のversion watchを使うなら、
入力のopen・変更・renameをBuild全期間にわたり欠落なく観測し、開始時と終了時のhashと
結び付けられるatomic inputs契約が必要である。単なるproject全体のmtime、個別fileのmtime、
sizeは診断情報に限り、同一性の証明には使わない。

時刻、乱数、network、環境依存状態、列挙不能な`\directlua`/shell commandから結果を作る
Buildは初版のauthority対象外とする。これらを許可するprofileを将来設ける場合も、固定時刻や
seed、実行環境、command、読取入力、生成物をすべて再現可能な契約としてmanifest化できる
場合に限る。入力を完全に列挙・固定・再現できない成果は静的last-good PDFとしてだけ扱う。

保存してもresidentへ復元できない情報は次のとおり。

- checkpointのPID、socket、fork済みLuaTeX heap。
- TeX node pointer、daemon capture ID、process-local font ID、JOBの継続状態。
- galley JSONだけを取り出した状態。高速編集には、そのgalleyを生んだ正確な
  TeX exit stateを持つ生存checkpointが必要である。
- shipping chainの生存process tree。aux seedから再起動はできるが、そのtree自体は
  毎回作り直す。

## 三段階の実装

### 第1段階: 既存PDFの即時表示

既存のstaged output transactionによる成果保護を土台に、配備済みのUIとして、Build
押下後もlast-good PDFを即時表示する。表示には「更新中」を付け、成功時だけ新PDFへ
原子的に差し替える。失敗・中止時はlast-goodを維持し、成功と表示しない。

この段階はTDOMの準備状態を変更しない。旧PDFが見えていることと、residentが
編集位置でwarm済みであることを別の状態として扱う。

### 第2段階: 今回成功したBuildをcanonical seedへ取り込む

Build開始前に、main processが起動中のTDOMへ外部Build leaseを要求する。leaseは
次を含む一回限りのtokenとする。

- document epoch、source revision、canonical input epoch
- projectの実realpath、root `.tex` の相対path
- TDOMが現在読んでいるroot bytesとoverlay/input snapshotの識別子
- 発行時刻、有効期限、乱数ID

lease中はTDOMのresident chainとcaret warmを止めない。TDOMのcanonical authority
だけを保留する。未開始timerは保持し、実行中のbackground canonical childは既存の
安全な停止機構で一時停止する。leaseには10分などの上限とwatchdogを持たせ、Build
失敗、中止、timeout、HTTP失敗、アプリ終了では必ず再開し、保持していたcanonical
jobを再armする。

通常Buildは、authority importを要求する場合には固定したsource snapshotからstagingへ
出力する。既存方式のように変化可能なproject fileを直接読むBuildは、全期間を保証する
version watch/atomic inputs契約がない限り静的PDFに留める。成功判定後、staging削除前に
次を採取する。

1. PDF、SyncTeX、aux familyのbytesとSHA-256。
2. `.fls` と `.fdb_latexmk` の全入力。BibTeX/Biber等が読む入力も含める。
3. 各入力のrealpath、project内なら相対path、immutable snapshot内の識別子とSHA-256。
   sizeとmtimeは診断用に記録してもauthority判定には使わない。
4. snapshot外の入力、Build開始後に変化した入力、監視不能な入力が一つでもあればimportを
   拒否する。Buildが生成するstaging内aux等だけをprofileで明示した例外にする。
5. 実際に使ったLuaLaTeX binaryのrealpath・SHA-256・version、結果へ影響するargv、
   TEXINPUTS等の検索設定。初版はTDOMのcanonical契約と一致するLuaLaTeX構成だけを
   import対象にする。XeLaTeX、pdfLaTeX、upLaTeX、意味を変える独自引数は静的PDF
   としてのみ扱う。

Build成功後、main processはTDOMのpush queueを先にdrainし、保存されたbufferが
TDOMにも受理済みであることを確認してからlease tokenと成果をcommitする。TDOMは
次をすべて再確認する。

- tokenのdocument/source/input epochが現在値と一致する。
- project/root、Build target、実行profileが一致する。
- activeな未保存overlayがなく、rootと全Build入力のbytes/hashがmanifestと一致する。
- manifestの各入力が、Buildに与えたimmutable snapshotまたは欠落のないatomic inputs契約へ
  結び付いている。`.fls`に列挙されたという事実だけでは成立させない。
- PDF/SyncTeX/auxのhash、PDF header、ページ数、geometryが成立する。
- SyncTeXのInput記録とmanifestの入力path対応が一意である。

成立した場合だけ、`CanonicalRenderer` に外部generationをcommitする。source revision
自体は増やさず、現在revisionの正本としてgeneration IDを増やす。PDFとSyncTeXは
TDOM workdirへ世代別のimmutable fileとしてcopyし、既存の最大4世代、reader、LRU、
hash certificate、paint prewarmをそのまま使う。matching pending canonical jobは
consumeし、errorとdisplay demandを整合させ、既存`onResult`からcanonical SSEを出す。

通常BuildのSyncTeXはrootを`main.tex`、子をproject上のpathとして記録する。一方、
TDOM自身のcanonicalはrootを`canon.tex`、保存overlayをoverlay pathとして記録する。
したがって単純なPDF/SyncTeX copyではrootや保存直後の子ファイル照会が0件になり得る。
各generationに「logical project path → そのSyncTeXに記録されたInput path」のmapを
保持し、forward照会はgeneration IDに対応する記録pathを使う。reverse照会結果は
逆mapで現在project pathへ戻す。path文字列を書き換えたSyncTeXをauthorityにはしない。

source版には外部generationのprepare/commit、Build leaseのacquire/renew/release、warm resident向け
`/canonical/build-import`とcold open向け候補付き`/open`、generation別SyncTeX path mapを実装した。
アプリはstaging cleanup前にPDF・SyncTeX・FLS・root auxをimmutable cache世代へ保存し、FLSの
project INPUTからOUTPUTを除いた全regular fileのhashを候補へ入れる。TDOMはlease identity、
現在のeffective bytes、profile、PDF producer、成果hashとSyncTeX Input対応を再検証し、拒否時は
既存canonicalを変更しない。Build成功の通知とPDF表示は採用完了を待たず、背景採用がleaseを
最後まで所有する。次のBuild/Cleanは前の採用完了を待ち、その待機中のStopも組版開始前に効く。

この実装が証明するのは同一アプリ実行中のfresh候補と、その時点でTDOMが持つ入力identityの一致で
ある。Buildが全入力をimmutable snapshotから読んだことや、組版中に入力が変更されて元へ戻った
履歴までは証明しない。したがって上記のより強いhermetic方式を実装済みとは扱わず、ディスクに
保存した候補を次回プロセスのcanonical authorityとして採用しない。

### 第3段階: 隠しcacheからの永続復元

保存層と検証層、および通常Build成功後の成果captureまでは実装済みである。同一アプリ実行中は
memory上のfresh候補を第2段階の限定契約で採用できるが、diskから再読込した候補は
`static-last-good` に固定する。cacheを読み出して通常PDFビューアへ復元する配線、次回プロセスの
TDOMへcanonical authorityとして取り込む配線、resident engineやカーソル周辺checkpointを
準備済みとして復元する配線は未実装である。

成功して第2段階の検証を通った成果だけを、project内の
`.tex64/cache/live-preview/<main-key>/` に保存する。`.tex64` は現在もworkspace表示と
Build source stagingの除外対象である。cache内にはTeXが誤って検索し得る一般的な
`.tex`/`.sty` 名を置かず、固定名またはhash名を使う。

一世代を一時directoryへ完全に書き、file fsync、manifest fsync、directory fsync後に
renameして公開する。symlinkとproject外realpathを拒否する。世代数と総容量を制限し、
新しい1～2世代を残す。manifestにはschema versionを必須とし、不明schema、欠損、
hash不一致は破損として扱う。

次回起動では、PDFの存在だけでcanonical currentとは判定しない。

- 全入力hash、LuaLaTeX/profile/schema、root、SyncTeX mapが一致する場合だけ、`/open`
  と同じdocument epochへseedを渡し、最初のcanonical debounceが発火する前にimportする。
- 一つでも不一致ならTDOM authority、SyncTeX anchor、shipping aux seedへ使わない。
- 不一致PDFはlast-good静的表示には使えるが、「ライブ準備済み」と表示しない。
- `.tex`、`.bib`、class/style、画像、font、TeX distribution、engine option、root変更で
  cacheを無効化する。外部入力を列挙できないBuildもauthority cacheにしない。
- 時刻・乱数・network・外部commandなどprofile契約外の動的入力を使ったBuildは、終了時の
  file hashが偶然一致してもauthority cacheへ昇格しない。

全入力が完全一致するcacheでは技術的に通常Buildを省略できる。しかし初版はBuild
ボタンの意味を変えず、ユーザーが押したBuildを実行して、その成功成果をTDOMへ渡す。
Build省略は、cache hitの説明と明示的な製品仕様を別途決めた後の段階とする。

## 失敗時の原則

- import検証失敗はBuild成功を取り消さない。新PDFは通常ビューアで表示し、TDOMは
  自前canonicalを再開する。
- Build失敗は旧PDFを維持し、cacheとcanonical generationを更新しない。
- lease commitが曖昧な場合は同じtokenで冪等に確認する。別tokenで推測再実行しない。
- 外部generationは現在sourceのexport authorityにできる条件を満たした場合だけ
  `sourceMatches`を成立させる。旧世代として保持する場合も、新sourceをcurrentと
  偽らない。
- persistent cacheは任意の高速化であり、読めない場合も通常BuildとTDOM canonicalへ
  fail closedする。

## 検証計画

### 第1段階

- 既存PDFありでBuild開始直後に同じページ・scroll位置が表示され、「更新中」になる。
- 成功時だけ新PDFへ差し替わる。
- syntax error、中止、timeoutではlast-goodが残り、成功表示にならない。

### 第2段階

- 同じsourceの成功Build後、TDOM canonical IDがimport世代へ進み、PDF/SyncTeX hashが
  Build成果と一致する。
- lease中にTDOM canonical LuaLaTeXが重複実行されず、resident open/warmは進む。
- import後のroot/child forward・reverse SyncTeX、page geometry、paint proof、shipping
  seedが同じgenerationを使う。
- source edit、overlay、external input、epoch、root、engine profile、PDF、SyncTeXの
  いずれかを一つ変える試験でimportを拒否し、canonicalを再開する。
- Build中に入力を変更して元のbytes/mtimeへ戻す試験でも、snapshot方式ではBuildが固定入力を
  使い、version watch方式ではimportが拒否される。project mtime一致で通過しない。
- 未宣言の`\directlua`読取、shell command、時刻、乱数、network依存を含むprofileは静的
  last-goodに留まり、canonical authorityへimportされない。
- Build失敗、中止、timeout、engine再起動、通信断でleaseが必ず解放される。
- 長文書の実機で、通常Build成功から最初の編集までに重複full canonical processが
  なく、warm済み位置の編集がimportした物理ページ上へ安全に反映される。

### 第3段階

- アプリ終了・再起動後、全入力一致cacheだけがcanonical seedになる。
- `.tex`、`.bib`、画像、project外style、system package/font、LuaLaTeX binary、引数を
  一つずつ変えるとcache missになる。
- project移動時はlogical path mapで照会できるか、対応不能なら安全にmissになる。
- manifest/PDF/SyncTeXの切断、改変、symlink、古いschemaを拒否する。
- 世代数・容量上限、atomic rename途中のcrash、cache削除後の通常fallbackを確認する。
- cache hit後もresident checkpointがreadyになる前の編集は遅くなり得ることをUIと
  statusで区別し、PDF cache hitだけを高速編集readyとして扱わない。

## 実装範囲の目安

第1段階と、同一アプリ実行中に限定した第2段階のBuild lease・fresh generation採用は実装済みで
ある。small fixtureと316ページcopyで採用を確認したが、50ケース全体は未完了であり、削除後の
実ピクセル正しさと速度の判定を分けて再集計する必要がある。第3段階の永続authority、TeX
binary/version/config fingerprint、完全なimmutable input provenance、再起動後のreadiness復元は
未実装である。
