"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getNativeHost, hostMessageBody, type HostMessage } from "./native-host";

export type NativeAgentModel = "Axiom1.0" | "Axiom1.0-pro";

type AuthSnapshot = {
  authenticated: boolean;
  pending: boolean;
  plan: string | null;
  email: string | null;
};

type AccessSnapshot = {
  allowed: boolean;
  reason: string | null;
  plan: string | null;
};

type UsageSnapshot = {
  usedTokens: number;
  limitTokens: number;
  remainingTokens: number;
};

export type NativePlatformState = {
  model: NativeAgentModel;
  authenticated: boolean;
  authPending: boolean;
  plan: string | null;
  email: string | null;
  usage: UsageSnapshot | null;
  modelReady: boolean;
  canRun: boolean;
  isPro: boolean;
  blockedReason: string | null;
  setModel: (model: NativeAgentModel) => void;
  signIn: () => void;
  signOut: () => void;
  openPlans: (plan?: "basic" | "pro") => void;
  refresh: () => void;
};

const EMPTY_AUTH: AuthSnapshot = {
  authenticated: false,
  pending: false,
  plan: null,
  email: null,
};

export function parseNativeAgentModel(value: unknown): NativeAgentModel | null {
  return value === "Axiom1.0" || value === "Axiom1.0-pro" ? value : null;
}

export function canRunNativePlatform(input: {
  model: NativeAgentModel;
  modelReady: boolean;
  accessAllowed: boolean;
  isPro: boolean;
}): boolean {
  return (
    input.modelReady &&
    input.accessAllowed &&
    (input.model !== "Axiom1.0-pro" || input.isPro)
  );
}

function finiteToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

/** Accept the same token-only quota shape used by Code mode. */
export function parseNativeTokenUsage(value: unknown): UsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const quota = value as Record<string, unknown>;
  if (
    typeof quota.limitTokens !== "number" ||
    !Number.isFinite(quota.limitTokens) ||
    typeof quota.usedTokens !== "number" ||
    !Number.isFinite(quota.usedTokens)
  ) {
    return null;
  }
  const limitTokens = finiteToken(quota.limitTokens);
  const usedTokens = finiteToken(quota.usedTokens);
  const maximumRemaining = Math.max(0, limitTokens - usedTokens);
  const remainingTokens =
    typeof quota.remainingTokens === "number" &&
    Number.isFinite(quota.remainingTokens)
      ? Math.min(finiteToken(quota.remainingTokens), maximumRemaining)
      : maximumRemaining;
  return { usedTokens, limitTokens, remainingTokens };
}

export function useNativePlatform(): NativePlatformState {
  const [model, setCurrentModel] = useState<NativeAgentModel>("Axiom1.0");
  const [modelReady, setModelReady] = useState(false);
  const [auth, setAuth] = useState<AuthSnapshot>(EMPTY_AUTH);
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const modelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authIdentityRef = useRef<string | null>(null);

  const clearModelTimer = useCallback(() => {
    if (modelTimerRef.current !== null) clearTimeout(modelTimerRef.current);
    modelTimerRef.current = null;
  }, []);

  const scheduleModelTimeout = useCallback(() => {
    clearModelTimer();
    modelTimerRef.current = setTimeout(() => {
      modelTimerRef.current = null;
      setModelError(
        "AIモデルを確認できませんでした。モードを切り替えて、もう一度お試しください。",
      );
    }, 8_000);
  }, [clearModelTimer]);

  const armModelTimer = useCallback(() => {
    setModelError(null);
    scheduleModelTimeout();
  }, [scheduleModelTimeout]);

  const refresh = useCallback(() => {
    const host = getNativeHost();
    host?.send("agent:model:get", {});
    host?.send("platform:state:get", {});
    host?.send("feature:check", { names: ["ai"], force: false });
    host?.send("platform:usage:get", { force: false, source: "ai-mode" });
  }, []);

  useEffect(() => {
    const host = getNativeHost();
    if (!host) return;
    scheduleModelTimeout();
    const unsubscribe = host.onMessage((message: HostMessage) => {
      const body = hostMessageBody(message);
      if (message.type === "agent:model") {
        const publicModel = parseNativeAgentModel(body.model);
        if (publicModel) {
          clearModelTimer();
          setModelError(null);
          setCurrentModel(publicModel);
          setModelReady(true);
        } else if (body.model === "codex") {
          // Codex remains an internal compatibility backend, not a product
          // model. Migrate the shared desktop setting so Code and AI surfaces
          // agree on one of the two public Axiom models.
          setModelReady(false);
          armModelTimer();
          host.send("agent:model:set", { model: "Axiom1.0" });
        }
        return;
      }
      if (message.type === "platform:auth") {
        if (body.error && typeof body.error === "object") {
          setPlatformError(
            "AIアカウントを確認できませんでした。接続を確認して、もう一度お試しください。",
          );
        }
        const value = body.auth;
        if (!value || typeof value !== "object") return;
        const snapshot = value as Record<string, unknown>;
        const user =
          snapshot.user && typeof snapshot.user === "object"
            ? (snapshot.user as Record<string, unknown>)
            : null;
        const authenticated = snapshot.authenticated === true;
        const plan = typeof snapshot.plan === "string" ? snapshot.plan : null;
        const email = user && typeof user.email === "string" ? user.email : null;
        setAuth({
          authenticated,
          pending: snapshot.pending === true,
          plan,
          email,
        });
        const authIdentity = `${authenticated ? "1" : "0"}:${email ?? ""}:${plan ?? ""}`;
        if (authIdentityRef.current !== authIdentity) {
          authIdentityRef.current = authIdentity;
          setAccess(null);
          setUsage(null);
          host.send("feature:check", { names: ["ai"], force: true });
          host.send("platform:usage:get", {
            force: true,
            source: "ai-mode-auth",
          });
        }
        if (!body.error) setPlatformError(null);
        return;
      }
      if (message.type === "platform:aiAccess") {
        const value = body.access;
        if (!value || typeof value !== "object") return;
        const snapshot = value as Record<string, unknown>;
        setAccess({
          allowed: snapshot.allowed === true,
          reason: typeof snapshot.reason === "string" ? snapshot.reason : null,
          plan: typeof snapshot.plan === "string" ? snapshot.plan : null,
        });
        // Anonymous app identities receive the Free allowance through this
        // response too. Do not wait for a signed-in-only usage refresh.
        setUsage(parseNativeTokenUsage(snapshot.quota));
        setPlatformError(null);
        return;
      }
      if (message.type === "platform:usage") {
        const value = body.usage;
        if (!value || typeof value !== "object") {
          setUsage(null);
          return;
        }
        const summary = (value as Record<string, unknown>).summary;
        if (!summary || typeof summary !== "object") {
          setUsage(null);
          return;
        }
        setUsage(parseNativeTokenUsage(summary));
      }
    });
    refresh();
    return () => {
      clearModelTimer();
      unsubscribe();
    };
  }, [armModelTimer, clearModelTimer, refresh, scheduleModelTimeout]);

  const plan = access?.plan ?? auth.plan;
  const isPro = typeof plan === "string" && plan.toLowerCase() === "pro";
  const canRun = canRunNativePlatform({
    model,
    modelReady,
    accessAllowed: access?.allowed === true,
    isPro,
  });
  const blockedReason = useMemo(() => {
    if (!modelReady) return modelError;
    if (canRun) return null;
    if (platformError) return platformError;
    if (!access) return null;
    if (access?.reason === "QUOTA_EXCEEDED") return "今月分のAIトークンを使い切りました。";
    if (model === "Axiom1.0-pro" && !isPro) return "Axiom1.0-proはProプランで使えます。";
    if (!auth.authenticated) return "Axiomを使うにはログインしてください。";
    return "プランを確認してください。";
  }, [
    access,
    auth.authenticated,
    canRun,
    isPro,
    model,
    modelError,
    modelReady,
    platformError,
  ]);

  const setModel = useCallback((nextModel: NativeAgentModel) => {
    setModelReady(false);
    armModelTimer();
    getNativeHost()?.send("agent:model:set", { model: nextModel });
  }, [armModelTimer]);

  return {
    model,
    authenticated: auth.authenticated,
    authPending: auth.pending,
    plan,
    email: auth.email,
    usage,
    modelReady,
    canRun,
    isPro,
    blockedReason,
    setModel,
    signIn: () => getNativeHost()?.send("auth:google:start", {}),
    signOut: () => getNativeHost()?.send("auth:signout", {}),
    openPlans: (preferredPlan) =>
      getNativeHost()?.send("billing:open-plans", {
        ...(preferredPlan ? { plan: preferredPlan } : {}),
      }),
    refresh,
  };
}
