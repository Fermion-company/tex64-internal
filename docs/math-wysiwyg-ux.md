# MathLive WYSIWYG UX feedback + implementation plan

Source: user feedback 2026-02-02.

## Status (as of 2026-02-03)
- Implemented: auto-suggest min length (>= 3, with 2-letter allowlist for pi/mu/nu/xi), manual trigger via Ctrl+., ArrowUp/Down navigation + Enter apply + Esc close, Tab reserved for placeholders, safe replacement via selection + insert (no full setValue slicing)
- Implemented: operator auto-replace for common tokens (<=, >=, !=, ->, <-, <->, =>, <=>, +-, -+, ..., d/dx, ∂/∂x)
- Implemented: selection + `/` wraps into `\\frac{(selection)}{\\placeholder{}}`, otherwise inserts literal `/`
- Implemented: matrix/cases structure editing: Enter adds row, Cmd/Ctrl+Enter adds column; Ctrl+. in matrix/cases can open a small ops palette (add/remove row/col). The "候補" button now also falls back to this palette when there is no token to suggest.
- Implemented: MRU ranking (project-scoped localStorage key); packs (core/math/physics/cs/personal/jp)
- Implemented: candidate indexing: prefix uses a sorted range lookup; contains search uses an n-gram index (avoids scanning all triggers per keystroke)
- Implemented: dictionary additions (examples): det/tr/rank/ker/dim, Var/Cov, set-builder template, higher derivatives; plus common-but-personal commands (under/overbrace, boxed, cancel(+to) variants, mathscr/boldsymbol/bm/mathds), new operators (min/max/sup/gcd/lcm/mod/sgn, impliedby), JP triggers, and array presets (cc/ccc/rcl)

## 1) Key UX failures (highest impact)
- Auto-suggest on 1-letter tokens creates constant noise and slows typing. Require a min token length for auto; allow explicit/manual trigger for 1-letter tokens.
- Tab is captured by suggestions and conflicts with MathLive placeholder navigation. Keep Tab for placeholders; move suggestion navigation to ArrowUp/ArrowDown (optional Ctrl+Tab for cycling).
- Candidate apply does string slice + setValue, which breaks undo/selection and can be slow. Use MathLive selection replace and insert so it is a single undo step.

## 2) "Shows when it should not" cases
- Common word triggers (in, or, and, log, sin, etc.) collide with variable names and text input. Auto-suggest should be stricter (min length >= 3) or offer an explicit-only mode.
- Suffix rescue (dropPrefix) can trigger unexpectedly. Disable by default or require long tokens (>= 6) and/or explicit trigger.

## 3) Performance risks
- buildWordCandidates scans all triggers every keystroke (O(N)). Move to a prefix index / trie. Gate contains search to longer tokens and/or explicit trigger only.

## 4) Dictionary gaps (coverage)
- Font commands: \\mathbb, \\mathfrak, \\mathsf, \\mathtt, \\mathit, etc. Ensure excluded commands do not remove these.
- Relations/operators: \\leqslant, \\geqslant, \\ll, \\gg, \\ne, \\mid, \\nmid, \\parallel, \\perp, \\subsetneq, \\supsetneq, etc.
- Calculus templates: \\int f(x) \\, \\mathrm{d}x, higher derivatives d^2/dx^2, \\partial^2/\\partial x^2, \\nabla^2.
- Matrices/cases: fixed 2x2 only is limiting. Add structure editing (insert row/column).
- Definition symbols: := and \\stackrel{def}{=}.
- JP triggers (opt-in): romaji keywords like sekibun, shiguma, henbibun, ru-to, etc.

## 5) Internal API risk
- Current placeholder detection touches mathfieldApi._mathfield.model.atoms. Prefer public API. If unavoidable, version lock MathLive and add E2E coverage.

## 6) Implementation plan (practical order)
1. Auto-suggest gating
   - Min length for auto (>= 2 or >= 3), explicit trigger for 1-letter (e.g., Ctrl+Space or double-Tab).
   - Add explicit-only mode for users who want zero noise.
   - Disable suffix rescue by default or gate it behind a length threshold.
2. Safe replacement
   - Replace token by setting MathLive selection range and calling insert/executeCommand so it is 1 undo step.
   - Avoid setValue unless MathLive API is missing (last resort).
3. Tab behavior
   - If MathLive says cursor is in a placeholder/prompt, let Tab pass through.
   - Use ArrowUp/ArrowDown for candidate cycling; optional Ctrl+Tab for cycling.
4. Candidate indexing
   - Build prefix map/trie at init from TRIGGER_KEYS.
   - Only do contains search for long tokens or explicit trigger.
5. Dictionary packs + MRU ranking
   - Split triggers into packs (math/physics/cs) with toggles.
   - Track MRU per project and boost ranking.

## 7) Files likely touched
- web-src/app/math-wysiwyg.ts (gating, key handling, applyCandidate)
- web-src/app/math-wysiwyg-candidates.ts (prefix index, contains gating)
- web-src/app/math-wysiwyg-selection.ts (placeholder detection, reduce internal API usage)
- web-src/app/blocks/input-ui.ts (explicit trigger, keybinding hooks)
- tests/e2e/mathlive-wysiwyg-suggestions.spec.js (new UX cases)
