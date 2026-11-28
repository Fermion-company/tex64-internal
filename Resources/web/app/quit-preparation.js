/**
 * Stop native writers, drain every dirty Code buffer and then the shared
 * documents (a peer's edit to a file this window never opened has no buffer
 * here), and only then freeze the renderer for final process teardown. A save
 * pass or the drain can itself receive editor input while waiting for native
 * acknowledgements, so re-check the live dirty set and repeat until it is
 * empty in the same JS turn that freezes the UI. An IME composition still
 * open (its text is not in the buffer yet) cancels with its own message.
 */
export const prepareRendererForQuit = async (input) => {
    var _a, _b, _c, _d, _e, _f;
    const pendingInput = (_a = input.getCompositionError) === null || _a === void 0 ? void 0 : _a.call(input);
    if (pendingInput)
        return { ok: false, phase: "save", error: pendingInput };
    let quiet;
    try {
        quiet = await input.quiesce();
    }
    catch (error) {
        return {
            ok: false,
            phase: "quiesce",
            error: error instanceof Error ? error.message : "Could not stop active work.",
        };
    }
    if (!quiet.ok) {
        return { ok: false, phase: "quiesce", error: quiet.error };
    }
    const maxSavePasses = Math.max(1, Math.floor((_b = input.maxSavePasses) !== null && _b !== void 0 ? _b : 100));
    let savePasses = 0;
    try {
        while (true) {
            const compositionError = (_c = input.getCompositionError) === null || _c === void 0 ? void 0 : _c.call(input);
            if (compositionError)
                return { ok: false, phase: "save", error: compositionError };
            if (input.getDirtyFileCount() > 0) {
                if (savePasses >= maxSavePasses)
                    break;
                savePasses++;
                if (!await input.saveDirtyFiles())
                    return { ok: false, phase: "save", error: "Saving failed." };
                continue;
            }
            // Shared changes can be pending even for files the editor never opened.
            let drained = true;
            try {
                drained = (_e = (await ((_d = input.drainShared) === null || _d === void 0 ? void 0 : _d.call(input)))) !== null && _e !== void 0 ? _e : true;
            }
            catch {
                drained = false;
            }
            if (!drained)
                return { ok: false, phase: "save" };
            if (input.getDirtyFileCount() > 0 || ((_f = input.getCompositionError) === null || _f === void 0 ? void 0 : _f.call(input)))
                continue;
            input.freeze();
            return { ok: true };
        }
    }
    catch (error) {
        return { ok: false, phase: "save", error: error instanceof Error ? error.message : "Saving failed." };
    }
    return {
        ok: false,
        phase: "save",
        error: "Files kept changing while the application was preparing to quit.",
    };
};
