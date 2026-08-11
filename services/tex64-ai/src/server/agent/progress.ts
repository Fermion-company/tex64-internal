import { z } from "zod";

/**
 * User-facing progress is deliberately semantic. Compiler output, generated
 * filenames, provider traces, and other implementation details belong in
 * server-side observability, never in this event contract.
 */
export const SEMANTIC_PROGRESS_STATES = [
  "understanding",
  "planning",
  "writing",
  "checking",
  "formatting",
  "ready",
  "needs_input",
  "failed",
] as const;

export const SemanticProgressStateSchema = z.enum(SEMANTIC_PROGRESS_STATES);

export type SemanticProgressState = z.infer<
  typeof SemanticProgressStateSchema
>;

export const SEMANTIC_PROGRESS_LABELS = {
  understanding: "ご要望を整理しています",
  planning: "文書の構成を考えています",
  writing: "本文を作成しています",
  checking: "文書を確認しています",
  formatting: "文書を整えています",
  ready: "文書ができました",
  needs_input: "確認したいことがあります",
  failed: "文書の作成を完了できませんでした",
} as const satisfies Record<SemanticProgressState, string>;

export const SemanticProgressEventSchema = z
  .object({
    type: z.literal("agent.progress"),
    state: SemanticProgressStateSchema,
    label: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.label !== SEMANTIC_PROGRESS_LABELS[event.state]) {
      context.addIssue({
        code: "custom",
        path: ["label"],
        message: "Progress labels must use the semantic user-facing copy",
      });
    }
  });

export type SemanticProgressEvent = z.infer<
  typeof SemanticProgressEventSchema
>;

const TRANSITIONS = {
  understanding: ["planning", "needs_input", "failed"],
  planning: ["writing", "needs_input", "failed"],
  writing: ["checking", "needs_input", "failed"],
  checking: ["writing", "formatting", "needs_input", "failed"],
  formatting: ["writing", "checking", "ready", "needs_input", "failed"],
  needs_input: ["understanding", "failed"],
  ready: [],
  failed: [],
} as const satisfies Record<
  SemanticProgressState,
  readonly SemanticProgressState[]
>;

export function createProgressEvent(
  state: SemanticProgressState,
  options: { sequence?: number; occurredAt?: string } = {},
): SemanticProgressEvent {
  const event: SemanticProgressEvent = {
    type: "agent.progress",
    state,
    label: SEMANTIC_PROGRESS_LABELS[state],
    sequence: options.sequence ?? 0,
  };

  if (options.occurredAt !== undefined) {
    event.occurredAt = options.occurredAt;
  }

  return SemanticProgressEventSchema.parse(event);
}

export function canTransitionProgress(
  from: SemanticProgressState,
  to: SemanticProgressState,
): boolean {
  return (TRANSITIONS[from] as readonly SemanticProgressState[]).includes(to);
}

export function transitionProgress(
  current: SemanticProgressEvent,
  next: SemanticProgressState,
  occurredAt?: string,
): SemanticProgressEvent {
  if (!canTransitionProgress(current.state, next)) {
    throw new Error(
      `Invalid semantic progress transition: ${current.state} -> ${next}`,
    );
  }

  return createProgressEvent(next, {
    sequence: current.sequence + 1,
    occurredAt,
  });
}

export function isTerminalProgressState(
  state: SemanticProgressState,
): boolean {
  return state === "ready" || state === "failed";
}
