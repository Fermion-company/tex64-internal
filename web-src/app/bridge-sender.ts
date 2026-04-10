import { uiText } from "./i18n.js";
import type { BridgeWindow, IssueItem, IssuesStatus } from "./types.js";

type BridgeSenderDeps = {
  bridgeWindow: BridgeWindow;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
};

export type PostToNative = (
  payload: { type: string; [key: string]: unknown },
  silent?: boolean
) => boolean;

export const initBridgeSender = (deps: BridgeSenderDeps): PostToNative => {
  return (payload, silent = false) => {
    const handler =
      deps.bridgeWindow.tex64Bridge ?? deps.bridgeWindow.webkit?.messageHandlers?.tex64;
    if (!handler || typeof handler.postMessage !== "function") {
      if (!silent) {
        const message = uiText("Native integration is not available.", "ネイティブ連携が利用できません。");
        deps.updateIssues(1, message, "error", [
          { severity: "error", message },
        ]);
      }
      return false;
    }
    handler.postMessage(payload);
    return true;
  };
};
