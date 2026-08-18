import { NextResponse } from "next/server";
import { z } from "zod";
import { DocumentConflictError, DocumentDomainError } from "@/domain/document";
import {
  AgentRunConflictError,
  AgentRunNotFoundError,
  ArtifactConflictError,
  DocumentNotFoundError,
  IdempotencyConflictError,
  InvalidAgentRunTransitionError,
  RevisionConflictError,
  ResourceLimitExceededError,
} from "@/server/persistence";
import { CompileFailure } from "@/server/compiler";
import { InvalidOriginError } from "./origin";
import { InvalidRequestBodyError } from "./request";
import { ProductionConfigurationError } from "@/server/config/production";

export function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof InvalidOriginError) {
    return jsonError("この操作は許可されていません。", 403, "invalid_origin");
  }
  if (error instanceof z.ZodError) {
    return jsonError("入力内容を確認してください。", 400, "invalid_request");
  }
  if (error instanceof InvalidRequestBodyError) {
    if (error.kind === "content_type") {
      return jsonError(
        "入力を送信できませんでした。画面を更新して、もう一度お試しください。",
        415,
        "unsupported_media_type",
      );
    }
    if (error.kind === "too_large") {
      return jsonError("入力内容を短くして、もう一度お試しください。", 413, "request_too_large");
    }
    return jsonError("入力内容を確認してください。", 400, "invalid_request");
  }
  if (error instanceof DocumentNotFoundError || error instanceof AgentRunNotFoundError) {
    return jsonError("見つかりませんでした。", 404, "not_found");
  }
  if (error instanceof RevisionConflictError) {
    return jsonError("別の編集が先に保存されました。最新版に合わせて再試行してください。", 409, "revision_conflict");
  }
  if (error instanceof DocumentConflictError) {
    return jsonError("別の編集が先に保存されました。最新版に合わせて再試行してください。", 409, "revision_conflict");
  }
  if (error instanceof IdempotencyConflictError) {
    return jsonError("送信内容が重複しています。画面を更新して、もう一度お試しください。", 409, "request_conflict");
  }
  if (error instanceof AgentRunConflictError) {
    return jsonError("処理状況が更新されました。最新の状態を確認してください。", 409, "run_conflict");
  }
  if (error instanceof InvalidAgentRunTransitionError) {
    return jsonError("この処理は現在の状態では変更できません。", 409, "run_conflict");
  }
  if (error instanceof ArtifactConflictError) {
    return jsonError("この版のPDFはすでに作成されています。", 409, "artifact_conflict");
  }
  if (error instanceof ResourceLimitExceededError) {
    return jsonError(
      "保存上限に達しました。続けるには管理者にお問い合わせください。",
      422,
      "resource_limit",
    );
  }
  if (error instanceof DocumentDomainError) {
    return jsonError("文書の内容を保存できませんでした。", 422, "invalid_document");
  }
  if (error instanceof CompileFailure) {
    return jsonError(
      "文書を仕上げられませんでした。もう一度お試しください。",
      422,
      "document_failed",
    );
  }
  if (
    error instanceof Error &&
    error.name === "AgentRuntimeConfigurationError"
  ) {
    return jsonError(error.message, 503, "agent_unconfigured");
  }
  if (error instanceof ProductionConfigurationError) {
    console.error("Production readiness check failed", error.message);
    return jsonError(
      "現在この操作を利用できません。管理者にお問い合わせください。",
      503,
      "service_unavailable",
    );
  }

  console.error("Route failed", error);
  return jsonError("処理を完了できませんでした。", 500, "internal_error");
}

export function rateLimitResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: { code: "rate_limited", message: "少し待ってからもう一度お試しください。" } },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
