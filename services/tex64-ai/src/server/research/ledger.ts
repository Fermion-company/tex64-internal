import { createHash } from "node:crypto";

import { deterministicBriefId } from "@/domain/brief";
import {
  type AlgorithmStepModel,
  type DocumentModel,
  type DocumentNode,
  type InlineContent,
  type ListItemModel,
} from "@/domain/document";
import {
  DocumentPlanSchema,
  type DocumentPlan,
  type PlanSourceRequirement,
} from "@/domain/plan";
import {
  createReviewDocumentDigest,
} from "@/domain/review";
import {
  SourceRecordSchema,
  canSourceSupportClaims,
  canonicalizeSourceLocator,
  type SourceRecord,
} from "@/server/sources";

import {
  assertResearchLedgerDigest,
  canonicalResearchDigest,
  createResearchLedgerDigest,
} from "./digest";
import {
  FrozenResearchSourceSchema,
  FrozenResearchDocumentNodeSchema,
  ResearchEvidenceDraftSchema,
  ResearchLedgerSchema,
  type FrozenResearchSource,
  type FrozenResearchDocumentNode,
  type ResearchClaimAssessment,
  type ResearchClaimRealization,
  type ResearchEvidenceBinding,
  type ResearchEvidenceDraft,
  type ResearchLedger,
  type ResearchSourceRequirementAssessment,
} from "./schema";

const MAX_FROZEN_SOURCE_CHARS = 12_000;
const MAX_FROZEN_SOURCE_TOTAL_CHARS = 120_000;
type RequiredSourceKind = PlanSourceRequirement["sourceKinds"][number];

export type ResearchLedgerContext = {
  userId: string;
  document: DocumentModel;
  documentRevision: number;
  briefVersion: number;
  briefDigest: string;
  plan: DocumentPlan;
  authoringRunId: string;
  reviewer: {
    provider: string;
    model: string;
    reviewRunId: string;
  };
  sources: readonly SourceRecord[];
  createdAt: string;
};

export function freezeResearchSources(
  sources: readonly SourceRecord[],
): FrozenResearchSource[] {
  const verified = [...sources]
    .map((rawSource) => SourceRecordSchema.parse(rawSource))
    .filter(canSourceSupportClaims)
    .sort((left, right) => left.id.localeCompare(right.id));
  const excerptLimit = Math.min(
    MAX_FROZEN_SOURCE_CHARS,
    Math.floor(MAX_FROZEN_SOURCE_TOTAL_CHARS / Math.max(verified.length, 1)),
  );
  return verified.map((source) =>
      FrozenResearchSourceSchema.parse({
        sourceId: source.id,
        canonicalLocator: source.canonicalLocator,
        contentSha256: source.contentSha256,
        evidenceScope: source.evidenceScope,
        excerpt: source.contentText!.slice(0, excerptLimit),
        excerptStart: 0,
        metadata: {
          provider: source.metadata.provider,
          title: source.metadata.title ?? null,
          publication: source.metadata.publication ?? null,
          publisher: source.metadata.publisher ?? null,
          volume: source.metadata.volume ?? null,
          issue: source.metadata.issue ?? null,
          pages: source.metadata.pages ?? null,
          publishedAt: source.metadata.publishedAt ?? null,
          workType: source.metadata.workType ?? null,
        },
      }),
    );
}

export function freezeResearchDocumentNodes(
  document: DocumentModel,
): FrozenResearchDocumentNode[] {
  const citationSourceById = new Map(
    document.nodes.flatMap((node) =>
      node.type === "citation" && node.sourceId
        ? [[node.id, node.sourceId] as const]
        : [],
    ),
  );
  const candidates = document.nodes.flatMap((node) => {
    const extracted = researchNodeContent(node, citationSourceById);
    const text = extracted.text.trim();
    const citedSourceIds = [...new Set(extracted.citedSourceIds)].sort();
    return text && citedSourceIds.length > 0
      ? [{ node, text, citedSourceIds }]
      : [];
  });
  const textLimit = Math.min(
    MAX_FROZEN_SOURCE_CHARS,
    Math.floor(MAX_FROZEN_SOURCE_TOTAL_CHARS / Math.max(candidates.length, 1)),
  );
  return candidates.map(({ node, text, citedSourceIds }) => {
    const frozenText = text.slice(0, textLimit).trim();
    return FrozenResearchDocumentNodeSchema.parse({
      nodeId: node.id,
      nodeType: node.type,
      text: frozenText,
      textSha256: digestText(frozenText),
      citedSourceIds,
    });
  });
}

function createResearchSourceSnapshotDigest(
  sources: readonly SourceRecord[],
): string {
  const normalized = [...sources]
    .map((rawSource) => SourceRecordSchema.parse(rawSource))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => ({
      id: source.id,
      userId: source.userId,
      documentId: source.documentId,
      canonicalLocator: source.canonicalLocator,
      resolvedLocator: source.resolvedLocator,
      verification: source.verification,
      evidenceScope: source.evidenceScope,
      contentSha256: source.contentSha256,
      metadata: source.metadata,
      fetchedAt: source.fetchedAt,
    }));
  return canonicalResearchDigest(normalized);
}

export function researchPlanDigest(plan: DocumentPlan | unknown): string {
  return canonicalResearchDigest(DocumentPlanSchema.parse(plan));
}

export function createResearchLedgerId(
  rawContext: ResearchLedgerContext,
): string {
  const context = parsedContext(rawContext);
  return deterministicBriefId(
    `${context.authoringRunId}:research:${canonicalResearchDigest({
      target: researchLedgerTarget(context),
      reviewer: context.reviewer,
    })}`,
  );
}

export function buildResearchLedger(input: {
  context: ResearchLedgerContext;
  draft: ResearchEvidenceDraft | unknown;
}): ResearchLedger {
  const context = parsedContext(input.context);
  const draft = ResearchEvidenceDraftSchema.parse(input.draft);
  const sourceById = new Map(context.sources.map((source) => [source.id, source]));
  const frozenSourceById = new Map(
    freezeResearchSources(context.sources).map((source) => [
      source.sourceId,
      source,
    ]),
  );
  const frozenNodeById = new Map(
    freezeResearchDocumentNodes(context.document).map((node) => [
      node.nodeId,
      node,
    ]),
  );
  const sourceSnapshot = researchSourceSnapshot(context.document, context.sources);
  const draftByClaimId = uniqueDrafts(draft);
  const planClaims = context.plan.sections.flatMap((section) =>
    section.researchClaims.map((claim) => ({ claim, section })),
  );
  const planClaimIds = new Set(planClaims.map(({ claim }) => claim.id));
  for (const claimId of draftByClaimId.keys()) {
    if (!planClaimIds.has(claimId)) {
      throw new Error("Research evidence assessed a claim outside the approved plan.");
    }
  }

  const bindingsByClaimId = new Map<string, ResearchEvidenceBinding[]>();
  const realizationByClaimId = new Map<string, ResearchClaimRealization | null>();
  for (const { claim } of planClaims) {
    const claimDraft = draftByClaimId.get(claim.id);
    const realization = claimDraft?.realization
      ? buildClaimRealization({
          claimId: claim.id,
          draft: claimDraft.realization,
          frozenNodeById,
        })
      : null;
    if (!realization && claimDraft && claimDraft.evidence.length > 0) {
      throw new Error("Research evidence must identify the exact manuscript claim it supports.");
    }
    const bindings = claimDraft
      ? buildBindings({
          claimId: claim.id,
          evidence: claimDraft.evidence,
          sourceById,
          frozenSourceById,
          citedSourceIds: new Set(realization?.citedSourceIds ?? []),
          plan: context.plan,
        })
      : [];
    realizationByClaimId.set(claim.id, realization);
    bindingsByClaimId.set(claim.id, bindings);
  }

  const requirements = buildRequirementAssessments({
    plan: context.plan,
    bindingsByClaimId,
    sourceById,
    createdAt: context.createdAt,
  });
  const requirementById = new Map(
    requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  const claims: ResearchClaimAssessment[] = planClaims.map(({ claim }) => {
    const bindings = bindingsByClaimId.get(claim.id) ?? [];
    const realization = realizationByClaimId.get(claim.id) ?? null;
    const linkedRequirements = claim.sourceRequirementIds.flatMap(
      (requirementId) => {
        const requirement = requirementById.get(requirementId);
        return requirement ? [requirement] : [];
      },
    );
    const outcome = claimOutcome(realization, bindings, linkedRequirements);
    return {
      claimId: claim.id,
      priority: claim.priority,
      sourceRequirementIds: claim.sourceRequirementIds,
      realization,
      bindings,
      outcome,
      rationale:
        draftByClaimId.get(claim.id)?.rationale ??
        "この主張を確認できる根拠が見つかりませんでした。",
    };
  });

  const target = researchLedgerTarget(context);
  const status =
    sourceSnapshot.status === "blocked" ||
    claims.some(
      (claim) => claim.priority === "required" && claim.outcome !== "supported",
    ) || requirements.some((requirement) => requirement.status !== "passed")
      ? "blocked"
      : "passed";
  const id = createResearchLedgerId(context);
  const unsigned: Omit<ResearchLedger, "ledgerDigest"> = {
    schemaVersion: 1,
    id,
    userId: context.userId,
    documentId: context.document.id,
    authoringRunId: context.authoringRunId,
    target,
    reviewer: context.reviewer,
    sourceSnapshot,
    claims,
    requirements,
    status,
    createdAt: context.createdAt,
  };
  return assertResearchLedgerDigest({
    ...unsigned,
    ledgerDigest: createResearchLedgerDigest(unsigned),
  });
}

export function validateResearchLedgerAgainstContext(input: {
  ledger: ResearchLedger | unknown;
  context: ResearchLedgerContext;
}): ResearchLedger {
  const ledger = assertResearchLedgerDigest(input.ledger);
  const context = parsedContext(input.context);
  const expectedTarget = researchLedgerTarget(context);
  if (
    ledger.userId !== context.userId ||
    ledger.documentId !== context.document.id ||
    ledger.authoringRunId !== context.authoringRunId ||
    canonicalResearchDigest(ledger.target) !==
      canonicalResearchDigest(expectedTarget)
  ) {
    throw new Error("Research evidence ledger does not match its review target.");
  }
  if (
    ledger.reviewer.provider !== context.reviewer.provider ||
    ledger.reviewer.model !== context.reviewer.model ||
    ledger.reviewer.reviewRunId !== context.reviewer.reviewRunId
  ) {
    throw new Error("Research evidence ledger reviewer does not match its review target.");
  }

  const sourceById = new Map(context.sources.map((source) => [source.id, source]));
  const expectedClaims = context.plan.sections.flatMap((section) =>
    section.researchClaims,
  );
  const expectedClaimById = new Map(
    expectedClaims.map((claim) => [claim.id, claim]),
  );
  if (ledger.claims.length !== expectedClaims.length) {
    throw new Error("Research evidence ledger omitted an approved plan claim.");
  }
  for (const claim of ledger.claims) {
    const expectedClaim = expectedClaimById.get(claim.claimId);
    if (
      !expectedClaim ||
      claim.priority !== expectedClaim.priority ||
      canonicalResearchDigest(claim.sourceRequirementIds) !==
        canonicalResearchDigest(expectedClaim.sourceRequirementIds)
    ) {
      throw new Error("Research claim assessment does not match the approved plan.");
    }
    if (claim.realization) {
      assertRealizationMatchesDocument(claim.realization, context.document);
    }
    for (const binding of claim.bindings) {
      assertBindingMatchesSource(binding, sourceById.get(binding.sourceId));
      if (!claim.realization?.citedSourceIds.includes(binding.sourceId)) {
        throw new Error("Research evidence is not cited by its manuscript claim.");
      }
    }
  }
  const bindingsByClaimId = new Map(
    ledger.claims.map((claim) => [claim.claimId, claim.bindings]),
  );
  const recomputedRequirements = buildRequirementAssessments({
    plan: context.plan,
    bindingsByClaimId,
    sourceById,
    createdAt: context.createdAt,
  });
  if (
    canonicalResearchDigest(ledger.requirements) !==
    canonicalResearchDigest(recomputedRequirements)
  ) {
    throw new Error("Research source requirement results are not reproducible.");
  }
  const requirementById = new Map(
    recomputedRequirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  for (const claim of ledger.claims) {
    const linkedRequirements = claim.sourceRequirementIds.flatMap(
      (requirementId) => {
        const requirement = requirementById.get(requirementId);
        return requirement ? [requirement] : [];
      },
    );
    if (
      claim.outcome !==
      claimOutcome(claim.realization, claim.bindings, linkedRequirements)
    ) {
      throw new Error("Research claim outcome is not reproducible.");
    }
  }
  if (
    canonicalResearchDigest(ledger.sourceSnapshot) !==
    canonicalResearchDigest(researchSourceSnapshot(context.document, context.sources))
  ) {
    throw new Error("Research source availability no longer matches its review target.");
  }
  const expectedStatus =
    ledger.sourceSnapshot.status === "blocked" ||
    ledger.claims.some(
      (claim) => claim.priority === "required" && claim.outcome !== "supported",
    ) ||
    ledger.requirements.some((requirement) => requirement.status !== "passed")
      ? "blocked"
      : "passed";
  if (ledger.status !== expectedStatus) {
    throw new Error("Research evidence ledger status is not reproducible.");
  }
  return ledger;
}

function parsedContext(input: ResearchLedgerContext): ResearchLedgerContext {
  const plan = DocumentPlanSchema.parse(input.plan);
  const sources = input.sources.map((source) => SourceRecordSchema.parse(source));
  if (plan.documentId !== input.document.id) {
    throw new Error("Research plan and document do not identify the same target.");
  }
  if (
    sources.some(
      (source) =>
        source.userId !== input.userId || source.documentId !== input.document.id,
    )
  ) {
    throw new Error("Research sources are outside the active document scope.");
  }
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error("Research source snapshots must be unique.");
  }
  return { ...input, plan, sources };
}

function researchLedgerTarget(
  context: ResearchLedgerContext,
): ResearchLedger["target"] {
  return {
    documentRevision: context.documentRevision,
    documentDigest: createReviewDocumentDigest(context.document),
    briefVersion: context.briefVersion,
    briefDigest: context.briefDigest,
    planId: context.plan.id,
    planVersion: context.plan.version,
    planDigest: researchPlanDigest(context.plan),
    sourceSnapshotDigest: createResearchSourceSnapshotDigest(context.sources),
  };
}

function researchSourceSnapshot(
  document: DocumentModel,
  sources: readonly SourceRecord[],
): ResearchLedger["sourceSnapshot"] {
  const citedSourceIds = [
    ...new Set(
      document.nodes.flatMap((node) =>
        node.type === "citation" && node.sourceId ? [node.sourceId] : [],
      ),
    ),
  ].sort();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const unavailableSourceIds = citedSourceIds.filter(
    (sourceId) => !sourceById.has(sourceId),
  );
  const nonEvidenceSourceIds = citedSourceIds.filter((sourceId) => {
    const source = sourceById.get(sourceId);
    return source ? !canSourceSupportClaims(source) : false;
  });
  return {
    status:
      unavailableSourceIds.length > 0 || nonEvidenceSourceIds.length > 0
        ? "blocked"
        : "complete",
    citedSourceIds,
    unavailableSourceIds,
    nonEvidenceSourceIds,
  };
}

function uniqueDrafts(draft: ResearchEvidenceDraft) {
  const byClaimId = new Map<string, ResearchEvidenceDraft["claims"][number]>();
  for (const claim of draft.claims) {
    if (byClaimId.has(claim.claimId)) {
      throw new Error("Research evidence assessed one claim more than once.");
    }
    byClaimId.set(claim.claimId, claim);
  }
  return byClaimId;
}

function buildClaimRealization(input: {
  claimId: string;
  draft: NonNullable<ResearchEvidenceDraft["claims"][number]["realization"]>;
  frozenNodeById: ReadonlyMap<string, FrozenResearchDocumentNode>;
}): ResearchClaimRealization {
  const node = input.frozenNodeById.get(input.draft.nodeId);
  if (!node) {
    throw new Error("The reviewed manuscript claim is unavailable or has no tied citation.");
  }
  const start = node.text.indexOf(input.draft.excerpt);
  if (start < 0) {
    throw new Error("The reviewed claim excerpt is not part of the frozen manuscript text.");
  }
  return {
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    excerpt: input.draft.excerpt,
    excerptSha256: digestText(input.draft.excerpt),
    location: { start, end: start + input.draft.excerpt.length },
    citedSourceIds: node.citedSourceIds,
    alignment: {
      outcome: input.draft.alignment,
      rationale: input.draft.rationale,
    },
  };
}

function buildBindings(input: {
  claimId: string;
  evidence: ResearchEvidenceDraft["claims"][number]["evidence"];
  sourceById: ReadonlyMap<string, SourceRecord>;
  frozenSourceById: ReadonlyMap<string, FrozenResearchSource>;
  citedSourceIds: ReadonlySet<string>;
  plan: DocumentPlan;
}): ResearchEvidenceBinding[] {
  const sourceIds = new Set<string>();
  return input.evidence.map((draft, index) => {
    if (sourceIds.has(draft.sourceId)) {
      throw new Error("A source cannot be counted twice for one research claim.");
    }
    sourceIds.add(draft.sourceId);
    const source = input.sourceById.get(draft.sourceId);
    const frozenSource = input.frozenSourceById.get(draft.sourceId);
    if (!source || !frozenSource || !canSourceSupportClaims(source)) {
      throw new Error("Research evidence must use a verified source snapshot.");
    }
    if (!input.citedSourceIds.has(source.id)) {
      throw new Error("Research evidence must be cited by the reviewed document.");
    }
    const frozenOffset = frozenSource.excerpt.indexOf(draft.excerpt);
    if (frozenOffset < 0) {
      throw new Error("Research evidence excerpt is not part of the frozen source excerpt.");
    }
    const offset = frozenSource.excerptStart + frozenOffset;
    const derivedKinds = deterministicSourceKinds(source, input.plan);
    const sourceKinds =
      derivedKinds.kinds.length > 0
        ? derivedKinds.kinds
        : uniqueKinds(draft.sourceKinds);
    const basis = derivedKinds.basis ?? "independent_review";
    return {
      id: deterministicBriefId(
        `${input.claimId}:${draft.sourceId}:${index}:${source.contentSha256}:${offset}:${draft.outcome}`,
      ),
      claimId: input.claimId,
      sourceId: source.id,
      canonicalLocator: source.canonicalLocator,
      contentSha256: source.contentSha256!,
      excerpt: draft.excerpt,
      excerptSha256: digestText(draft.excerpt),
      location: {
        kind: "text_offset",
        start: offset,
        end: offset + draft.excerpt.length,
      },
      sourceKinds,
      kindAssessmentBasis: basis,
      entailment: {
        outcome: draft.outcome,
        rationale: draft.rationale,
      },
    };
  });
}

function buildRequirementAssessments(input: {
  plan: DocumentPlan;
  bindingsByClaimId: ReadonlyMap<string, ResearchEvidenceBinding[]>;
  sourceById: ReadonlyMap<string, SourceRecord>;
  createdAt: string;
}): ResearchSourceRequirementAssessment[] {
  const requirementToClaims = new Map<string, string[]>();
  for (const section of input.plan.sections) {
    for (const claim of section.researchClaims) {
      for (const requirementId of claim.sourceRequirementIds) {
        const claims = requirementToClaims.get(requirementId) ?? [];
        claims.push(claim.id);
        requirementToClaims.set(requirementId, claims);
      }
    }
  }
  return input.plan.sections.flatMap((section) =>
    section.sourceRequirements.map((requirement) => {
      const bindings = (requirementToClaims.get(requirement.id) ?? []).flatMap(
        (claimId) => input.bindingsByClaimId.get(claimId) ?? [],
      );
      return assessRequirement({
        requirement,
        bindings,
        sourceById: input.sourceById,
        createdAt: input.createdAt,
      });
    }),
  );
}

function assessRequirement(input: {
  requirement: PlanSourceRequirement;
  bindings: readonly ResearchEvidenceBinding[];
  sourceById: ReadonlyMap<string, SourceRecord>;
  createdAt: string;
}): ResearchSourceRequirementAssessment {
  const supporting = uniqueSupportingBindings(input.bindings);
  const supportingIds = supporting.map((binding) => binding.sourceId).sort();
  const countStatus =
    supportingIds.length >= input.requirement.minimumCount ? "passed" : "failed";

  const kindMatches = supporting.filter((binding) =>
    binding.sourceKinds.some((kind) => input.requirement.sourceKinds.includes(kind)),
  );
  const kindStatus =
    kindMatches.length >= input.requirement.minimumCount
      ? "passed"
      : supporting.some((binding) => binding.sourceKinds.length === 0)
        ? "not_evaluable"
        : "failed";

  const dateStatus = assessDateRange({
    constraint: input.requirement.dateRange,
    sources: supporting.flatMap((binding) => {
      const source = input.sourceById.get(binding.sourceId);
      return source ? [source] : [];
    }),
    minimumCount: input.requirement.minimumCount,
    createdAt: input.createdAt,
  });

  const normalizedRequiredLocators = input.requirement.requiredLocators.map(
    normalizeRequiredLocator,
  );
  const supportingLocators = new Set(
    supporting.map((binding) => binding.canonicalLocator),
  );
  const matchedLocators = normalizedRequiredLocators.filter((locator) =>
    supportingLocators.has(locator),
  );
  const locatorStatus =
    normalizedRequiredLocators.length === 0
      ? "not_applicable"
      : matchedLocators.length === normalizedRequiredLocators.length
        ? "passed"
        : "failed";

  const checks = [countStatus, kindStatus, dateStatus, locatorStatus];
  const status = checks.includes("failed")
    ? "failed"
    : checks.includes("not_evaluable")
      ? "not_evaluable"
      : "passed";
  return {
    requirementId: input.requirement.id,
    minimumCount: input.requirement.minimumCount,
    uniqueSupportingSourceIds: supportingIds,
    countStatus,
    kindStatus,
    dateStatus,
    locatorStatus,
    requiredLocators: input.requirement.requiredLocators,
    matchedLocators,
    status,
    detail:
      status === "passed"
        ? "必要な資料と根拠を確認しました。"
        : "主張を支える資料の件数、種類、期間、または指定資料を確認できませんでした。",
  };
}

function uniqueSupportingBindings(
  bindings: readonly ResearchEvidenceBinding[],
): ResearchEvidenceBinding[] {
  const bySourceId = new Map<string, ResearchEvidenceBinding>();
  for (const binding of bindings) {
    if (
      binding.entailment.outcome === "supports" &&
      !bySourceId.has(binding.sourceId)
    ) {
      bySourceId.set(binding.sourceId, binding);
    }
  }
  return [...bySourceId.values()];
}

function assessDateRange(input: {
  constraint: string | null;
  sources: readonly SourceRecord[];
  minimumCount: number;
  createdAt: string;
}): ResearchSourceRequirementAssessment["dateStatus"] {
  if (!input.constraint) return "not_applicable";
  const parsed = parseRequiredDateRange(input.constraint, input.createdAt);
  if (parsed === "preferred") return "not_applicable";
  if (!parsed) return "not_evaluable";

  let matched = 0;
  let unknown = 0;
  for (const source of input.sources) {
    const year = source.metadata.publishedAt?.match(/^(\d{4})/u)?.[1];
    if (!year) {
      unknown += 1;
      continue;
    }
    const numericYear = Number(year);
    if (numericYear >= parsed.minimum && numericYear <= parsed.maximum) {
      matched += 1;
    }
  }
  if (matched >= input.minimumCount) return "passed";
  return matched + unknown >= input.minimumCount ? "not_evaluable" : "failed";
}

function parseRequiredDateRange(
  value: string,
  createdAt: string,
): { minimum: number; maximum: number } | "preferred" | null {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (/(?:優先|望ましい|prefer)/u.test(normalized)) return "preferred";
  const currentYear = new Date(createdAt).getUTCFullYear();
  const recent = normalized.match(
    /(?:直近|過去|last)\s*(\d+)\s*(?:年|years?)/u,
  );
  if (recent?.[1]) {
    const years = Number(recent[1]);
    return { minimum: currentYear - years + 1, maximum: currentYear };
  }
  const range = normalized.match(
    /(\d{4})(?:年)?\s*(?:-|–|—|~|〜|～|から)\s*(\d{4})(?:年)?/u,
  );
  if (range?.[1] && range[2]) {
    const minimum = Number(range[1]);
    const maximum = Number(range[2]);
    return minimum <= maximum ? { minimum, maximum } : null;
  }
  const since = normalized.match(/(\d{4})年?(?:以降|から|or later|onward)/u);
  if (since?.[1]) return { minimum: Number(since[1]), maximum: 9999 };
  const until = normalized.match(/(\d{4})年?(?:以前|まで|or earlier)/u);
  if (until?.[1]) return { minimum: 1, maximum: Number(until[1]) };
  const exact = normalized.match(/^(\d{4})年?$/u);
  return exact?.[1]
    ? { minimum: Number(exact[1]), maximum: Number(exact[1]) }
    : null;
}

function deterministicSourceKinds(
  source: SourceRecord,
  plan: DocumentPlan,
): {
  kinds: RequiredSourceKind[];
  basis: ResearchEvidenceBinding["kindAssessmentBasis"] | null;
} {
  const requiredLocators = new Set(
    plan.sections.flatMap((section) =>
      section.sourceRequirements.flatMap((requirement) =>
        requirement.requiredLocators.map(normalizeRequiredLocator),
      ),
    ),
  );
  const kinds: RequiredSourceKind[] = [];
  let basis: ResearchEvidenceBinding["kindAssessmentBasis"] | null = null;
  if (requiredLocators.has(source.canonicalLocator)) {
    kinds.push("user_provided");
    basis = "required_locator";
  }
  switch (source.metadata.workType) {
    case "journal_article":
    case "proceedings_article":
      kinds.push("peer_reviewed");
      basis = "provider_metadata";
      break;
    case "thesis":
      kinds.push("primary_research");
      basis = "provider_metadata";
      break;
    case "book":
    case "book_chapter":
    case "report":
      kinds.push("authoritative_secondary");
      basis = "provider_metadata";
      break;
    case "web":
    case "other":
    case undefined:
      break;
  }
  return { kinds: uniqueKinds(kinds), basis };
}

function uniqueKinds(kinds: readonly RequiredSourceKind[]): RequiredSourceKind[] {
  return [...new Set(kinds)];
}

function normalizeRequiredLocator(locator: string): string {
  try {
    return canonicalizeSourceLocator(locator).canonicalLocator;
  } catch {
    return locator.normalize("NFKC").trim();
  }
}

function claimOutcome(
  realization: ResearchClaimRealization | null,
  bindings: readonly ResearchEvidenceBinding[],
  requirements: readonly ResearchSourceRequirementAssessment[],
): ResearchClaimAssessment["outcome"] {
  if (!realization) return "not_evaluable";
  if (realization.alignment.outcome === "does_not_match") {
    return "not_supported";
  }
  if (realization.alignment.outcome === "uncertain") return "uncertain";
  if (bindings.length === 0) return "not_evaluable";
  const hasSupport = bindings.some(
    (binding) => binding.entailment.outcome === "supports",
  );
  const hasContradiction = bindings.some(
    (binding) => binding.entailment.outcome === "contradicts",
  );
  if (hasContradiction) return "not_supported";
  if (!hasSupport) return "not_supported";
  if (requirements.some((requirement) => requirement.status === "failed")) {
    return "not_supported";
  }
  if (
    requirements.some((requirement) => requirement.status === "not_evaluable")
  ) {
    return "uncertain";
  }
  return "supported";
}

function assertRealizationMatchesDocument(
  realization: ResearchClaimRealization,
  document: DocumentModel,
): void {
  const frozen = freezeResearchDocumentNodes(document).find(
    (node) => node.nodeId === realization.nodeId,
  );
  if (
    !frozen ||
    frozen.nodeType !== realization.nodeType ||
    digestText(realization.excerpt) !== realization.excerptSha256 ||
    frozen.text.slice(realization.location.start, realization.location.end) !==
      realization.excerpt ||
    canonicalResearchDigest(frozen.citedSourceIds) !==
      canonicalResearchDigest(realization.citedSourceIds)
  ) {
    throw new Error("Research claim text no longer matches its manuscript snapshot.");
  }
}

function researchNodeContent(
  node: DocumentNode,
  citationSourceById: ReadonlyMap<string, string>,
): { text: string; citedSourceIds: string[] } {
  const groups = researchInlineGroups(node);
  const citedSourceIds: string[] = [];
  const text = groups
    .map((group) =>
      group
        .map((inline) => {
          switch (inline.type) {
            case "text":
              return inline.text;
            case "hardBreak":
              return "\n";
            case "inlineMath":
              return JSON.stringify(inline.expression);
            case "citationRef": {
              const sourceId = citationSourceById.get(inline.citationId);
              if (sourceId) citedSourceIds.push(sourceId);
              return "";
            }
            case "footnoteRef":
            case "crossRef":
              return "";
          }
        })
        .join(""),
    )
    .filter(Boolean)
    .join("\n");
  return { text, citedSourceIds };
}

function researchInlineGroups(node: DocumentNode): InlineContent[] {
  switch (node.type) {
    case "section":
      return [node.title];
    case "paragraph":
    case "heading":
      return [node.content];
    case "list": {
      const groups: InlineContent[] = [];
      const visit = (items: ListItemModel[]) => {
        for (const item of items) {
          groups.push(item.content);
          visit(item.children);
        }
      };
      visit(node.items);
      return groups;
    }
    case "equation":
      return node.description ? [node.description] : [];
    case "figure":
      return [node.caption];
    case "table":
      return [
        ...(node.caption ? [node.caption] : []),
        ...node.columns.map((column) => column.header),
        ...node.rows.flatMap((row) => row.cells.map((cell) => cell.content)),
      ];
    case "callout":
      return [...(node.title ? [node.title] : []), node.content];
    case "theorem":
    case "proof":
      return node.title ? [node.title] : [];
    case "algorithm": {
      const groups: InlineContent[] = [node.title];
      if (node.description) groups.push(node.description);
      if (node.inputs) groups.push(node.inputs);
      if (node.outputs) groups.push(node.outputs);
      const visit = (steps: AlgorithmStepModel[]): void => {
        for (const step of steps) {
          groups.push(step.content);
          visit(step.children);
        }
      };
      visit(node.steps);
      return groups;
    }
    case "codeBlock":
      return node.caption ? [node.caption] : [];
    case "appendix":
      return [node.title];
    case "bibliography":
      return node.title ? [node.title] : [];
    case "footnote":
      return [node.content];
    case "citation":
    case "pageBreak":
      return [];
  }
}

function assertBindingMatchesSource(
  binding: ResearchEvidenceBinding,
  rawSource: SourceRecord | undefined,
): void {
  if (!rawSource) throw new Error("Research evidence source is unavailable.");
  const source = SourceRecordSchema.parse(rawSource);
  if (
    !canSourceSupportClaims(source) ||
    source.contentSha256 !== binding.contentSha256 ||
    source.canonicalLocator !== binding.canonicalLocator ||
    digestText(binding.excerpt) !== binding.excerptSha256
  ) {
    throw new Error("Research evidence no longer matches its source snapshot.");
  }
  if (binding.location.kind !== "text_offset") {
    throw new Error("Page evidence cannot be verified by the current source resolver.");
  }
  if (
    source.contentText!.slice(binding.location.start, binding.location.end) !==
    binding.excerpt
  ) {
    throw new Error("Research evidence excerpt no longer matches its source snapshot.");
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseResearchLedger(value: unknown): ResearchLedger {
  return assertResearchLedgerDigest(ResearchLedgerSchema.parse(value));
}
