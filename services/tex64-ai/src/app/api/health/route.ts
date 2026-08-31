import { jsonError } from "@/server/http/responses";
import {
  NATIVE_SESSION_CHALLENGE_QUERY,
  NATIVE_SESSION_PROOF_HEADER,
  NATIVE_SESSION_TOKEN_ENV,
  nativeSessionHealthProof,
} from "@/server/native-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const token = process.env[NATIVE_SESSION_TOKEN_ENV];
  if (!token) {
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const challenge = new URL(request.url).searchParams.get(
    NATIVE_SESSION_CHALLENGE_QUERY,
  );
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return jsonError("接続を確認できませんでした。", 401, "invalid_native_session");
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "private, no-store",
        [NATIVE_SESSION_PROOF_HEADER]: nativeSessionHealthProof(token, challenge),
      },
    },
  );
}
