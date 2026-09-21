# Agent and formula verification — 2026-09-18

## Implemented behavior

Axiom proposes concrete changes using inspected document context: target, reason, change, equations when applicable, and a completion condition. Selecting a proposal runs the ordinary edit loop. Document opening does not trigger inference or a whole-document review. Existing Axiom model mappings are unchanged.

The loop records the task, edits, compilation and observed PDF pages. Completion requires the changed pages returned by SyncTeX to have been delivered to the model. A dropped final response can be recovered from these saved receipts without repeating edits or inference. Stop produces a persisted stopped result. New unrelated requests do not inherit an old incomplete task's completion gate.

Code and AI paper math fields share MathLive configuration, candidate replacement and structural key handling. PDF editing keeps one close/discard action and a floating editor; it does not insert an editor between PDF pages.

## Evidence retained

- Actual Electron Computer Use: 100 distinct formulas entered and saved. The aggregate saved source compiles into 10 pages without TeX errors or overflow; pages 1 and 10 were visually checked. Inline and table-cell math were also edited, saved and rebuilt.
- Actual model: one capped sequence of 10 upstream requests. An ordinary explanation request produced an unsolicited concrete proposal; clicking it edited the source, compiled and sent the resulting PDF image to the model. Input 70,318 tokens (58,351 cached), output 1,028; zero retries. The development relay used the existing model configuration, not production authentication/quota end to end.
- Actual Electron with local model responses: questions and answers, proposal selection, draft/attachment preservation, stale proposal disabling, empty Enter, in-flight instructions, stop, errors, incomplete work, narrow window, textarea growth/shrink and reload persistence.
- Actual two-page build: attempting completion after observing only page 1 was rejected when page 2 changed; observing page 2 allowed completion. Model responses for this state exercise were local fixtures, with no paid inference.
- Renderer/MathLive/AI production builds and relevant syntax/type checks passed during implementation. Release packaging builds are tracked separately in GitHub Actions.
- Additional Computer Use input saved `1.23e4` unchanged after Enter, without adding a source line or a timed scientific-notation conversion.

## Limits

SyncTeX may not identify every changed page when mappings are missing or a single source line spans pages. Delivering a PDF to a model is not an independent mathematical proof. This is a recorded state matrix, not a guarantee covering every input or OS. Fullwidth IME input, the failed-MathLive fallback and packaged upgrades have not received complete interactive acceptance. Matrix row input has formula-case evidence; dedicated column insertion and long-expression scrolling acceptance remain pending. No paid test was repeated to fill those gaps.

The separate production API change forwards `max_completion_tokens` and validates output limits. Desktop distribution, production API authentication/quota acceptance and Windows upgrade acceptance must be reported separately from the evidence above.
