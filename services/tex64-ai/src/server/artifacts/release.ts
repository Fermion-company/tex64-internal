import type {
  ArtifactReleaseBinding,
  StoredAgentRun,
  StoredArtifact,
} from "@/server/persistence/types";

import { CURRENT_ARTIFACT_QUALITY_VERSION } from "./verification";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Converts persisted artifact metadata into the exact identity that may be
 * published. Legacy or malformed metadata cannot become a release binding.
 */
export function artifactReleaseBinding(
  artifact: StoredArtifact,
): ArtifactReleaseBinding {
  if (!artifactCanBeReleased(artifact)) {
    throw new Error("Document artifact is not eligible for publication.");
  }
  return {
    revision: artifact.revision,
    storageKey: artifact.storageKey,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    pageCount: artifact.pageCount,
    qualityVersion: artifact.qualityVersion,
  };
}

export function artifactMatchesRelease(
  artifact: StoredArtifact,
  release: ArtifactReleaseBinding,
): boolean {
  return (
    artifactCanBeReleased(artifact) &&
    releaseBindingIsValid(release) &&
    artifact.revision === release.revision &&
    artifact.storageKey === release.storageKey &&
    artifact.sha256 === release.sha256 &&
    artifact.byteSize === release.byteSize &&
    artifact.pageCount === release.pageCount &&
    artifact.qualityVersion === release.qualityVersion
  );
}

export function releaseBindingsMatch(
  left: ArtifactReleaseBinding,
  right: ArtifactReleaseBinding,
): boolean {
  return (
    releaseBindingIsValid(left) &&
    releaseBindingIsValid(right) &&
    left.revision === right.revision &&
    left.storageKey === right.storageKey &&
    left.sha256 === right.sha256 &&
    left.byteSize === right.byteSize &&
    left.pageCount === right.pageCount &&
    left.qualityVersion === right.qualityVersion
  );
}

/** The sole publication predicate shared by list, detail, replay, and GET. */
export function runReleasesArtifact(
  run: StoredAgentRun | null,
  artifact: StoredArtifact | null,
): artifact is StoredArtifact {
  return Boolean(
    run &&
      artifact &&
      run.status === "completed" &&
      run.stage === "ready" &&
      run.resultRevision === artifact.revision &&
      run.userId === artifact.userId &&
      run.documentId === artifact.documentId &&
      run.artifactRelease &&
      run.artifactRelease.revision === run.resultRevision &&
      artifactMatchesRelease(artifact, run.artifactRelease),
  );
}

function artifactCanBeReleased(
  artifact: StoredArtifact,
): artifact is StoredArtifact & { pageCount: number } {
  return (
    Number.isSafeInteger(artifact.revision) &&
    artifact.revision > 0 &&
    artifact.storageKey.length > 0 &&
    SHA256_PATTERN.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    artifact.pageCount !== null &&
    Number.isSafeInteger(artifact.pageCount) &&
    artifact.pageCount > 0 &&
    artifact.qualityVersion === CURRENT_ARTIFACT_QUALITY_VERSION
  );
}

function releaseBindingIsValid(release: ArtifactReleaseBinding): boolean {
  return (
    Number.isSafeInteger(release.revision) &&
    release.revision > 0 &&
    release.storageKey.length > 0 &&
    SHA256_PATTERN.test(release.sha256) &&
    Number.isSafeInteger(release.byteSize) &&
    release.byteSize > 0 &&
    Number.isSafeInteger(release.pageCount) &&
    release.pageCount > 0 &&
    release.qualityVersion === CURRENT_ARTIFACT_QUALITY_VERSION
  );
}
