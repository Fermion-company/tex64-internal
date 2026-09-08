import { NextResponse, type NextRequest } from "next/server";

import { NATIVE_SESSION_TOKEN_ENV } from "@/server/native-session";

/**
 * The native UI uses the Electron bridge for every operation. Its loopback
 * server exposes only health; a script running in the guest cannot revive the
 * old document/compile HTTP surface. The normal web deployment has no native
 * token environment and passes through.
 */
export function proxy(request: NextRequest) {
  if (!process.env[NATIVE_SESSION_TOKEN_ENV]) return NextResponse.next();
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  return NextResponse.json(
    {
      error: {
        code: "native_http_api_disabled",
        message: "デスクトップ版ではこのAPIを利用できません。",
      },
    },
    { status: 410 },
  );
}

export const config = {
  matcher: "/api/:path*",
};
