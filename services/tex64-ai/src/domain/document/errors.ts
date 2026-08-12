export type DocumentDomainErrorCode =
  | "revision_conflict"
  | "document_mismatch"
  | "duplicate_revision"
  | "invalid_document"
  | "invalid_patch"
  | "duplicate_id"
  | "missing_node"
  | "invalid_operation"
  | "invalid_position";

export class DocumentDomainError extends Error {
  readonly code: DocumentDomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DocumentDomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DocumentDomainError";
    this.code = code;
    this.details = details;
  }
}

export class DocumentConflictError extends DocumentDomainError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      "revision_conflict",
      `Patch is based on revision ${expectedRevision}, but current revision is ${actualRevision}`,
      { expectedRevision, actualRevision },
    );
    this.name = "DocumentConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface DocumentValidationIssue {
  code:
    | "schema"
    | "duplicate_id"
    | "missing_reference"
    | "invalid_reference"
    | "duplicate_parent"
    | "orphan_node"
    | "cycle"
    | "depth_limit"
    | "resource_limit"
    | "invalid_table"
    | "invalid_math"
    | "invalid_structure"
    | "unlisted_citation"
    | "invalid_asset";
  path: string;
  message: string;
}

export class DocumentValidationError extends DocumentDomainError {
  readonly issues: readonly DocumentValidationIssue[];

  constructor(issues: readonly DocumentValidationIssue[]) {
    super("invalid_document", "Document validation failed", { issues });
    this.name = "DocumentValidationError";
    this.issues = issues;
  }
}
