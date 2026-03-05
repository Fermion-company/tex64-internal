import { getMathFieldSelectionRange } from "../../../app/blocks/math-input-utils.js";
import { buildOperatorCandidates, buildWordCandidates } from "../math-wysiwyg-candidates.js";
import { getKeyByLatex } from "../math-wysiwyg-keymap.js";
import { offsetToIndexInRange } from "../math-wysiwyg-selection.js";
import { hasEnvironmentInContext, isCursorInsideEnvironmentBody, readNativeMathfieldEnvironmentContext, } from "../math-wysiwyg-environment-context.js";
import { SLASH_COMMAND_CANDIDATE_LIMIT, SLASH_COMMAND_HINT_SET, applySlashCommandHint, buildSlashCommandFallbackCandidates, dedupeCandidatesByLatex, normalizeSlashCommandToken, } from "../math-wysiwyg-slash-commands.js";
import { isCommandToken } from "../math-wysiwyg-token-matching.js";
import { AUTO_COMMAND_MIN_LENGTH, AUTO_CONTAINS_MIN_LENGTH, AUTO_WORD_ALLOWLIST, AUTO_WORD_MIN_LENGTH, EXPLICIT_SUFFIX_MIN_LENGTH, EXPLICIT_WORD_MIN_LENGTH, MATRIX_LIKE_ENV_NAMES, } from "./constants.js";
import { resolveCursorOffset } from "./mathfield.js";
export const createMathWysiwygCandidateOps = (runtime, deps) => {
    const { mruOps, panelOps } = deps;
    const buildMatrixOpCandidates = () => {
        var _a;
        if (!runtime.mathfield) {
            return [];
        }
        const mf = runtime.mathfield;
        const selection = getMathFieldSelectionRange(mf);
        const cursorOffset = resolveCursorOffset(mf, selection);
        const nativeContext = readNativeMathfieldEnvironmentContext(mf, cursorOffset);
        const inMatrixByContext = hasEnvironmentInContext(nativeContext, MATRIX_LIKE_ENV_NAMES);
        const latex = inMatrixByContext ? null : (typeof mf.getValue === "function" ? String((_a = mf.getValue("latex")) !== null && _a !== void 0 ? _a : "") : null);
        const cursorIndex = !inMatrixByContext && latex ? offsetToIndexInRange(mf, 0, cursorOffset) : -1;
        const inMatrix = inMatrixByContext ||
            (!!latex &&
                cursorIndex >= 0 &&
                isCursorInsideEnvironmentBody(latex, cursorIndex, MATRIX_LIKE_ENV_NAMES));
        if (!inMatrix || typeof mf.executeCommand !== "function") {
            return [];
        }
        const applyCommand = (command) => (target) => {
            var _a;
            if (typeof target.executeCommand !== "function") {
                return;
            }
            try {
                const ok = Boolean(target.executeCommand(command));
                if (ok) {
                    (_a = target.dispatchEvent) === null || _a === void 0 ? void 0 : _a.call(target, new Event("input", { bubbles: true }));
                }
            }
            catch {
                // ignore
            }
        };
        const makeOp = (id, label, hint, displayLatex, command, priority) => ({
            id,
            key: getKeyByLatex(label, label, displayLatex),
            label,
            hint,
            displayLatex,
            priority,
            apply: applyCommand(command),
        });
        return [
            makeOp("matrix-op:add-row", "+row", "行を追加", "\\begin{matrix}a\\\\b\\end{matrix}", "addRowAfter", 260),
            makeOp("matrix-op:add-col", "+col", "列を追加", "\\begin{matrix}a&b\\end{matrix}", "addColumnAfter", 258),
            makeOp("matrix-op:remove-row", "-row", "行を削除", "\\begin{matrix}a\\\\b\\end{matrix}", "removeRow", 256),
            makeOp("matrix-op:remove-col", "-col", "列を削除", "\\begin{matrix}a&b\\end{matrix}", "removeColumn", 254),
        ];
    };
    const buildExplicitFallbackCandidates = () => {
        const matrixOps = buildMatrixOpCandidates();
        const recent = mruOps.buildRecentCandidates(matrixOps.length > 0 ? 6 : 8);
        const quick = mruOps.buildQuickCandidates();
        const seen = new Set();
        const results = [];
        const pushAll = (items) => {
            items.forEach((item) => {
                if (seen.has(item.id))
                    return;
                seen.add(item.id);
                results.push(item);
            });
        };
        pushAll(matrixOps);
        pushAll(recent);
        pushAll(quick);
        return results.slice(0, 14);
    };
    const getWordCandidates = (token) => {
        const normalized = token.trim();
        if (!normalized) {
            return [];
        }
        const allowedPacks = runtime.enabledPacks.size > 0 ? runtime.enabledPacks : undefined;
        return buildWordCandidates(normalized, { allowedPacks }).map((candidate) => ({
            id: candidate.id,
            key: candidate.key,
            label: candidate.label,
            hint: candidate.hint,
            displayLatex: candidate.displayLatex,
        }));
    };
    const openCustomCandidates = (candidates, options) => {
        var _a;
        if (!candidates || candidates.length === 0) {
            return;
        }
        const mapped = candidates.map((candidate, index) => ({
            id: candidate.id,
            key: getKeyByLatex(candidate.label, candidate.label, candidate.displayLatex),
            label: candidate.label,
            hint: candidate.hint,
            displayLatex: candidate.displayLatex,
            priority: 100 - index,
            apply: candidate.apply,
        }));
        runtime.panelState.currentCandidates = mapped;
        runtime.currentRange = null;
        runtime.currentTokenMatch = null;
        runtime.panelState.selectedIndex = Math.max(0, Math.min((_a = options === null || options === void 0 ? void 0 : options.selectedIndex) !== null && _a !== void 0 ? _a : 0, runtime.panelState.currentCandidates.length - 1));
        panelOps.ensurePanel();
        panelOps.setPanelVisible(true);
        panelOps.renderPanel();
    };
    const updateCandidates = (tokenMatch, options = {}) => {
        var _a;
        const explicit = (_a = options.explicit) !== null && _a !== void 0 ? _a : false;
        if (!tokenMatch) {
            if (explicit) {
                runtime.panelState.currentCandidates = buildExplicitFallbackCandidates();
                runtime.currentRange = null;
                runtime.currentTokenMatch = null;
                runtime.panelState.selectedIndex = 0;
                if (runtime.panelState.currentCandidates.length === 0) {
                    panelOps.setPanelVisible(false);
                    return;
                }
                panelOps.ensurePanel();
                panelOps.setPanelVisible(true);
                panelOps.renderPanel();
                return;
            }
            runtime.panelState.currentCandidates = [];
            runtime.currentRange = null;
            runtime.currentTokenMatch = null;
            runtime.panelState.selectedIndex = 0;
            panelOps.setPanelVisible(false);
            return;
        }
        const allowedPacks = explicit ? undefined : runtime.enabledPacks.size > 0 ? runtime.enabledPacks : undefined;
        if (tokenMatch.kind === "word" || tokenMatch.kind === "command" || tokenMatch.kind === "slash-command") {
            const normalized = tokenMatch.token.toLowerCase();
            const minLength = tokenMatch.kind === "slash-command"
                ? 0
                : explicit
                    ? EXPLICIT_WORD_MIN_LENGTH
                    : tokenMatch.kind === "command"
                        ? AUTO_COMMAND_MIN_LENGTH
                        : isCommandToken(tokenMatch.token)
                            ? AUTO_COMMAND_MIN_LENGTH
                            : AUTO_WORD_ALLOWLIST.has(normalized)
                                ? 2
                                : AUTO_WORD_MIN_LENGTH;
            if (tokenMatch.token.length < minLength) {
                runtime.panelState.currentCandidates = [];
                runtime.currentRange = null;
                runtime.currentTokenMatch = null;
                runtime.panelState.selectedIndex = 0;
                panelOps.setPanelVisible(false);
                return;
            }
        }
        let effectiveMatch = tokenMatch;
        let nextCandidates = [];
        if (tokenMatch.kind === "operator") {
            nextCandidates = buildOperatorCandidates(tokenMatch.token);
        }
        else if (tokenMatch.kind === "slash-command") {
            const slashToken = normalizeSlashCommandToken(tokenMatch.token);
            if (!slashToken) {
                nextCandidates = buildSlashCommandFallbackCandidates();
            }
            else {
                const rawCandidates = buildWordCandidates(slashToken, {
                    allowContainsMinLength: explicit ? 1 : AUTO_CONTAINS_MIN_LENGTH,
                    allowedPacks,
                    dedupeByLatex: !explicit,
                });
                const preferred = rawCandidates.filter((candidate) => SLASH_COMMAND_HINT_SET.has(candidate.hint.toLowerCase()));
                const exact = rawCandidates.filter((candidate) => normalizeSlashCommandToken(candidate.hint) === slashToken);
                const merged = preferred.length > 0 ? [...exact, ...preferred, ...rawCandidates] : [...exact, ...rawCandidates];
                nextCandidates = dedupeCandidatesByLatex(merged)
                    .slice(0, SLASH_COMMAND_CANDIDATE_LIMIT)
                    .map(applySlashCommandHint);
            }
        }
        else {
            nextCandidates = buildWordCandidates(tokenMatch.token, {
                allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
                allowedPacks,
                dedupeByLatex: !explicit,
            });
        }
        const allowSuffixRescue = explicit && tokenMatch.kind === "word" && tokenMatch.token.length >= EXPLICIT_SUFFIX_MIN_LENGTH;
        if (allowSuffixRescue && nextCandidates.length === 0) {
            const minSuffixLength = 2;
            for (let dropPrefix = 1; dropPrefix <= tokenMatch.token.length - minSuffixLength; dropPrefix += 1) {
                const suffix = tokenMatch.token.slice(dropPrefix);
                const suffixCandidates = buildWordCandidates(suffix, {
                    allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
                    allowedPacks,
                    dedupeByLatex: !explicit,
                });
                if (suffixCandidates.length === 0) {
                    continue;
                }
                effectiveMatch = {
                    ...tokenMatch,
                    token: suffix,
                    range: { start: tokenMatch.range.start + dropPrefix, end: tokenMatch.range.end },
                };
                nextCandidates = suffixCandidates;
                break;
            }
        }
        if (nextCandidates.length === 0) {
            runtime.panelState.currentCandidates = [];
            runtime.currentRange = null;
            runtime.currentTokenMatch = null;
            panelOps.setPanelVisible(false);
            return;
        }
        nextCandidates = mruOps.applyMruRanking(nextCandidates);
        const sameList = runtime.panelState.currentCandidates.length === nextCandidates.length &&
            runtime.panelState.currentCandidates.every((item, idx) => item.id === nextCandidates[idx].id);
        runtime.panelState.currentCandidates = nextCandidates;
        runtime.currentRange = effectiveMatch.range;
        runtime.currentTokenMatch = effectiveMatch;
        if (!sameList) {
            runtime.panelState.selectedIndex = 0;
        }
        else {
            runtime.panelState.selectedIndex = Math.max(0, Math.min(runtime.panelState.selectedIndex, runtime.panelState.currentCandidates.length - 1));
        }
        panelOps.ensurePanel();
        panelOps.setPanelVisible(true);
        panelOps.renderPanel();
    };
    return {
        updateCandidates,
        getWordCandidates,
        openCustomCandidates,
        buildExplicitFallbackCandidates,
    };
};
