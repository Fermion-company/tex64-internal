# Independent document review

This module separates two review layers:

1. `IndependentReviewResultSchema` records evidence-backed qualitative review
   across requirements, argumentation, factual grounding, mathematics, style,
   structure, references, and typesetting. It deliberately has no overall
   `passed` field.
2. `evaluateDeterministicAcceptance` recomputes measurable criteria directly
   from the validated `DocumentModel`. Required sections, text amount, figures,
   tables, equations, sources, and reference integrity cannot be overridden by
   model output.

Every review is bound to exact brief, plan-projection, and document digests.
Required model-assessed or user-review criteria leave deterministic acceptance
in `blocked`, while invalid documents, stale targets, unsupported page-only
lengths, and unmapped deterministic criteria fail closed.

`createReviewPlanProjection` adapts the executable `DocumentPlan` through an
`import type` boundary, keeping the evaluator independent of plan execution.

Run the isolated tests from `services/tex64-ai`:

```sh
npx vitest run --config src/domain/review/vitest.config.ts
```
