import type {
  DocumentBlock,
  DocumentChanges,
  DocumentDetail,
  DocumentPatch,
} from "./types";

export function diffDocumentPatch(
  baseline: DocumentDetail,
  desired: DocumentDetail,
): DocumentPatch | null {
  const changes: DocumentChanges = {};

  if (baseline.title !== desired.title) changes.title = desired.title;
  if (baseline.eyebrow !== desired.eyebrow) changes.eyebrow = desired.eyebrow ?? "";
  if (baseline.author !== desired.author) changes.author = desired.author ?? "";
  if (baseline.status !== desired.status) changes.status = desired.status;
  if (!sameValue(baseline.blocks, desired.blocks)) changes.blocks = desired.blocks;

  return Object.keys(changes).length > 0
    ? { baseRevision: baseline.revision, ...changes }
    : null;
}

export function mergePendingPatch(
  baseline: DocumentDetail,
  current: DocumentPatch | null,
  changes: DocumentChanges,
): DocumentPatch {
  return {
    ...(current ?? {}),
    baseRevision: baseline.revision,
    ...changes,
  };
}

export function rebasePatchAfterConflict(input: {
  baseline: DocumentDetail;
  desired: DocumentDetail;
  patch: DocumentPatch;
  remote: DocumentDetail;
}): { desired: DocumentDetail; patch: DocumentPatch | null } {
  const desired: DocumentDetail = {
    ...input.remote,
    title:
      input.desired.title === input.baseline.title
        ? input.remote.title
        : input.desired.title,
    eyebrow:
      input.desired.eyebrow === input.baseline.eyebrow
        ? input.remote.eyebrow
        : input.desired.eyebrow,
    author:
      input.desired.author === input.baseline.author
        ? input.remote.author
        : input.desired.author,
    status:
      input.desired.status === input.baseline.status
        ? input.remote.status
        : input.desired.status,
    blocks:
      input.patch.blocks === undefined
        ? input.remote.blocks
        : mergeBlocksAfterConflict(
            input.baseline.blocks,
            input.desired.blocks,
            input.remote.blocks,
          ),
    artifactUrl: undefined,
    updatedAt: input.desired.updatedAt,
  };

  return { desired, patch: diffDocumentPatch(input.remote, desired) };
}

function mergeBlocksAfterConflict(
  baseline: DocumentBlock[],
  desired: DocumentBlock[],
  remote: DocumentBlock[],
): DocumentBlock[] {
  const baselineById = new Map(baseline.map((block) => [block.id, block]));
  const desiredById = new Map(desired.map((block) => [block.id, block]));
  const locallyDeleted = new Set(
    baseline.filter((block) => !desiredById.has(block.id)).map((block) => block.id),
  );
  const locallyChanged = new Set(
    desired
      .filter((block) => {
        const original = baselineById.get(block.id);
        return original === undefined || !sameValue(original, block);
      })
      .map((block) => block.id),
  );

  const merged = remote
    .filter((block) => !locallyDeleted.has(block.id))
    .map((block) =>
      locallyChanged.has(block.id) ? (desiredById.get(block.id) ?? block) : block,
    );

  for (let desiredIndex = 0; desiredIndex < desired.length; desiredIndex += 1) {
    const block = desired[desiredIndex];
    if (!block || merged.some((candidate) => candidate.id === block.id)) continue;
    if (!locallyChanged.has(block.id)) continue;

    const previousIds = desired.slice(0, desiredIndex).map((candidate) => candidate.id).reverse();
    const previousIndex = previousIds
      .map((id) => merged.findIndex((candidate) => candidate.id === id))
      .find((index) => index >= 0);
    if (previousIndex !== undefined) {
      merged.splice(previousIndex + 1, 0, block);
      continue;
    }

    const nextIds = desired.slice(desiredIndex + 1).map((candidate) => candidate.id);
    const nextIndex = nextIds
      .map((id) => merged.findIndex((candidate) => candidate.id === id))
      .find((index) => index >= 0);
    merged.splice(nextIndex ?? merged.length, 0, block);
  }

  return merged;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
