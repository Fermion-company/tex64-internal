/**
 * Compact, model-facing reference for apply_document_patch.
 *
 * The full zod-derived JSON Schema for a document patch serializes to
 * ~130KB (~110k tokens) because the recursive node/math AST is inlined —
 * far too large to resend on every agent step, and empirically it
 * overwhelms smaller writer models into degenerate read loops. The model
 * instead receives this TypeScript-style digest (a few KB) while the full
 * zod schema stays the actual validation gate at execution time; invalid
 * patches come back as tool errors the model can repair.
 *
 * tests/agent-patch-reference.test.ts asserts every node type, math kind,
 * inline type, and operation stays mentioned here so the digest cannot
 * silently drift from the schema.
 */
export const DOCUMENT_PATCH_REFERENCE = `## apply_document_patch の書き方

patch = { id: 新しいUUID, documentId, baseRevision: 最新のrevision, createdAt: ISO8601, operations: Operation[] (1〜1000件) }

Operation（op で判別）:
- { op: "insert", node: Node, position: Position } — 新しいNodeを追加
- { op: "update", nodeId, node: Node } — 既存Nodeを完全置換（同じidを保つ）
- { op: "move", nodeId, position: Position }
- { op: "delete", nodeId }
- { op: "setMetadata", metadata: Metadata }

Position（kind で判別）:
- { kind: "root", index } — 文書直下
- { kind: "section", parentId: 親sectionのid, index } — section配下（theorem / proof / appendix も親にできる）
- { kind: "container", parentId, index }
- { kind: "definitions" } — citation / footnote 用（本文位置を持たない）

Node（type で判別。全Nodeに id: UUID が必須）:
- section { title: Inline[], children: [] } — childrenは自動管理。空配列で挿入し、中身は position で section 配下に insert する
- paragraph { content: Inline[] }
- heading { level: 1..6, content: Inline[] }
- list { style: "bullet"|"ordered", items: [{ id, content: Inline[], children: [] }] }
- equation { expression: Math, description?: Inline[], numbered: boolean } — 別行立て数式
- figure { content: FigureContent, altText: string, caption: Inline[], widthPercent: 10..100 }
- table { caption?: Inline[], columns: [{ id, header: Inline[], alignment: "left"|"center"|"right" }], rows: [{ id, cells: [{ columnId, content: Inline[] }] }] }
- callout { tone: "note"|"info"|"warning"|"success", title?: Inline[], content: Inline[] }
- theorem { theoremKind: "definition"|"lemma"|"theorem"|"corollary", title?: Inline[], children: [] }
- proof { title?: Inline[], children: [] }
- algorithm { title: Inline[], description?: Inline[], inputs?: Inline[], outputs?: Inline[], steps: [{ id, content: Inline[], children: [] }] }
- codeBlock { language?: string, caption?: Inline[], code: string, showLineNumbers: boolean }
- appendix { title: Inline[], children: [] }
- pageBreak {}
- citation { sourceId: resolve_sourceが返したsourceId（新規引用では必須）, authors: string[], title, year: "2020"形式, publication?, publisher?, volume?, issue?, pages?, sourceType?: "journal_article"|"proceedings_article"|"book"|"book_chapter"|"report"|"thesis"|"web"|"other", doi?, url? } — position は {kind:"definitions"}。書誌情報はresolve_sourceのcanonical metadataをそのまま使う
- bibliography { title?: Inline[], citationIds: [citationのid] } — 参考文献リスト本体。position は本文側。本文で citationRef した citation は必ずここの citationIds にも含める（含めないと文書検証で拒否される）
- footnote { content: Inline[] } — position は {kind:"definitions"}

Inline（type で判別）:
- { type: "text", text, marks?: ("bold"|"italic"|"underline"|"strikethrough"|"code"|"superscript"|"subscript")[] }
- { type: "inlineMath", expression: Math }
- { type: "citationRef", citationId, locator?: string } — 本文中の引用。citation Node を先に definitions へ insert
- { type: "footnoteRef", footnoteId }
- { type: "crossRef", targetType: "section"|"equation"|"theorem"|"figure"|"table", targetId, format: "number"|"page" }
- { type: "hardBreak" }

Math（kind で判別。LaTeX文字列ではなく必ずこの構造で書く）:
- { kind: "literal", value: "3.14" 数値文字列 }
- { kind: "symbol", name: "x"|"alpha"|"beta"|"theta"|"epsilon"|"sigma"|"mu"|"lambda"|"pi"|"infty" など英字名 }
- { kind: "text", value: 説明語句 }
- { kind: "unary", operator: "negate"|"sqrt"|"absolute"|"norm"|"floor"|"ceiling"|"not", operand }
- { kind: "binary", operator: "add"|"subtract"|"multiply"|"divide"|"power"|"equals"|"approximatelyEquals"|"lessThan"|"lessThanOrEqual"|"greaterThan"|"greaterThanOrEqual"|"notEquals"|"in"|"notIn"|"subset"|"subsetOrEqual"|"superset"|"supersetOrEqual"|"union"|"intersection"|"setDifference"|"and"|"or"|"implies"|"ifAndOnlyIf"|"proportionalTo", left, right } — 分数は divide
- { kind: "function", name: "sin"|"cos"|"tan"|"arcsin"|"arccos"|"arctan"|"sinh"|"cosh"|"tanh"|"log"|"ln"|"exp"|"min"|"max"|"det"|"gcd"|"lcm"|"arg"|"realPart"|"imaginaryPart", arguments: Math[] }
- { kind: "sequence", items: Math[] } — 並置（積の省略記法など）
- { kind: "script", base, subscript?, superscript? } — x_t や α² など
- { kind: "root", radicand, index? }
- { kind: "integral", integrand, variable: symbol, lowerBound?, upperBound? }
- { kind: "largeOperator", operator: "sum"|"product", expression, index?: symbol, lowerBound?, upperBound? }
- { kind: "limit", expression, variable: symbol, approaches, direction: "both"|"left"|"right" }
- { kind: "derivative", expression, variable: symbol, order: 1 }
- { kind: "partialDerivative", expression, variables: [{ variable: symbol, order }] }
- { kind: "vector", entries: Math[], orientation: "row"|"column" }
- { kind: "matrix", rows: Math[][], delimiter: "parentheses"|"brackets"|"bars"|"doubleBars"|"none" }
- { kind: "cases", cases: [{ expression, condition }] }
- { kind: "aligned", lines: [{ left, relation: "equals"|"approximatelyEquals"|"lessThan"|"lessThanOrEqual"|"greaterThan"|"greaterThanOrEqual", right, annotation?: string }] } — 複数行の導出はこれ1つのequationにまとめる
- { kind: "accent", accent: "hat"|"bar"|"tilde"|"dot"|"doubleDot"|"vector", expression }
- { kind: "set", elements: Math[] }
- { kind: "setBuilder", variable, condition }
- { kind: "quantified", quantifier: "forAll"|"exists"|"existsUnique", variable: symbol, domain?, predicate }
- { kind: "binomial", upper, lower }
- { kind: "statisticalOperator", operator: "probability"|"expectation"|"variance"|"covariance", expression, condition?, subscript? } — 条件付き分布 q(x|y) は condition を使う

FigureContent（kind で判別）:
- { kind: "flowDiagram", direction: "left-to-right"|"top-to-bottom", nodes: [{ id, label, shape: "process"|"decision"|"terminator"|"data" }] (2..32), edges: [{ from, to, label? }] }
- { kind: "chart", chartType: "line"|"bar", xAxis: { label, range?: {min,max} }, yAxis: 同様, series: [{ label, points: [{x,y}] }] }

Metadata: { title, subtitle?, language: "ja"など, documentType: "article"|"proposal"|"report"|"paper"|"letter"|"notes", authors: [{ id, name, affiliation?, email? }], keywords: string[], layout?: { preset: "standard"|"academic"|"business"|"compact", pageSize: "A3"|"A4"|"A5"|"B4"|"B5"|"letter", columns: 1|2 }, citationStyle?: { schemaVersion: 1, style: "author-year"|"apa7"|"ieee"|"numeric" }, writingStyle?: { register: "plain"|"professional"|"academic"|"formal", voice: "neutral"|"assertive"|"analytical"|"persuasive", jargonLevel: "low"|"moderate"|"high", sentenceStyle: "concise"|"balanced"|"detailed" }, createdAt, updatedAt }

figure の assetId / assetKind ("png"|"jpeg"|"pdf") は既存資産の参照専用。新しい図は必ず content（flowDiagram / chart）で作る。

数式・導出の原則: 導出の各行は aligned の lines に。式番号が必要な数式は equation ノード（numbered: true）。文中の短い式は inlineMath。
- function の name は上の列挙だけ。q(x|y) や p_theta(x) のような確率密度・任意の関数記号は function にせず、{kind:"statisticalOperator", operator:"probability", expression: x, condition: y, subscript: theta など} で表すか、script（q_θ など）と組み合わせる。
- kind に演算子名（multiply, equals など）を直接書かない。必ず binary/unary/statisticalOperator の operator に入れる。ギリシャ文字は symbol の name に英字名（"alpha" など）で書く。`;
