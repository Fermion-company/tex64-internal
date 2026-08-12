export type SourceResolutionErrorCode =
  | "invalid_locator"
  | "unsupported_protocol"
  | "blocked_host"
  | "blocked_address"
  | "dns_failed"
  | "request_failed"
  | "request_timeout"
  | "too_many_redirects"
  | "redirect_loop"
  | "response_too_large"
  | "http_error"
  | "unsupported_mime"
  | "invalid_response"
  | "empty_content";

export class SourceResolutionError extends Error {
  readonly code: SourceResolutionErrorCode;
  readonly status?: number;

  constructor(code: SourceResolutionErrorCode, message: string, options?: { status?: number }) {
    super(message);
    this.name = "SourceResolutionError";
    this.code = code;
    this.status = options?.status;
  }
}
