"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getNativeHost, hostMessageBody, type HostMessage } from "./native-host";
import {
  EMPTY_WORKSPACE_IDENTITY,
  normalizeWorkspaceRelativePath,
  sameWorkspaceSession,
  workspaceIdentityFromHost,
  workspaceRequestFields,
  type NativeWorkspaceIdentity,
} from "./workspace-identity";

/** Code and AI share this single configured build root inside the workspace. */
export type NativeWorkspaceTarget = {
  id: string;
  name: string;
  mainFile: string;
};

export type NativeWorkspaceState = {
  current: NativeWorkspaceTarget | null;
  workspaceId: string;
  workspaceRoot: string | null;
  workspaceGeneration: number;
  hasWorkspace: boolean;
  loading: boolean;
  openWorkspace: () => void;
  createWorkspace: () => void;
};

const subscribeToNothing = () => () => {};
let buildRequestCounter = 0;

const pathBaseName = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1) || "ワークスペース";
};

/** Derive AI's only target from the same root file snapshot Code consumes. */
export function workspaceTargetFromHost(
  body: Record<string, unknown>,
  identity: NativeWorkspaceIdentity,
): NativeWorkspaceTarget | null {
  if (!identity.workspaceRoot) return null;
  const mainFile = normalizeWorkspaceRelativePath(body.rootFile);
  if (!mainFile) return null;
  const name =
    typeof body.rootName === "string" && body.rootName.trim()
      ? body.rootName.trim()
      : pathBaseName(identity.workspaceRoot);
  return {
    id: `${identity.workspaceId}:${encodeURIComponent(mainFile)}`,
    name,
    mainFile,
  };
}

/** Typeset Code's configured root and keep every event workspace-correlatable. */
export function requestWorkspaceBuild(
  target: Pick<NativeWorkspaceTarget, "mainFile">,
  identity: NativeWorkspaceIdentity,
): string | null {
  const host = getNativeHost();
  if (!host || !identity.workspaceRoot) return null;
  buildRequestCounter += 1;
  const requestId = `ai-build-${Date.now().toString(36)}-${buildRequestCounter}`;
  host.send("build", {
    requestId,
    ...workspaceRequestFields(identity),
    targetFile: target.mainFile,
    documentMainFile: target.mainFile,
    queueIfBusy: true,
    pdfViewerMode: "none",
  });
  return requestId;
}

/** AI follows the workspace and root document already selected by Code. */
export function useNativeWorkspace(): NativeWorkspaceState {
  const native = useSyncExternalStore(
    subscribeToNothing,
    () => getNativeHost() !== null,
    () => false,
  );
  const [identity, setIdentity] = useState<NativeWorkspaceIdentity>(
    EMPTY_WORKSPACE_IDENTITY,
  );
  const [current, setCurrent] = useState<NativeWorkspaceTarget | null>(null);
  const [snapshotArrived, setSnapshotArrived] = useState(false);
  const identityRef = useRef<NativeWorkspaceIdentity>(EMPTY_WORKSPACE_IDENTITY);

  useEffect(() => {
    if (!native) return;
    const host = getNativeHost();
    if (!host) return;

    const unsubscribe = host.onMessage((message: HostMessage) => {
      if (message.type !== "updateWorkspace") return;
      const body = hostMessageBody(message);
      const previous = identityRef.current;
      const next = workspaceIdentityFromHost(body, previous);
      const workspaceChanged = !sameWorkspaceSession(previous, next);
      identityRef.current = next;
      if (workspaceChanged) setIdentity(next);
      if (
        workspaceChanged ||
        Object.prototype.hasOwnProperty.call(body, "rootFile") ||
        Object.prototype.hasOwnProperty.call(body, "rootName")
      ) {
        setCurrent(workspaceTargetFromHost(body, next));
      }
      setSnapshotArrived(true);
    });
    host.send("workspace:state:get", {});
    return unsubscribe;
  }, [native]);

  const openWorkspace = useCallback(() => {
    getNativeHost()?.send("openWorkspace", { locale: "ja" });
  }, []);
  const createWorkspace = useCallback(() => {
    getNativeHost()?.send("createProject", { locale: "ja" });
  }, []);

  return {
    current,
    workspaceId: identity.workspaceId,
    workspaceRoot: identity.workspaceRoot,
    workspaceGeneration: identity.workspaceGeneration,
    hasWorkspace: identity.workspaceRoot !== null,
    loading: native && !snapshotArrived,
    openWorkspace,
    createWorkspace,
  };
}
