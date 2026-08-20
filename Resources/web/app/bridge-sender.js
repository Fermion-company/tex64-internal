import { uiText } from "./i18n.js";
export const initBridgeSender = (deps) => {
    return (payload, silent = false) => {
        var _a, _b;
        var _c;
        const handler = (_c = deps.bridgeWindow.tex64Bridge) !== null && _c !== void 0 ? _c : (_b = (_a = deps.bridgeWindow.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.tex64;
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
