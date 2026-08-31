import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getWorkspaceFile } from "@/app/api/workspace/file/route";
import { proxy } from "@/proxy";
import {
  NATIVE_SESSION_CHALLENGE_QUERY,
  NATIVE_SESSION_PROOF_HEADER,
  NATIVE_SESSION_TOKEN_ENV,
  nativeSessionHealthProof,
} from "@/server/native-session";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native desktop session boundary", () => {
  it("removes every non-health HTTP API from the native session", async () => {
    const apiUrl = "http://127.0.0.1:3100/api/documents/example";
    const webResponse = proxy(new NextRequest(apiUrl));
    expect(webResponse.headers.get("x-middleware-next")).toBe("1");

    vi.stubEnv(NATIVE_SESSION_TOKEN_ENV, "api-secret");
    const denied = proxy(new NextRequest(apiUrl));
    expect(denied.status).toBe(410);
    expect(await denied.json()).toMatchObject({
      error: { code: "native_http_api_disabled" },
    });

    const tokenStillDenied = proxy(
      new NextRequest(`${apiUrl}?nativeToken=api-secret`),
    );
    expect(tokenStillDenied.status).toBe(410);

    const health = proxy(
      new NextRequest("http://127.0.0.1:3100/api/health"),
    );
    expect(health.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps the caller-selected workspace file route removed in every environment", async () => {
    const response = await getWorkspaceFile();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_file_route_removed" },
    });
  });

  it("disables caller-selected workspace roots for every native session request", async () => {
    vi.stubEnv(NATIVE_SESSION_TOKEN_ENV, "desktop-launch-secret");

    const response = await getWorkspaceFile();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_file_route_removed" },
    });
  });

  it("proves native health without sending the launch token", async () => {
    vi.stubEnv(NATIVE_SESSION_TOKEN_ENV, "health-secret");
    const denied = await getHealth(
      new Request("http://127.0.0.1:3100/api/health"),
    );
    expect(denied.status).toBe(401);

    const acceptedUrl = new URL("http://127.0.0.1:3100/api/health");
    const challenge = "A".repeat(43);
    acceptedUrl.searchParams.set(NATIVE_SESSION_CHALLENGE_QUERY, challenge);
    const accepted = await getHealth(new Request(acceptedUrl));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect(accepted.headers.get(NATIVE_SESSION_PROOF_HEADER)).toBe(
      nativeSessionHealthProof("health-secret", challenge),
    );
  });
});
