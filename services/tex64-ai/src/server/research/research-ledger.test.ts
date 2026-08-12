import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  validateDocument,
  type DocumentModel,
} from "@/domain/document";
import { DocumentPlanSchema, type DocumentPlan } from "@/domain/plan";
import { SourceRecordSchema, type SourceRecord } from "@/server/sources";

import {
  buildResearchLedger,
  validateResearchLedgerAgainstContext,
  type ResearchLedgerContext,
} from "./ledger";
import type { ResearchEvidenceDraft } from "./schema";

const NOW = "2026-08-08T00:00:00.000Z";
const USER_ID = "70000000-0000-4000-8000-000000000001";
const RUN_ID = "70000000-0000-4000-8000-000000000002";
const REVIEW_RUN_ID = "70000000-0000-4000-8000-000000000003";
const PLAN_ID = "70000000-0000-4000-8000-000000000004";
const SECTION_ID = "70000000-0000-4000-8000-000000000005";
const CLAIM_ID = "70000000-0000-4000-8000-000000000006";
const REQUIREMENT_ID = "70000000-0000-4000-8000-000000000007";
const SECTION_CRITERION_ID = "70000000-0000-4000-8000-000000000008";
const PLAN_CRITERION_ID = "70000000-0000-4000-8000-000000000009";
const SOURCE_ID = "70000000-0000-4000-8000-000000000010";
const SOURCE_URL = "https://example.com/reliable-structured-editing";
const CLAIM_TEXT = "構造化編集は再現性を高めます";
const SOURCE_EXCERPT = "構造化編集は再現性を高めます";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function researchDocument(text = `${CLAIM_TEXT}。補足情報も参照できます。`): DocumentModel {
  const document = structuredClone(SAMPLE_DOCUMENT);
  const citation = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.citation,
  );
  const paragraph = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.citedParagraph,
  );
  if (!citation || citation.type !== "citation" || !paragraph || paragraph.type !== "paragraph") {
    throw new Error("Research fixture is incomplete.");
  }
  citation.sourceId = SOURCE_ID;
  paragraph.content = [
    { type: "text", text, marks: [] },
    {
      type: "citationRef",
      citationId: SAMPLE_DOCUMENT_IDS.citation,
      locator: "p. 42",
    },
  ];
  document.metadata.updatedAt = NOW;
  return validateDocument(document);
}

function researchPlan(input?: {
  kinds?: DocumentPlan["sections"][number]["sourceRequirements"][number]["sourceKinds"];
  dateRange?: string | null;
  minimumCount?: number;
}): DocumentPlan {
  return DocumentPlanSchema.parse({
    schemaVersion: 1,
    id: PLAN_ID,
    documentId: SAMPLE_DOCUMENT.id,
    briefVersion: 2,
    briefDigest: "a".repeat(64),
    status: "completed",
    version: 1,
    objective: "構造化編集の再現性を根拠とともに説明する。",
    sections: [
      {
        id: SECTION_ID,
        title: "はじめに",
        objective: "再現性に関する主張を説明する。",
        expectedAmount: {
          unit: "characters",
          minimum: 1,
          target: 100,
          maximum: 1_000,
        },
        researchClaims: [
          {
            id: CLAIM_ID,
            statement: CLAIM_TEXT,
            researchPurpose: "主要な効果を裏付ける。",
            priority: "required",
            sourceRequirementIds: [REQUIREMENT_ID],
          },
        ],
        sourceRequirements: [
          {
            id: REQUIREMENT_ID,
            purpose: "再現性向上の根拠",
            minimumCount: input?.minimumCount ?? 1,
            sourceKinds: input?.kinds ?? ["peer_reviewed"],
            dateRange: input?.dateRange ?? "2025-2026",
            requiredLocators: [SOURCE_URL],
          },
        ],
        mathematics: { policy: "none", items: [] },
        visuals: [],
        completionCriteria: [
          {
            id: SECTION_CRITERION_ID,
            statement: "主要な主張に根拠がある。",
            verification: "model_assessed",
            severity: "required",
            briefCriterionId: null,
          },
        ],
      },
    ],
    completionCriteria: [
      {
        id: PLAN_CRITERION_ID,
        statement: "文書全体の根拠が確認できる。",
        verification: "model_assessed",
        severity: "required",
        briefCriterionId: null,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function source(input?: {
  workType?: SourceRecord["metadata"]["workType"];
  publishedAt?: string;
  content?: string;
}): SourceRecord {
  const content = input?.content ?? `調査では、${SOURCE_EXCERPT}。`;
  return SourceRecordSchema.parse({
    schemaVersion: 1,
    id: SOURCE_ID,
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    kind: "https",
    canonicalLocator: SOURCE_URL,
    resolvedLocator: SOURCE_URL,
    verification: "verified_content",
    evidenceScope: "full_text",
    contentText: content,
    contentSha256: sha256(content),
    metadata: {
      provider: "origin",
      title: "Reliable Structured Editing",
      authors: [],
      publication: "Journal of Documents",
      workType: input?.workType ?? "journal_article",
      publishedAt: input?.publishedAt ?? "2026-01-15",
      contentType: "text/html",
    },
    fetchedAt: NOW,
  });
}

function context(input?: {
  document?: DocumentModel;
  plan?: DocumentPlan;
  sources?: SourceRecord[];
}): ResearchLedgerContext {
  return {
    userId: USER_ID,
    document: input?.document ?? researchDocument(),
    documentRevision: 2,
    briefVersion: 2,
    briefDigest: "a".repeat(64),
    plan: input?.plan ?? researchPlan(),
    authoringRunId: RUN_ID,
    reviewer: {
      provider: "AI Gateway",
      model: "independent-review-model",
      reviewRunId: REVIEW_RUN_ID,
    },
    sources: input?.sources ?? [source()],
    createdAt: NOW,
  };
}

function supportedDraft(input?: {
  realizationExcerpt?: string;
  alignment?: "matches" | "does_not_match" | "uncertain";
  outcome?: "supports" | "contradicts" | "insufficient";
  duplicate?: boolean;
}): ResearchEvidenceDraft {
  const evidence = {
    sourceId: SOURCE_ID,
    excerpt: SOURCE_EXCERPT,
    outcome: input?.outcome ?? "supports",
    rationale: "資料の記述が本文の主張を直接裏付ける。",
    sourceKinds: ["peer_reviewed" as const],
  };
  return {
    claims: [
      {
        claimId: CLAIM_ID,
        rationale: "本文の主張と資料を照合した。",
        realization: {
          nodeId: SAMPLE_DOCUMENT_IDS.citedParagraph,
          excerpt: input?.realizationExcerpt ?? CLAIM_TEXT,
          alignment: input?.alignment ?? "matches",
          rationale: "本文が計画上の主張を具体的に記述している。",
        },
        evidence: input?.duplicate ? [evidence, evidence] : [evidence],
      },
    ],
  };
}

describe("immutable claim-to-evidence research review", () => {
  it("passes only when exact manuscript text, its citation, and supporting source agree", () => {
    const ledger = buildResearchLedger({
      context: context(),
      draft: supportedDraft(),
    });

    expect(ledger.status).toBe("passed");
    expect(ledger.claims[0]).toMatchObject({
      claimId: CLAIM_ID,
      outcome: "supported",
      realization: {
        nodeId: SAMPLE_DOCUMENT_IDS.citedParagraph,
        excerpt: CLAIM_TEXT,
      },
    });
    expect(ledger.requirements[0]).toMatchObject({
      status: "passed",
      uniqueSupportingSourceIds: [SOURCE_ID],
    });
  });

  it("does not let the same source inflate a minimum or appear twice for one claim", () => {
    expect(() =>
      buildResearchLedger({
        context: context({ plan: researchPlan({ minimumCount: 2 }) }),
        draft: supportedDraft({ duplicate: true }),
      }),
    ).toThrow("cannot be counted twice");

    const oneSource = buildResearchLedger({
      context: context({ plan: researchPlan({ minimumCount: 2 }) }),
      draft: supportedDraft(),
    });
    expect(oneSource.status).toBe("blocked");
    expect(oneSource.requirements[0]?.uniqueSupportingSourceIds).toEqual([
      SOURCE_ID,
    ]);
  });

  it("blocks unrelated or failed entailment instead of accepting topical overlap", () => {
    const ledger = buildResearchLedger({
      context: context(),
      draft: supportedDraft({ outcome: "insufficient" }),
    });

    expect(ledger.status).toBe("blocked");
    expect(ledger.claims[0]?.outcome).toBe("not_supported");
    expect(ledger.requirements[0]?.countStatus).toBe("failed");
  });

  it("fails a generic-plan substitution when the quoted claim is absent from the manuscript", () => {
    const falseDocument = researchDocument(
      "構造化編集は再現性を低下させます。",
    );
    expect(() =>
      buildResearchLedger({
        context: context({ document: falseDocument }),
        draft: supportedDraft({ realizationExcerpt: CLAIM_TEXT }),
      }),
    ).toThrow("not part of the frozen manuscript text");

    const correctlyDetectedMismatch = buildResearchLedger({
      context: context({ document: falseDocument }),
      draft: supportedDraft({
        realizationExcerpt: "構造化編集は再現性を低下させます",
        alignment: "does_not_match",
        outcome: "insufficient",
      }),
    });
    expect(correctlyDetectedMismatch.status).toBe("blocked");
    expect(correctlyDetectedMismatch.claims[0]?.outcome).toBe("not_supported");
  });

  it("checks source kind and date from provider metadata when available", () => {
    const ledger = buildResearchLedger({
      context: context({
        sources: [source({ workType: "web", publishedAt: "2020-01-01" })],
      }),
      draft: supportedDraft(),
    });

    expect(ledger.status).toBe("blocked");
    expect(ledger.requirements[0]).toMatchObject({
      kindStatus: "failed",
      dateStatus: "failed",
    });
  });

  it("rejects ledger, source, and manuscript tampering on replay", () => {
    const originalContext = context();
    const ledger = buildResearchLedger({
      context: originalContext,
      draft: supportedDraft(),
    });
    const digestTamper = structuredClone(ledger);
    digestTamper.claims[0]!.bindings[0]!.excerpt = "改ざん";
    expect(() =>
      validateResearchLedgerAgainstContext({
        ledger: digestTamper,
        context: originalContext,
      }),
    ).toThrow("digest does not match");

    const changedSource = source({
      content: `別の調査では、${SOURCE_EXCERPT}。`,
    });
    expect(() =>
      validateResearchLedgerAgainstContext({
        ledger,
        context: context({ sources: [changedSource] }),
      }),
    ).toThrow("does not match its review target");

    const changedDocument = researchDocument(
      `${CLAIM_TEXT}が、条件によって結果は異なります。`,
    );
    expect(() =>
      validateResearchLedgerAgainstContext({
        ledger,
        context: context({ document: changedDocument }),
      }),
    ).toThrow("does not match its review target");
  });
});
