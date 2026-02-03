# MathLive Suggestion Commands (TeX ベース)

このファイルは、サジェストで出てくる候補を **TeX コマンド基準** で整理した一覧です。  
`#?` は入力用プレースホルダー（MathLive 内で入力欄）を表します。

## サジェストの使い方（最新版）
- 自動サジェストは **英字トークン3文字以上** で発火（containsは4文字以上）
- 手動サジェストは **`Ctrl + .`** または UI の「候補」ボタン
- 候補操作: **↑/↓** で移動、**Enter** で挿入、**Esc** で閉じる  
  Tab はプレースホルダ移動に専用化（サジェストは奪わない）
- **手動のみ** / **パックON/OFF** は「候補/サジェスト」設定で変更可能
- 「個人/装飾」パックはデフォルトOFF（自動候補のノイズ削減）。手動サジェストならOFFでも候補に出ます
- 最近使った候補は **MRU** で上位に来る

## 入力ショートカット（MathLive）
- 選択範囲がある状態で `/` を押すと `\\frac{(選択)}{\\placeholder{}}` に変換（選択なしは `/` を挿入）
- 行列/ケース内で **Enter=行追加**, **Cmd/Ctrl+Enter=列追加**
- 行列/ケース内で「行/列の追加・削除」パレットが出る（`Ctrl + .` / 「候補」ボタンで開く。↑/↓で選択、Enterで実行）
- 演算子トリガーは自動変換（例）: `<=`, `>=`, `!=`, `->`, `<-`, `<->`, `=>`, `<=>`, `+-`, `-+`, `...`, `d/dx`, `∂/∂x`

## Operators / Calculus
- `\\sum`
  - variants: `\\sum_{#?}^{#?}`
  - triggers: `sum`
  - aliases: `sigma`, `summation`, `summate`
- `\\prod`
  - variants: `\\prod_{#?}^{#?}`
  - triggers: `prod`
  - aliases: `product`, `multiplication`
  - note: `sum` でも候補に含まれます
- `\\int`
  - variants: `\\int #? \\, \\mathrm{d}#?`, `\\int_{#?}^{#?}`, `\\iint`, `\\iiint`, `\\oint`
  - triggers: `int`
  - aliases: `integral`, `integrate`, `integration`, `antiderivative`
- `\\sqrt`
  - variants: `\\sqrt{#?}`, `\\sqrt[#?]{#?}`
  - triggers: `sqrt`
  - aliases: `root`, `squareroot`
- `\\frac`
  - variants: `\\frac{#?}{#?}`, `\\dfrac{#?}{#?}`
  - triggers: `frac`
  - aliases: `fraction`, `divide`, `quotient`
- `\\lim`
  - variants: `\\lim_{#? \\to #?}`
  - triggers: `lim`
  - aliases: `limit`
- `\\limsup`
  - variants: `\\limsup_{#?}`
  - triggers: `limsup`
- `\\liminf`
  - variants: `\\liminf_{#?}`
  - triggers: `liminf`
- `\\operatorname*{arg\\,min}`
  - triggers: `argmin`
- `\\operatorname*{arg\\,max}`
  - triggers: `argmax`

## Differential / Vector Calculus
- `\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}`
  - triggers: `ddx`
  - aliases: `deriv`, `d/dx`
- `\\frac{\\mathrm{d}^2 #?}{\\mathrm{d}#?^2}`
  - triggers: `d2dx2`
- `\\frac{\\mathrm{d}^3 #?}{\\mathrm{d}#?^3}`
  - triggers: `d3dx3`
- `\\frac{\\partial^2 #?}{\\partial #?^2}`
  - triggers: `p2dx2`
- `\\frac{\\partial^3 #?}{\\partial #?^3}`
  - triggers: `p3dx3`
- `\\frac{\\partial #?}{\\partial #?}`
  - triggers: `pdx`
  - aliases: `partiald`, `∂/∂x`
- `\\nabla\\cdot`, `\\nabla\\times`
  - triggers: `divergence`, `curl`
  - aliases: `curl2`
- `\\nabla^2`
  - triggers: `laplacian`

## Matrices / Piecewise
- `\\begin{matrix}#?&#?\\\\#?&#?\\end{matrix}`
  - triggers: `matrix`
  - aliases: `mat`
- `\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}`
  - triggers: `pmatrix`
  - aliases: `pmat`
- `\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}`
  - triggers: `bmatrix`
  - aliases: `bmat`
- `\\begin{Bmatrix}#?&#?\\\\#?&#?\\end{Bmatrix}`
  - triggers: `Bmatrix`
- `\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}`
  - triggers: `vmatrix`
- `\\begin{Vmatrix}#?&#?\\\\#?&#?\\end{Vmatrix}`
  - triggers: `Vmatrix`
- `\\begin{cases}#?&#?\\\\#?&#?\\end{cases}`
  - variants: `\\begin{cases}#? , & #?\\\\#? , & #?\\end{cases}`
  - triggers: `cases`
  - aliases: `piecewise`
- `\\binom{#?}{#?}`
  - triggers: `binom`
  - aliases: `choose`, `combination`, `ncr`

## Multiline / Alignment
- `\\begin{aligned}#? &= #?\\\\#? &= #?\\end{aligned}`
  - triggers: `aligned`
  - aliases: `align`
- `\\begin{array}{cc}#?&#?\\\\#?&#?\\end{array}`
  - variants: `\\begin{array}{ccc}#?&#?&#?\\\\#?&#?&#?\\end{array}`, `\\begin{array}{rcl}#?&=&#?\\\\#?&=&#?\\end{array}`, `\\begin{array}{#?}#?\\end{array}`
  - triggers: `array`
  - aliases: `cases2`, `table`

## Functions
- `\\log`
  - variants: `\\log_{#?}`
  - triggers: `log`
  - aliases: `logarithm`
- `\\ln`
  - triggers: `ln`
- `\\exp`
  - variants: `e^{#?}`
  - triggers: `exp`
- `\\sin`, `\\cos`, `\\tan`, `\\cot`, `\\sec`, `\\csc`
  - triggers: `sin`, `cos`, `tan`, `cot`, `sec`, `csc`
  - aliases: `sine`, `cosine`, `tangent`, `cotangent`, `secant`, `cosecant`
- `\\arcsin`, `\\arccos`, `\\arctan`
  - triggers: `arcsin`, `arccos`, `arctan`
  - aliases: `arcsine`, `arccosine`, `arctangent`

## Linear Algebra / Operators
- `\\det`, `\\ker`, `\\dim`
  - triggers: `det`, `ker`, `dim`
- `\\operatorname{tr}`
  - triggers: `tr`
- `\\operatorname{rank}`
  - triggers: `rank`
- `\\min`, `\\max`, `\\sup`
  - triggers: `min`, `max`, `sup`
- `\\inf`（※ `inf` は `\\infty` も候補に含みます）
  - triggers: `inf`
- `\\gcd`, `\\operatorname{lcm}`
  - triggers: `gcd`, `lcm`
- `\\bmod`, `\\pmod{#?}`
  - triggers: `mod`
- `\\operatorname{sgn}`
  - triggers: `sgn`

## Fonts / Styles
- `\\mathbb{#?}`
  - triggers: `mathbb`, `bb`
- `\\mathfrak{#?}`
  - triggers: `mathfrak`, `frak`
- `\\mathsf{#?}`
  - triggers: `mathsf`, `sf`
- `\\mathtt{#?}`
  - triggers: `mathtt`, `tt`
- `\\mathit{#?}`
  - triggers: `mathit`, `it`
- `\\mathscr{#?}`
  - triggers: `mathscr`, `scr`
  - pack: 個人/装飾
- `\\boldsymbol{#?}`, `\\bm{#?}`
  - triggers: `boldsymbol`, `bm`
  - pack: 個人/装飾
- `\\mathds{#?}`
  - triggers: `mathds`, `ds`
  - pack: 個人/装飾
  - note: MathLive側は `\\mathds` 非対応なので、エディタ内表示は `\\mathbb` にマクロ変換して見せる（出力latexは `\\mathds{...}` のまま）

## Decorations
- `\\overbrace{#?}^{#?}`, `\\underbrace{#?}_{#?}`
  - triggers: `overbrace`, `underbrace`
  - pack: 個人/装飾
- `\\boxed{#?}`
  - triggers: `boxed`
  - pack: 個人/装飾
- `\\cancel{#?}`, `\\bcancel{#?}`, `\\xcancel{#?}`
  - triggers: `cancel`
  - variants: `\\cancelto{#?}{#?}`
  - triggers: `cancelto`
  - pack: 個人/装飾

## Sets / Logic
- `\\in`, `\\notin`
  - triggers: `in`, `notin`
  - aliases: `element`, `notelement`
- `\\left\\{#? \\mid #?\\right\\}`
  - triggers: `set`
- `\\subset`, `\\subseteq`
  - triggers: `subset`
  - aliases: `subseteq`, `subsetof`
- `\\subsetneq`
  - triggers: `subset` (variant)
- `\\supset`, `\\supseteq`
  - triggers: `supset`
  - aliases: `superset`, `superseteq`
- `\\supsetneq`
  - triggers: `supset` (variant)
- `\\cup`, `\\bigcup`
  - triggers: `cup`, `bigcup`
  - aliases: `union`
- `\\cap`, `\\bigcap`
  - triggers: `cap`, `bigcap`
  - aliases: `intersection`
- `\\forall`, `\\exists`, `\\iff`
  - triggers: `forall`, `exists`, `iff`
- `\\Leftarrow`（implied by）
  - triggers: `impliedby`
- `\\therefore`, `\\because`
  - triggers: `therefore`, `because`
- `\\emptyset`
  - triggers: `empty`

## Relations / Comparison
- `\\leq`
  - variants: `\\leqq`
  - triggers: `leq`, `<=`
  - aliases: `le`, `lessequal`
- `\\leqslant`
  - triggers: `leq` (variant), `<=`
  - aliases: `leqslant`
- `\\geq`
  - variants: `\\geqq`
  - triggers: `geq`, `>=`
  - aliases: `ge`, `greaterequal`
- `\\geqslant`
  - triggers: `geq` (variant), `>=`
  - aliases: `geqslant`
- `\\neq`
  - triggers: `neq`, `!=`
  - aliases: `notequal`, `ne`
- `\\ll`, `\\gg`
  - triggers: `ll`, `gg`
- `\\mid`, `\\nmid`
  - triggers: `mid`, `nmid` (operator: `||` は `\\mid` を候補に出す)
- `\\parallel`, `\\perp`
  - triggers: `parallel`, `perp` (operator: `||` は `\\parallel` を候補に出す)
- `\\approx`, `\\sim`, `\\simeq`
  - triggers: `approx`
  - aliases: `sim`, `simeq`, `similar`, `approximately`
- `\\equiv`, `\\cong`
  - triggers: `equiv`
  - aliases: `cong`, `congruent`, `identical`
- `\\propto`
  - triggers: `propto`
  - aliases: `proportional`
- `\\stackrel{def}{=}`
  - triggers: `defeq` (operator: `:=`)

## Arrows / Maps
- `\\to`, `\\rightarrow`
  - triggers: `to`, `->`
  - aliases: `arrow`, `goes`
- `\\leftarrow`
  - variants: `\\Leftarrow`
  - triggers: `leftarrow`, `<-`
  - aliases: `left`
- `\\leftrightarrow`
  - variants: `\\Leftrightarrow`
  - triggers: `leftrightarrow`, `<->`, `<=>`
  - aliases: `iff2`
- `\\Rightarrow`
  - triggers: `implies`, `=>`
- `\\mapsto`
  - triggers: `mapsto`
  - aliases: `maps`
- `\\xrightarrow{#?}`, `\\xleftarrow{#?}`
  - triggers: `xrightarrow`, `xleftarrow`
  - aliases: `labeledarrow`
- `\\overset{#?}{#?}`
  - triggers: `overset`
  - aliases: `stackrel`

## Binary Operators
- `\\cdot`
  - triggers: `cdot`, `*`
  - aliases: `dot`
- `\\times`
  - triggers: `times`, `*`
- `\\div`
  - triggers: `div`
  - aliases: `divide`
- `\\pm`, `\\mp`
  - triggers: `pm`, `mp`, `+-`, `-+`
  - aliases: `plusminus`
- `\\circ`
  - triggers: `circ`
  - aliases: `compose`
- `\\oplus`, `\\otimes`
  - triggers: `oplus`, `otimes`
  - aliases: `directsum`, `tensor`
- `\\setminus`
  - triggers: `setminus`
  - aliases: `difference`
- `\\cdots`, `\\ldots`
  - triggers: `cdots`, `ldots`, `...`

## JP Triggers (opt-in)
- `\\int`
  - triggers: `sekibun`
- `\\sum`
  - triggers: `shiguma`
- `\\partial`
  - triggers: `henbibun`
- `\\sqrt{#?}`
  - triggers: `ruuto`

## Accents / Delimiters
- `\\left|#?\\right|`
  - triggers: `abs`
  - aliases: `absolute`, `absolutevalue`, `magnitude`
- `\\left\\lVert#?\\right\\rVert`
  - triggers: `norm`
  - aliases: `norms`
- `\\left\\lceil#?\\right\\rceil`
  - triggers: `ceil`
  - aliases: `ceiling`
- `\\left\\lfloor#?\\right\\rfloor`
  - triggers: `floor`
  - aliases: `flooring`
- `\\vec{#?}`, `\\overrightarrow{#?}`
  - triggers: `vec`
  - aliases: `vector`
- `\\hat{#?}`, `\\bar{#?}`, `\\overline{#?}`, `\\underline{#?}`, `\\tilde{#?}`
  - triggers: `hat`, `bar`, `overline`, `underline`, `tilde`
- `\\dot{#?}`, `\\ddot{#?}`
  - triggers: `dot`, `ddot`
- `\\angle`
  - triggers: `angle`

## Brackets / Templates
- `\\left(#?\\right)`
  - triggers: `par`
  - aliases: `parentheses`
- `\\left[#?\\right]`
  - triggers: `brack`
  - aliases: `brackets`
- `\\left\\{#?\\right\\}`
  - triggers: `brace`
  - aliases: `curly`
- `\\langle #? \\rangle`
  - triggers: `anglebr`
  - aliases: `langle`, `expectation2`
- `\\langle #?, #? \\rangle`
  - triggers: `inner`
  - aliases: `dot2`, `ip`
- `\\left.#?\\right|_{#?}`
  - triggers: `eval`
  - aliases: `evaluateat`

## Logic / Boolean
- `\\land`, `\\lor`, `\\neg`
  - triggers: `and`, `or`, `not`
  - aliases: `wedge`, `vee`, `lnot`
- `\\ni`
  - triggers: `ni`
  - aliases: `contains`

## Text / Fonts
- `\\text{#?}`
  - triggers: `text`
  - aliases: `mathrmtext`
  - note: In the MathLive WYSIWYG field, this suggestion switches the editor to text mode (so typing yields `\\text{...}`) and avoids inserting a placeholder.
- `\\mathrm{#?}`, `\\mathbf{#?}`, `\\mathcal{#?}`
  - triggers: `rm`, `bf`, `cal`
  - aliases: `roman`, `bold`, `script`
- `\\operatorname{#?}`
  - triggers: `op`
  - aliases: `operatorname`

## Special Symbols
- `\\infty`
  - triggers: `inf`, `infty`
  - aliases: `infinity`, `infinite`
- `\\partial`
  - triggers: `partial`
- `\\nabla`
  - triggers: `nabla`, `grad`

## Number Sets / Probability
- `\\mathbb{R}`
  - triggers: `real`
  - aliases: `realnumbers`, `reals`
- `\\mathbb{C}`
  - triggers: `complex`
  - aliases: `complexnumbers`, `complexes`
- `\\mathbb{Z}`
  - triggers: `integer`
  - aliases: `integers`
- `\\mathbb{Q}`
  - triggers: `rational`
  - aliases: `rationals`
- `\\mathbb{N}`
  - triggers: `natural`
  - aliases: `naturalnumbers`, `naturals`
- `\\mathbb{P}`
  - triggers: `prob`
  - aliases: `probability`
- `\\mathbb{E}`
  - triggers: `expect`
  - aliases: `expectation`
- `\\operatorname{Var}`, `\\operatorname{Cov}`
  - triggers: `var`, `cov`

## Greek Letters
- `\\alpha`, `\\beta`
  - triggers: `alpha`, `beta`
- `\\gamma`, `\\Gamma`
  - triggers: `gamma`
- `\\delta`, `\\Delta`
  - triggers: `delta`
- `\\epsilon`, `\\varepsilon`
  - triggers: `epsilon`
- `\\zeta`, `\\eta`, `\\iota`
  - triggers: `zeta`, `eta`, `iota`
- `\\theta`, `\\vartheta`
  - triggers: `theta`
- `\\kappa`, `\\varkappa`
  - triggers: `kappa`
- `\\lambda`, `\\Lambda`
  - triggers: `lambda`
- `\\mu`, `\\nu`
  - triggers: `mu`, `nu`
- `\\xi`, `\\Xi`
  - triggers: `xi`
- `\\pi`, `\\pi_{#?}`, `\\pi^{#?}`, `\\pi_{#?}^{#?}`, `\\varpi`, `\\Pi`
  - triggers: `pi`
- `\\rho`, `\\varrho`
  - triggers: `rho`
- `\\sigma`, `\\varsigma`, `\\Sigma`
  - triggers: `sigma`
- `\\tau`
  - triggers: `tau`
- `\\upsilon`, `\\Upsilon`
  - triggers: `upsilon`
- `\\phi`, `\\varphi`
  - triggers: `phi`
- `\\chi`
  - triggers: `chi`
- `\\psi`, `\\Psi`
  - triggers: `psi`
- `\\omega`, `\\Omega`
  - triggers: `omega`

## Physics / Quantum
- `\\hbar`, `\\ell`
  - triggers: `hbar`, `ell`
- `\\langle #? \\vert` (bra)
  - triggers: `bra`
- `\\vert #? \\rangle` (ket)
  - triggers: `ket`
- `\\langle #? \\vert #? \\rangle` (braket)
  - triggers: `braket`
