# TeX64 live preview — 2026-09-12 作業終了時点

## 結論

即時反映は未解決。残り利用枠22%で区切り、20%下限を守る。自動検査の成功を実機の成功と混同しない。

ユーザーの ch16.tex:33 の X はエディタ・ディスク・エンジンに届いていた。AX読み取りで一度Xなしと誤認したが、画像で訂正済み。旧inodeの開いたFDも今回の原因とは証明されていない。

## 修正と状態

アプリ: /Users/majinkuu/Desktop/TeX64-Pro

- HEAD 08de3a2。未コミット変更は Resources/web/pdf-viewer.js と .github/workflows/release.yml。
- 初期の少ないページ数で復帰先163を1に書き換えない。
- 通常PDFが後から読み込まれた場合にも復帰位置を保存する。
- 必要な入力revision、viewport token、実際のページ位置を確認して表示を切り替える。
- 316ページの冷間試験では物理163ページの保持と最終XY表示を画像確認済み。
- toolbar162はページ上端を表すため、163ページが実際に見えている場合はページ喪失と判定しない。

エンジン: /Users/majinkuu/Desktop/tdom-engine

- HEAD c47a4593d5f313df0ebc872a71ed2678574c81bc、commit/push済み。
- 初回canonicalの後に残る特定の表示要求に限り、60秒待ちを短縮する一回限りの許可を保持する。最初の実装4ee8497では遅れて届く強い表示要求を扱えず失敗。c47では要求の順序を再現するテストを追加し修正した。最終c47で316ページの冷間全行程は再実行していない。
- proofの700msとpublishの850msを組版完了後から数える。入力受理時刻は測定用に保持する。期限切れ先読みをそのまま失敗として使わず、新しい確認時間内で取得する。文書epoch、入力revision、anchor epoch、canonical世代、PDF/SyncTeX hashの検証は維持。
- source/publish期限を分離しても、最後の実機試験では確認処理自体がNO_SYNC_CANDIDATESで失敗した。

最終c47を同梱するパッケージは生成・照合済みだが、/Applications/TeX64.appは差し替えていない。
重要: 既存アプリのエンジン探索はDesktopのcheckoutを同梱版より優先する。実際のユーザー実行もこのcheckoutを使っていた。したがって次の起動時にはc47エンジン変更を参照しうる。「アプリ本体未更新」と「エンジンも従来版のまま」は同義ではない。checkoutは勝手にresetしていない。

## 最終実機結果

記録: /tmp/tex64-fixed-warm-final-kr0rpY

- 316ページのcanonicalを準備した後、ch16:33の既存iiiXにYを追加。カーソルを置いた後の6秒待ちはなし。
- inputAt 1789171367048。
- エディタ/コピーはiiiXY。PDF物理163ページは約38.5秒の観測中ずっとiiiX。
- 入力後53ms～37.172秒の画像と99-final.pngで未反映を確認。
- updateは入力後約1721ms。typesetMs1035.65、totalUs1290649、anchor pending acceptedElapsedMs1468.24。
- 約2406ms後にcanonical-anchor fallback、NO_SYNC_CANDIDATES、proofMs2163.61。
- 700msの確認時間を組版後に与えるだけでは、この取得処理の失敗を解決できなかった。単に「受理から700ms過ぎたから」と説明し直さない。

冷間・位置保持の記録: /tmp/tex64-fixed-cold-e2e2-DS1B1n

- 入力時canonical0、初回rev2/316は222089msで完成。
- 当時の待機短縮修正4ee8497は作動せず60秒待ちが残った。
- XYの最初の画像確認は入力後約338.7秒。物理163ページと編集箇所は保持されていた。
- その後のZは30秒内未表示。この失敗から受理時刻起点の期限切れを調べた。

## 検査

- 最終ツリー: schedulerの実際のdrain順序テスト、hot-path60/60、farm15/15・343/343行一致。
- exact SHA CI: https://github.com/Fermion-company/tdom-engine/actions/runs/34660001662 — 全段階成功。
- アプリweb build、構文、差分検査成功。
- 成功した検査の範囲は実画面の即時反映を保証しない。最終E2EはFAIL。

## 次の調査で必須

終了処理がengineのcanonical世代PDF/SyncTeXを削除する。今回、終了後にcanon-1.synctex.gzを調べようとしたが残っていなかった。

次回はエンジン終了前に、失敗したanchorのbase generationのPDFとSyncTeX、baseSnapshot.canonicalInputPath、sourceの行範囲、各SyncTeX照会の要求パス・時間・結果数・期限到達、paint取得の結果を保全する。追加の全文試行を行う前に、この採取処理を準備する。

コピーしたproject/main.synctex.gzはユーザー原本の通常ビルドのものなので、原本の/Usersパスを記録しているのが正常。このファイルだけを見て、エンジンcanonicalの/tmpと/private/tmpのalias不一致と断定してはいけない。現在はパス不一致か照会時間不足かを確定できていない。根拠なく700msを増やす修正は行っていない。

その後ユーザー操作で原本ch16.texは `iiiXY。` となり、SHA256
`8dd32fc9c4e6c181c6d83d6b8e1516bb4d5e6caca83b289fff2279214f7d32a8` を保持している。
以後のZ検証はコピーのみ。TeX64・エンジンの検証プロセスは終了済み。

## 追記: warm anchor 解決（engine b952d6d）

保持した実canonical世代を使う診断 `/tmp/tex64-anchor-preserve-lNrJYy`
で原因を確定した。SyncTeXの入力パスは正しく、lines 28–46 の19照会は
最終的に761候補を返し、page 163のpaint indexも114msで成功した。
受付時prefetchが700msで次の照会を止め、最初の8行だけをcacheしたため、
proof開始後に残り11行を取得して743.95msとなり、末尾3行が期限を
13–49ms超えたことが `NO_SYNC_CANDIDATES` の直接原因だった。

engine commit `b952d6d708de847c0b039c33347d1422a2dc009f` は、同じ不変
canonical世代のcache fillだけを既存の10秒warm期間まで継続し、proofで
利用するときは従来どおり組版後700msへ再制限する。文書・source・input・
anchor epoch、世代、PDF/SyncTeX hashのguardとpublish 850msは維持した。
deadlineで未取得のsparse arrayを完全な候補集合と誤認しない検査も追加した。

最終warm実機 `/tmp/tex64-anchor-fixed-final-98QHzG` はPASS。copy上の
`iiiXY。`へZを追加し、updateは入力後876ms（typeset 596ms）、certified
anchor readyは968ms、物理163ページに `iiiXYZ。` が表示された。
hot path 61/61、farm 15/15・343/343行一致。exact-SHA CI
`34682186575` は記載時点でfull test suiteまで成功し継続中。

この結果はcheckout engineと未配備app差分の検証であり、更新した
`/Applications/TeX64.app` の最終起動・表示確認はまだ行っていない。

## 追記: インストール版の最終確認

インストール版は app `7a415454e4e953f991e4f6dd4c0d2220e32a431d`、
engine `b952d6d708de847c0b039c33347d1422a2dc009f`。engineのexact-SHA CI
`34682186575` は全段階成功した。

実機記録 `/tmp/tex64-installed-final-nCc4V2` では、316ページの初回warmが
未完了の状態でcopyの `iiiXY。` にZを追加したため、最初の表示まで
23.225秒かかった。updateは入力後23.064秒、resident typesetは20.979秒、
25 blocks・26 pagesを再構築した。certified anchorはupdateの3ms後にreadyで、
この23秒はcanonical待ちやanchor proof失敗ではなく、編集位置のcheckpointが
まだwarmでなかったことによる。

その直後のWは約2.039秒でupdateし、typeset 1.057秒、2 blocks・1 page、
anchor readyはupdateの翌msだった。したがってb952のwarm anchor修正は
インストール版でも作動している。一方、初回warm未完了時には長い文書の
resident scan時間が残る。この制約は未解決として明示する。

この試験の `offset:0,target:305` はch16を開いた直後の先頭caret warmだった。
line 33へcaretを移してから17msで入力前記録、続いてZを入力しており、appの
160ms focus debounceより早かった。engineは新しいwarmを旧walkより優先し、
到達済み境界から再開するが、`offset:1191,target:309` の要求はZのupdate後に
到着したため同じ入力を速められなかった。追加のscheduler変更は行わない。

Wを保存した通常Buildは成功確認に至らなかった。17:37:25に更新されたcopyの
`main.pdf` と `main.synctex.gz` は、ユーザー原本側に以前からあった成果物と
SHA256がそれぞれ完全一致し、PDF 163は `iiiX。` のlast-goodだった。
`main.log` と `main.fls` は17:11:30の旧時刻のままで、新しいBuildのlogではない。
これは新しいPDFのpublish成功ではなく、staged output transactionが既存PDFと
SyncTeXを独立backupから復元した状態と一致する。したがって「2 passが完成して
旧sourceのPDFを成功publishした」「通常BuildがFAILした」とも断定しない。
実行はTDOMの全体canonical組版と重なっており、10分のBuild上限や開始前の待ちを
含む正確な停止理由は、消去済みstaging世代のtranscriptがなく未確定である。
追加試験は行わず、通常Buildの最終確認は未完了として区切る。

ユーザー原本の `iiiXY。` とSHA256
`8dd32fc9c4e6c181c6d83d6b8e1516bb4d5e6caca83b289fff2279214f7d32a8`
は変更していない。

## 追記: 「準備完了」判定の訂正（ローカル a9aff8b、未配備）

堅牢な実機記録 `/tmp/tex64-prepared-final-Z48YGG` では、通常Buildは9分23秒で
新しい316ページPDFを生成し、TDOM canonical rev2/id1も完成した。ch16 line 33の
exact resident warmが`ready`になった後、copyの `iiiXY。` にZを追加したが、30秒内に
表示されなかった。updateは入力後2.907秒、resident typesetは2.317秒、anchorは
3.601秒で `NO_SYNC_CANDIDATES` にfallbackした。Wは入力していない。SSEは入力前に
HTTP 200接続済みで50 event、100ms状態記録、毎秒画像、最終`/doc`とDOMを保存した。

終了前に正しいbase canonical id1を二重保全した。PDF SHA256は
`29da2355dfaeba16148951961a67c91f8cf29dbe99f27805390c34a8e7292dde`、SyncTeXは
`2ee1604d8bb3c4b222618125c5a1411dfab709fec2fd3e35deef00448d75920b`。
SyncTeXのch16 Inputは実際のcopy pathと一致し、path alias不一致ではなかった。
対象block b333のlines 28–46を同じ成果へ8並列で直接照会すると、全19行が候補を返したが、
各照会1.766–3.891秒、全体8.567秒だった。warm `ready`から入力まで約1.07秒、入力後の
resident/plan約2.66秒とproof 700msを合わせてもprefetch完了には足りない。
したがってb952はresident checkpointだけを`ready`と表示し、canonical proof入力が
未完のままだった。これは高速化の失敗とは別に、「準備完了」という状態表示の誤りである。

engine commit `a9aff8b8689c55415e7142acc02729ec15e154b1` は、resident準備後を`proofing`とし、同じ
source/target/file/offset、document/anchor epoch、現在canonical id/revとPDF/SyncTeX
certificateのまま全候補とpaintが揃った場合だけ`ready`へ進める。期限切れ、非対応、
identity失効は具体的な`proof-unavailable`で終了し、次のwarm要求が旧結果で上書きされない。
証明条件、proof 700ms、publish 850msは緩和していない。hot-path 62/62、farm 15/15・
343/343行一致、静的検査は成功した。

修正後の実機 `/tmp/tex64-proofready-final-mrxpsz` は、canonical id1/rev2 currentと
同じid/sourceRev2/target309/offset1191/exact fileのwarm `ready`を確認してから入力した。
copy上の `iiiXYZ。` へのWは1.819秒、続けたVは2.335秒で物理163ページへ表示され、
最終画像とrendered textの両方で `iiiXYZWV。` を確認した。後続source revのwarmは
`proof-unavailable`となったが、W/Vの表示はその前に完了している。この結果は準備済みと
表示した状態の意味を実機で確認したもので、組版自体を高速化したという主張ではない。

commitはbranchへpush済み。exact SHA `a9aff8b8689c55415e7142acc02729ec15e154b1` の
audit CIは https://github.com/Fermion-company/tdom-engine/actions/runs/34727263270 で
full suite、bounded checkpoint、farm、fuzzを含む全段階に成功した。
アプリへのpin更新・配備はまだ行っていない。

アプリ側のBuild中last-good PDF表示・更新中UIは16 fileの未配備差分であり、このengine
修正と同時に実機確認していない。永続cacheは
`/Users/majinkuu/Desktop/tex64-preview-cache-design.md` の設計だけで、実装していない。
ユーザー原本は `iiiXY。`、SHA256
`8dd32fc9c4e6c181c6d83d6b8e1516bb4d5e6caca83b289fff2279214f7d32a8` のままである。

## 追記: proof-ready 実機確定と静的last-good cache実装

engine `a9aff8b8689c55415e7142acc02729ec15e154b1` はbranchへpush済みで、
exact-SHA audit CI `34727263270` はfull suite、bounded checkpoint、farm、fuzzを
含む全段階に成功した。316ページの実機 `/tmp/tex64-proofready-final-mrxpsz` では、
canonical id1/rev2 current、warmのcanonicalId1/sourceRev2/target309/offset1191/exact file
が一致したproof-readyを確認してから入力し、Wは1.819秒、続くVは2.335秒で物理163ページへ
表示された。最終画像とrendered textの両方で `iiiXYZWV。` を確認している。この修正は
「準備完了」の証明条件を正したもので、組版処理そのものの高速化ではない。

アプリ側のBuild中last-good PDF表示・更新中UIは
`9b92f6cc6fa87bc94b035f40ba9977c54df02548`、engine pin更新は
`73e194d` に入った。これらはソース上の状態で、ここに記載した時点では最終配備確認前である。

静的last-good cacheの保存・検証は
`134a1699c81a7c621f5a6efbe3756154847d46cc` に実装した。Buildが新PDFをcommitした後、
PDF、同じBuildで更新されたSyncTeX、対象補助ファイルを
`.tex64/cache/live-preview/` 下の世代へ保存する。補助ファイル走査は非同期かつ62 files/
10,000 directoriesに制限し、保存失敗はBuild成功を失敗へ変えない。保存物は固定名とhash、
manifest/pointerで毎回再検証し、PDF headerもsave/loadの両方で確認する。短いfile writeも
全byteを書き切るまで処理する。module harnessは133/133、Build統合harnessは3/3、構文検査と
diff checkも成功した。

現在のBuild callerはimmutable input snapshotを取得していないため、保存世代は必ず
`static-last-good` である。canonical currentやresident readinessを認定せず、Build省略や
canonical seedへのimportも行わない。cacheとBuild中UIを組み合わせた実画面確認、および
最終配備はこの時点では未完了である。

組合せ実機 `/tmp/tex64-small-cache-final2-nwNKnz` はPASS。既存PDFを表示したままの
Updating表示はBuild Aで897ms、成功するBuild Bは3.505秒で完了した。成功後は4 artifacts、
合計6,625 bytesのgeneration `e7cc…` をloadでき、`candidateClass` は
`static-last-good`、blockerは `input-proof-absent`、canonical currentとresident readinessの
validationはいずれもfalseだった。続く意図的なBuild failureでも既存PDFを表示したまま
Updatingへ77msで遷移し、cache generation、pointer、PDF hashはすべて不変だった。
検証後のapp/engine processは0で、ユーザー原本hashも不変である。packagingと最終配備確認は
引き続き未完了である。

## 追記: 50ケース要求と通常Buildの600秒timeout

ユーザーから、copy上の50ケース実機確認、Claude Opus 5とChrome上のProモデルによる検討、
および通常Build結果をLive previewへ再利用する案の検証が追加で依頼された。Claude Opus 5の
xhigh作業はsession limitに達し、結果を生成していない。Chrome側はPro利用が無効で、利用可能な
最新Extremeモデルについてユーザーの操作待ちである。Chromeへのprompt送信や成果の採用は
行っていない。

50ケース本体を始める前のbaselineは
`/tmp/tex64-50case-baseline-djdY4D` に保存した。Build開始eventは
`1789261817418`、failure eventは`1789262418088`で、差は正確に600.670秒だった。
表示結果は `Build timed out before completion. No new PDF was published.` であり、固定600秒の
通常Build上限を実経路で再現した。このbaselineでは編集ケースを実行しておらず、結果は0/50で
ある。50件すべてのcopy-only実行経路を持つrunnerとmatrixは
`/tmp/tex64-50case-e2e` に準備済みだが、修正版の検証開始までは未実行とする。

通常BuildとTDOMの重いLuaLaTeX処理を直列化するapp側修正は
`c6a217694caef96922f80e7a4f3b0e6759539589` にcommit済みである。cold start、文書open、
canonical/bootstrapをBuild leaseの後ろへ置き、ready済み同一文書のresident editは継続する。
engine busyは同じrequest IDで再試行し、cancel・failureを含む全経路でleaseを解放する。このapp
commitはまだpackaging・インストールしていない。対応するengine lease実装、partial auxの扱い、
focused/native確認も未完了であるため、現時点では通常Buildとの資源排他を実機で確定していない。

成功した通常Build成果をTDOMへ取り込む機能も未実装である。採用可能な範囲は、同一の既存
canonical trust contractに照らしてBuild結果のidentityが一致すると証明できる場合に限る。
これはimmutable inputを独立runnerで再構成したことを示す、より強いhermetic証明ではない。
identityやauthority readinessを確認せずにPDF・aux・cacheをcanonical currentとして扱う
実装や、テスト上だけ成功扱いにする代替は採用していない。

## 追記: Build成果採用・SyncTeX一括照会と904bf0c配布準備

アプリ `addbe5ef8d8df94ef8b0ebc6465819301aa776ac` は、通常BuildとTDOMの重い処理を
Build leaseで直列化し、成功BuildのPDF・SyncTeX・FLS・root auxとproject入力hashを
immutable cache世代へ保存する。同じアプリ実行中のfresh候補に限り、現在の
workspace/document/source/input epoch、lease identity、LuaLaTeX profile、PDF producer、
成果hash、SyncTeX Input mapをTDOMが再検証してcanonical generationへ採用する。
既存residentとidentityが一致する場合は`/canonical/build-import`、cold openでは候補付き
`/open`を使う。採用拒否は通常Build成功を取り消さず、ディスクcacheは再起動後も
`static-last-good`に留める。TeX toolchain/config fingerprintと完全なimmutable input証明、
永続authority/readiness復元は未実装である。

small fixtureと316ページcopyでfresh Buildの採用経路を確認した。316ページの50ケース実機は
完了していない。現在のrunner記録ではC01の`E01`追加を543ms、C03の`参考情報`から`根拠情報`への
置換を743msで検出した。C01は保存画像でも`E01`を確認した。C03の同時点スクリーンショットは
timeoutで保存されず、最も近い後続画像では`根拠情報`を確認したため、743msを独立したpixel
latencyとしては確定しない。C02の`E01`削除はMonaco modelとsource revisionが正しく進み、
保存画像のVision OCRでもPDF領域から`E01`が消えたことを確認したが、runnerが非表示DOMの
`innerText`残骸を読んで30秒待ったため、削除の実表示速度は測定できていない。C04のUndoは
保存画像で`根拠情報`が残り、別の未解決結果である。50件を完了した、またはC02を30秒の
速度失敗とする記録はしない。

TDOM `904bf0c0b9c2571ad335088b8734b2fe2cce4f93` は、同じcanonical世代の複数行
forward SyncTeX照会を、vendored公式MIT parserで一度だけ解析するbounded helperへまとめた。
全行group・record数・有限座標・path mapが完全な場合だけ既存の座標変換へ渡し、compiler/zlib
不在、process失敗、期限超過、不正・欠損JSONでは既存CLIへ戻る。316ページの保存成果で
19行761 recordsの7 fieldがCLIと一致した。focused test 3/3とexact-SHA audit CI
`34734566768` は成功した。prototypeの約1.98秒とproduction helperの計測はcompile/cache条件が
異なるため、最終的な高速化値は同一条件で再測定するまで確定しない。

TeX64のrelease pinは`904bf0c0b9c2571ad335088b8734b2fe2cce4f93`へ更新し、公式
`npm run tdom:sync`で`Resources/tdom-engine/VENDOR.json`も同じSHAへ同期した。新helperが使う
`vendor/synctex`とMIT Licenseも同期対象へ追加した。ここではpack、`/Applications`差替え、
installed確認を行っていない。50ケースの残りと最終確認後に、既存のローカル配備承認に基づいて
配備する。
