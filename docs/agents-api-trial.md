# Agents API 開発試用

Code内AxiomとデスクトップAIモードの共通run-loopから、OpenAI管理のCodex実行基盤を呼ぶ。
通常起動と配布版の既定経路は変更しない。Web単体の文書APIは対象外。

```sh
npm run dev:agents
```

起動スクリプトはGit対象外の `services/tex64-ai/.env.local` の `OPENAI_API_KEY` を読む。
環境変数 `TEX64_AGENTS_API_KEY` で上書きできる。キーには `api.agents.read`、
`api.agents.write`、`api.responses.write` が必要。モデルは標準Axiomのソース既定値と同じ
`gpt-5.6-luna`。変更する場合は `TEX64_AGENTS_MODEL` を指定する。キーはElectron mainでのみ使い、
設定ファイル・レンダラー・TeX64プラットフォームへのリクエストには渡さない。

`TEX64_AGENT_RUNTIME=agents-api` が両方のUIの開発試用を選ぶ。通常の `npm run dev` へ戻す際は
この変数を解除する。保存済みのモデル選択は書き換えない。製品に新しい設定UIは追加しない。

## 実行

- `agents-api.cjs` が `/v1/agents/sessions` に接続し、`environment: none` と独自function toolsを使う。
  API上の名前は `tex64_` 接頭辞を付け、返された名前を既存ツールへ対応付ける。
  ファイル操作・組版は既存のElectronツールだけが実行する。Ask / Plan、ワークスペース境界、
  差分・undo、最後の自動組版を既存run-loopで保持する。
- 1回のユーザー依頼に1セッション。ツール要求の間は同じセッションを継続し、実行済みの結果だけを返す。
  次のユーザー依頼ではローカルの会話履歴から新しいセッションを作る。
  複数ターンにまたがるクラウドセッション永続化・自動復旧は今回の試用に含めない。
- テキストの逐次イベントとdoneだけの応答に対応。`required_actions` を取得してからツールを実行し、
  `turn.completed` を完了の根拠とする。idleやストリーム切断を成功扱いしない。
- 再開用イベントは購読を開始してから送る。POSTの自動リトライと別モデルへのフォールバックはしない。
  終了・停止・失敗時には自分が作成したセッションをキャンセル（未完了時）して削除する。
  削除失敗はセッションID付きで表示する。接続がセッションIDを受信する前に切れた場合は、
  PlatformのAgentsログで `client: tex64-development-trial` を確認する。自動で再送しない。

## 呼び出し制限

- 自動の初回通読、タイトル生成、追加提案だけの追加入力を無効化する。
- サブエージェント・ホスト側sandbox・外部検索は有効化しない。
- 最大6回の応答／ツール要求区切り、180秒で通信を打ち切り、サーバーにも停止を送る。
- 取得できた累積利用量が60,000トークンに達したら次の入力を送らない。
  APIの利用量が未確定の場合は0と記録せず、回数・時間の制限で試用を区切る。
- API内部で複数のモデル呼び出しが発生し、利用量も遅れて確定するため、これらは厳密な課金上限ではない。
  TeX64の契約枠とは別の開発用API利用として扱い、本番の残量を変更しない。

## 確認

2026-09-16：保存済みキーによるセッション一覧取得はHTTP 200。
ネットワークを使わず、分割UTF-8／SSE、doneのみの本文、ツールIDの引継ぎ、累積利用量の差分、
購読後の結果返送、セッション削除を確認。既存BuildServiceで小さなTeX文書のPDF生成を確認。

実APIでは合計4セッションを作成し、すべて削除済み。内訳は文書ツール名の問題の切分け2回、
小さなツールの往復1回、修正後の文書編集1回。入力を伴うPOSTは作成4回＋ツール結果返送3回。
API内部の推論回数・トークン量・費用は `usage: null` のため未確定で、0とは扱わない。

修正後はAIモードのconversation IDで実際のAgentServiceを通し、`main.tex` の1行を
`1+1=2` から `2+2=4` に編集 → BuildServiceでPDF生成 → 最終応答まで完了した。
編集1回・組版1回・完了応答の3区切りで、undoによる元ファイルの完全復元も確認した。
この試行のサーバーturn IDは `turn_09353f2ae212fb5d006aaa0733a1488191a3749fea6d91a949`。
旧名 `replace_lines` / `compile_document` はAPI内部で失敗しローカルへ届かなかったが、
専用名に変更後は `requires_action` と実際のローカルツール結果の往復が成功した。

APIを使わない確認でもCodeとAI両方のconversation IDで実ファイル編集・PDF生成・undo復元を確認。
Askからの未登録書き込みツールは実行前に拒否した。rendererビルドと変更CJSの構文確認は成功。
GUI操作と既存エンジンとの品質・速度・費用の比較、複数ターンのクラウド履歴継続は未実施。
本番切替・配布・`/Applications` の差替えは行っていない。

公式仕様：[Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)、
[Functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)、
[Events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)、
[利用量](https://developers.openai.com/api/docs/guides/agents-api/observability)。
