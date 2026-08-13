# Agent autonomy evaluation

This directory is a deterministic CI contract for document-agent traces. It
scores four behaviors without invoking a language model:

- assumptions must be backed by a user value, explicit delegation, or an
  allowlisted system default;
- resolved questions must not be asked again unless their fields are
  explicitly invalidated;
- document mutations must reference the exact proposed and confirmed plan;
- the final structured brief must satisfy weighted scenario expectations.

Run the isolated suite from `services/tex64-ai`:

```sh
npx vitest run --config src/evals/agent-autonomy/vitest.config.ts
```

CI and runtime adapters can import `evaluateAutonomyScenario`,
`evaluateAutonomySuite`, their Zod schemas, and the fixed fixtures from
`src/evals/agent-autonomy/index.ts`. Invalid trace payloads fail closed with a
Zod validation error; a trace without a final brief is reported as
non-measurable and does not pass.
