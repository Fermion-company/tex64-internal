import { createDocumentWorkflowAgent } from "@/server/agent/workflow-agent";
import type {
  DocumentToolContext,
  DocumentToolHandlers,
} from "@/server/agent/document-tools";
import type { IndependentDocumentReview } from "@/server/agent/reviewer";
import {
  MAX_AGENT_OUTPUT_TOKENS_PER_STEP,
  MAX_AGENT_TOTAL_TOKENS_PER_RUN,
} from "@/server/agent/token-budget";
import { getWorkflowMetadata } from "workflow";

import {
  MAX_AGENT_STEPS,
  MAX_CONTENT_REVIEW_REVISIONS,
  allowsUnchangedDocumentCompletion,
  buildInitialAgentPrompt,
  buildRepairAgentPrompt,
  documentAgentExecutionEvidence,
  finalAssistantText,
  needsIndependentReviewAfterCompilation,
  nextContentReviewAction,
  nextCompileFailureAction,
  safeWorkflowFailureCode,
  safeWorkflowFailureMessage,
  semanticEventKey,
} from "./helpers";
import { normalizeUserFacingResultNote } from "@/lib/user-facing-copy";
import { buildReviewRepairInstructions } from "@/server/agent/review-repair-instructions";
import {
  applyDocumentPatchToolStep,
  applyConfirmedBriefLayoutStep,
  assessDocumentBriefStep,
  activateDocumentRunWorkflowStep,
  checkDocumentToolStep,
  completeDocumentRunStep,
  createDocumentPlanStep,
  failDocumentRunStep,
  formatDocumentToolStep,
  getRunDocumentRevisionStep,
  loadDocumentRunStep,
  markDocumentRunNeedsInputStep,
  readDocumentToolStep,
  resolveSourceToolStep,
  reviewDocumentStep,
  recordSemanticStageStep,
  resolveDocumentRunPromptStep,
  requestInputToolStep,
  resolveAgentRuntimeStep,
  validateRenderCompileAndStoreStep,
} from "./steps";
import type {
  AgentRuntimeSelection,
  DocumentAgentWorkflowInput,
  DocumentAgentWorkflowResult,
} from "./types";
import { agentLanguageModel } from "@/server/agent/language-model";

const durableToolHandlers = {
  readDocument: readDocumentToolStep,
  resolveSource: resolveSourceToolStep,
  applyDocumentPatch: applyDocumentPatchToolStep,
  checkDocument: checkDocumentToolStep,
  formatDocument: formatDocumentToolStep,
  requestInput: requestInputToolStep,
} satisfies DocumentToolHandlers;

function documentToolContext(
  input: DocumentAgentWorkflowInput,
): DocumentToolContext {
  return {
    documentId: input.documentId,
    runId: input.runId,
    actorId: input.userId,
  };
}

function unresolvedReviewQuestion(
  review: IndependentDocumentReview,
): string {
  const firstFinding = review.review.findings.find(
    (finding) =>
      finding.severity === "blocker" || finding.severity === "major",
  );
  return (
    review.question ??
    (firstFinding
      ? `${firstFinding.title}を解決するため、必要な情報や希望する方針を教えてください。`
      : "文書を完成させるために不足している情報を教えてください。")
  );
}

function createDurableAgent(
  input: DocumentAgentWorkflowInput,
  runtime: AgentRuntimeSelection,
  totalTokenBudget: number,
) {
  return createDocumentWorkflowAgent({
    model: agentLanguageModel(runtime.model),
    handlers: durableToolHandlers,
    context: documentToolContext(input),
    maxSteps: MAX_AGENT_STEPS,
    maxOutputTokens: Math.min(
      MAX_AGENT_OUTPUT_TOKENS_PER_STEP,
      totalTokenBudget,
    ),
    maxTotalTokens: totalTokenBudget,
    additionalInstructions: [
      "この実行では対象文書だけを扱い、少なくとも一度は現在の文書を読んでから判断する。",
    ],
  });
}

function inspectAgentExecution(
  result: {
    finishReason: string;
    steps: readonly {
      toolCalls: readonly { toolName: string }[];
      usage?: {
        totalTokens: number | undefined;
        inputTokens: number | undefined;
        outputTokens: number | undefined;
      };
    }[];
  },
  totalTokenBudget: number,
) {
  const evidence = documentAgentExecutionEvidence({
    finishReason: result.finishReason,
    steps: result.steps,
    maxSteps: MAX_AGENT_STEPS,
    maxTotalTokens: totalTokenBudget,
  });

  if (!evidence.usageMeasured) {
    throw new Error("Document agent token usage was unavailable.");
  }
  if (evidence.tokenBudgetExceeded) {
    throw new Error("Document agent exceeded its safe token budget.");
  }
  if (evidence.sourceToolLimitExceeded) {
    throw new Error("Document agent exceeded its safe source lookup limit.");
  }

  return evidence;
}

function assertCompletedAgentExecution(
  evidence: ReturnType<typeof inspectAgentExecution>,
) {
  if (!evidence.readObserved) {
    throw new Error("Document agent did not inspect the current document.");
  }
  if (evidence.reachedStepLimit) {
    throw new Error("Document agent reached the safe execution limit.");
  }
  if (evidence.tokenBudgetReached && !evidence.completedNaturally) {
    throw new Error("Document agent reached its safe token budget.");
  }
  if (!evidence.completedNaturally) {
    throw new Error("Document agent did not finish its work naturally.");
  }
  if (!evidence.checkObserved) {
    throw new Error("Document agent did not check the completed document.");
  }

  return evidence;
}

/**
 * A conversational edit run that answered a question without changing the
 * document has nothing to structurally re-check; it still must have read the
 * document and finished naturally.
 */
function assertAnswerOnlyAgentExecution(
  evidence: ReturnType<typeof inspectAgentExecution>,
) {
  if (!evidence.readObserved) {
    throw new Error("Document agent did not inspect the current document.");
  }
  if (evidence.reachedStepLimit) {
    throw new Error("Document agent reached the safe execution limit.");
  }
  if (evidence.tokenBudgetReached && !evidence.completedNaturally) {
    throw new Error("Document agent reached its safe token budget.");
  }
  if (!evidence.completedNaturally) {
    throw new Error("Document agent did not finish its work naturally.");
  }

  return evidence;
}

function remainingAgentTokenBudget(consumedTokens: number): number {
  const remaining = MAX_AGENT_TOTAL_TOKENS_PER_RUN - consumedTokens;
  if (remaining < 1) {
    throw new Error("Document agent reached its safe token budget.");
  }
  return remaining;
}

async function verifyDocumentRevision(
  input: DocumentAgentWorkflowInput,
  revision: number,
): Promise<void> {
  const context = documentToolContext(input);
  await readDocumentToolStep({ revision }, context);
  const checked = await checkDocumentToolStep(
    { revision, checks: ["structure", "references"] },
    context,
  );
  if (checked.revision !== revision || !checked.ok) {
    throw new Error("The completed document did not pass structural checks.");
  }
}

/**
 * Durable orchestration entrypoint. All persistence, model, compilation, and
 * artifact I/O happens in module-level step functions (or WorkflowAgent's
 * internally durable model/tool steps); this body only coordinates them.
 */
export async function runDocumentAgentWorkflow(
  input: DocumentAgentWorkflowInput,
): Promise<DocumentAgentWorkflowResult> {
  "use workflow";

  const ownsExecution = await activateDocumentRunWorkflowStep(
    input,
    getWorkflowMetadata().workflowRunId,
  );
  if (!ownsExecution) {
    return {
      status: "cancelled",
      runId: input.runId,
      documentId: input.documentId,
    };
  }

  try {
    const loaded = await loadDocumentRunStep(input);
    if (loaded.state === "completed") {
      return {
        status: "completed",
        runId: input.runId,
        documentId: input.documentId,
        revision: loaded.revision,
        artifact: loaded.artifact,
      };
    }
    if (loaded.state === "cancelled") {
      return {
        status: "cancelled",
        runId: input.runId,
        documentId: input.documentId,
      };
    }
    if (loaded.state === "failed") {
      return {
        status: "failed",
        runId: input.runId,
        documentId: input.documentId,
        message: loaded.message,
      };
    }
    await recordSemanticStageStep(
      input,
      "understanding",
      semanticEventKey(input.runId, "understanding"),
    );
    let revision = loaded.currentRevision;

    const runtime = await resolveAgentRuntimeStep();
    let consumedAgentTokens = 0;
    // The most recent agent closing message becomes the completed run's chat
    // reply. Repair rounds overwrite it so the note matches the final state.
    let closingNote: string | null = null;

    const promptContext = await resolveDocumentRunPromptStep(input);
    // Build-first autopilot: the brief always resolves without asking intake
    // questions, so the assessment is always ready.
    const briefAssessment = await assessDocumentBriefStep({
      workflow: input,
      promptContext,
      runtime,
    });

    await recordSemanticStageStep(
      input,
      "planning",
      semanticEventKey(input.runId, "planning"),
    );
    const documentPlan = briefAssessment.brief
      ? await createDocumentPlanStep({ workflow: input, runtime })
      : null;
    if (
      briefAssessment.brief &&
      briefAssessment.briefVersion !== null
    ) {
      const formatted = await applyConfirmedBriefLayoutStep({
        workflow: input,
        briefVersion: briefAssessment.briefVersion,
        baseRevision: revision,
      });
      if (formatted.status === "needs_input") {
        return {
          status: "needs_input",
          runId: input.runId,
          documentId: input.documentId,
          stage: "needs_input",
          question: formatted.question,
        };
      }
      revision = formatted.revision;
    }
    await recordSemanticStageStep(
      input,
      "writing",
      semanticEventKey(input.runId, "writing"),
    );

    const initialTokenBudget = remainingAgentTokenBudget(consumedAgentTokens);
    const durableAgent = createDurableAgent(
      input,
      runtime,
      initialTokenBudget,
    );
    const agentResult = await durableAgent.stream({
      prompt: buildInitialAgentPrompt({
        promptContext,
        documentId: input.documentId,
        currentRevision: revision,
        confirmedBrief: briefAssessment.brief
          ? {
              version: briefAssessment.briefVersion ?? 1,
              brief: briefAssessment.brief,
            }
          : null,
        documentPlan,
        targetNodeId: input.targetNodeId ?? null,
      }),
    });

    const current = await getRunDocumentRevisionStep(input);
    revision = current.revision;
    const evidence = inspectAgentExecution(agentResult, initialTokenBudget);
    consumedAgentTokens += evidence.totalTokens;
    closingNote =
      normalizeUserFacingResultNote(finalAssistantText(agentResult.steps)) ??
      closingNote;

    if (current.needsInput) {
      return {
        status: "needs_input",
        runId: input.runId,
        documentId: input.documentId,
        stage: "needs_input",
        question:
          current.question ??
          "続けるために必要な条件を教えてください。",
      };
    }

    const conversationalEditRun = briefAssessment.brief === null;
    if (!current.changed) {
      // Conversational edit runs may legitimately answer without editing;
      // everything else still needs an explicit no-change contract.
      if (conversationalEditRun) {
        assertAnswerOnlyAgentExecution(evidence);
      } else {
        assertCompletedAgentExecution(evidence);
      }
      const effectivePrompt = promptContext.effectivePrompt;
      if (
        revision < 1 ||
        (!conversationalEditRun &&
          !allowsUnchangedDocumentCompletion(effectivePrompt))
      ) {
        throw new Error(
          "Document agent completed without an applicable document change.",
        );
      }
    } else {
      assertCompletedAgentExecution(evidence);
      if (
        !evidence.patchObserved &&
        !(current.hasContent && evidence.formatObserved)
      ) {
        throw new Error(
          "Document revision changed without an observed document patch.",
        );
      }
    }

    if (
      briefAssessment.brief &&
      briefAssessment.briefVersion !== null
    ) {
      const formatted = await applyConfirmedBriefLayoutStep({
        workflow: input,
        briefVersion: briefAssessment.briefVersion,
        baseRevision: revision,
      });
      if (formatted.status === "needs_input") {
        return {
          status: "needs_input",
          runId: input.runId,
          documentId: input.documentId,
          stage: "needs_input",
          question: formatted.question,
        };
      }
      revision = formatted.revision;
    }

    await recordSemanticStageStep(
      input,
      "checking",
      semanticEventKey(input.runId, "checking"),
    );
    await verifyDocumentRevision(input, revision);

    let lastIndependentlyReviewedRevision: number | null = null;
    if (documentPlan && briefAssessment.brief) {
      let reviewRevisionAttempt = 0;
      while (true) {
        const independentReview = await reviewDocumentStep({
          workflow: input,
          revision,
          plan: documentPlan,
          runtime,
        });
        lastIndependentlyReviewedRevision = revision;
        const reviewAction = nextContentReviewAction({
          hasBlockingFindings: independentReview.hasBlockingFindings,
          hasBlockingQuestion: independentReview.question !== null,
          repairFindingCount: independentReview.repairFindings.length,
          repairAttempts: reviewRevisionAttempt,
        });
        if (reviewAction === "accept") break;

        if (reviewAction === "request_input") {
          const question = unresolvedReviewQuestion(independentReview);
          await markDocumentRunNeedsInputStep({
            workflow: input,
            question,
          });
          return {
            status: "needs_input",
            runId: input.runId,
            documentId: input.documentId,
            stage: "needs_input",
            question,
          };
        }

        if (reviewRevisionAttempt >= MAX_CONTENT_REVIEW_REVISIONS) {
          throw new Error("Content review exceeded its safe repair limit.");
        }
        reviewRevisionAttempt += 1;
        await recordSemanticStageStep(
          input,
          "writing",
          semanticEventKey(
            input.runId,
            "writing",
            `content-review-${reviewRevisionAttempt}`,
          ),
          { attempt: reviewRevisionAttempt },
        );
        const reviewTokenBudget = remainingAgentTokenBudget(consumedAgentTokens);
        const durableAgent = createDurableAgent(
          input,
          runtime,
          reviewTokenBudget,
        );
        const previousRevision = revision;
        const reviewRepair = await durableAgent.stream({
          prompt: buildInitialAgentPrompt({
            promptContext: {
              effectivePrompt: `独立レビューで次の重大な不足が見つかりました。要件と計画を変えずに修正してください。${buildReviewRepairInstructions(
                independentReview.review,
              )}`,
              clarification: null,
            },
            documentId: input.documentId,
            currentRevision: revision,
            confirmedBrief: {
              version: briefAssessment.briefVersion ?? 1,
              brief: briefAssessment.brief,
            },
            documentPlan,
          }),
        });
        const repaired = await getRunDocumentRevisionStep(input);
        revision = repaired.revision;
        const evidence = inspectAgentExecution(reviewRepair, reviewTokenBudget);
        consumedAgentTokens += evidence.totalTokens;
        closingNote =
          normalizeUserFacingResultNote(finalAssistantText(reviewRepair.steps)) ??
          closingNote;
        if (repaired.needsInput) {
          return {
            status: "needs_input",
            runId: input.runId,
            documentId: input.documentId,
            stage: "needs_input",
            question:
              repaired.question ??
              "文書を完成させるために必要な情報を教えてください。",
          };
        }
        assertCompletedAgentExecution(evidence);
        if (!evidence.patchObserved || revision <= previousRevision) {
          throw new Error(
            "Document review repair completed without an applicable change.",
          );
        }
        await recordSemanticStageStep(
          input,
          "checking",
          semanticEventKey(
            input.runId,
            "checking",
            `content-review-${reviewRevisionAttempt}`,
          ),
          { attempt: reviewRevisionAttempt },
        );
        await verifyDocumentRevision(input, revision);
      }
    }
    await recordSemanticStageStep(
      input,
      "formatting",
      semanticEventKey(input.runId, "formatting"),
    );

    let compileResult = await validateRenderCompileAndStoreStep({
      workflow: input,
      revision,
    });
    let repairAttempt = 0;

    while (!compileResult.ok) {
      await recordSemanticStageStep(
        input,
        "checking",
        semanticEventKey(
          input.runId,
          "checking",
          `compile-failure-${repairAttempt}`,
        ),
        {
          code: compileResult.code,
          attempt: repairAttempt,
          issueCount: compileResult.issueCount,
        },
      );

      if (nextCompileFailureAction({ repairAttempt }) === "fail") {
        throw new Error("Document preparation failed after safe retries.");
      }

      repairAttempt += 1;
      await recordSemanticStageStep(
        input,
        "writing",
        semanticEventKey(input.runId, "writing", `repair-${repairAttempt}`),
        { attempt: repairAttempt },
      );

      const repairTokenBudget = remainingAgentTokenBudget(consumedAgentTokens);
      const durableAgent = createDurableAgent(
        input,
        runtime,
        repairTokenBudget,
      );
      const previousRevision = revision;
      const repairResult = await durableAgent.stream({
        prompt: buildRepairAgentPrompt({
          documentId: input.documentId,
          currentRevision: revision,
          repairAttempt,
          confirmedBrief: briefAssessment.brief
            ? {
                version: briefAssessment.briefVersion ?? 1,
                brief: briefAssessment.brief,
              }
            : null,
          documentPlan,
          failure: {
            code: compileResult.code,
            issueCount: compileResult.issueCount,
            ...(compileResult.diagnostics
              ? { diagnostics: compileResult.diagnostics }
              : {}),
            ...(compileResult.pageTarget
              ? { pageTarget: compileResult.pageTarget }
              : {}),
            ...(compileResult.visualFindings
              ? { visualFindings: compileResult.visualFindings }
              : {}),
          },
        }),
      });

      const repaired = await getRunDocumentRevisionStep(input);
      revision = repaired.revision;
      const repairEvidence = inspectAgentExecution(
        repairResult,
        repairTokenBudget,
      );
      consumedAgentTokens += repairEvidence.totalTokens;
      closingNote =
        normalizeUserFacingResultNote(finalAssistantText(repairResult.steps)) ??
        closingNote;
      if (repaired.needsInput) {
        return {
          status: "needs_input",
          runId: input.runId,
          documentId: input.documentId,
          stage: "needs_input",
          question:
            repaired.question ??
            "続けるために必要な条件を教えてください。",
        };
      }
      assertCompletedAgentExecution(repairEvidence);
      if (
        !repairEvidence.patchObserved ||
        repaired.revision <= previousRevision
      ) {
        throw new Error(
          "Document repair completed without an applicable document change.",
        );
      }
      await recordSemanticStageStep(
        input,
        "checking",
        semanticEventKey(input.runId, "checking", `repair-${repairAttempt}`),
        { attempt: repairAttempt },
      );
      await verifyDocumentRevision(input, revision);
      await recordSemanticStageStep(
        input,
        "formatting",
        semanticEventKey(input.runId, "formatting", `repair-${repairAttempt}`),
        { attempt: repairAttempt },
      );
      compileResult = await validateRenderCompileAndStoreStep({
        workflow: input,
        revision,
      });
    }

    if (
      documentPlan &&
      briefAssessment.brief &&
      needsIndependentReviewAfterCompilation({
        lastReviewedRevision: lastIndependentlyReviewedRevision,
        compiledRevision: compileResult.revision,
      })
    ) {
      const finalReview = await reviewDocumentStep({
        workflow: input,
        revision: compileResult.revision,
        plan: documentPlan,
        runtime,
      });
      if (finalReview.hasBlockingFindings) {
        const question = unresolvedReviewQuestion(finalReview);
        await markDocumentRunNeedsInputStep({
          workflow: input,
          question,
        });
        return {
          status: "needs_input",
          runId: input.runId,
          documentId: input.documentId,
          stage: "needs_input",
          question,
        };
      }
    }

    const artifact = await completeDocumentRunStep({
      workflow: input,
      revision: compileResult.revision,
      artifact: compileResult.release,
      eventKey: semanticEventKey(input.runId, "ready"),
      resultNote: closingNote,
    });

    return {
      status: "completed",
      runId: input.runId,
      documentId: input.documentId,
      revision: compileResult.revision,
      artifact,
    };
  } catch (error) {
    try {
      await failDocumentRunStep({
        workflow: input,
        code: safeWorkflowFailureCode(error),
        message: safeWorkflowFailureMessage(error),
      });
    } catch {
      // Preserve the original workflow error if failure persistence is down.
    }
    throw error;
  }
}
