import { uiText } from "./i18n.js";
export const initBridgeSender = (deps) => {
    return (payload, silent = false) => {
        var _a, _b, _c;
        const handler = (_a = deps.bridgeWindow.tex64Bridge) !== null && _a !== void 0 ? _a : (_c = (_b = deps.bridgeWindow.webkit) === null || _b === void 0 ? void 0 : _b.messageHandlers) === null || _c === void 0 ? void 0 : _c.tex64;
        if (!handler || typeof handler.postMessage !== "function") {
            if (!silent) {
                const message = uiText("Native integration is not available.", "ネイティブ連携が利用できません。");
                deps.updateIssues(1, message, "error", [
                    { severity: "error", message },
                ]);
            }
            return false;
        }
        // The Code renderer owns the app-wide engine preference, including when
        // the AI webview forwards a turn. Profile overrides are resolved in main.
        if (payload.type === "agent:run" || payload.type === "agent:resume") {
            const context = payload.context && typeof payload.context === "object" ? payload.context : {};
            payload = { ...payload, context: { ...context, appBuildEngine: localStorage.getItem("tex64.compileEngine") || "lualatex" } };
        }
        else if (payload.type === "build" && !payload.engine) {
            payload = { ...payload, engine: localStorage.getItem("tex64.compileEngine") || "lualatex" };
        }
        handler.postMessage(payload);
        return true;
    };
};
