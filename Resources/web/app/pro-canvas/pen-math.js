export const penSegmentFor = (prev, lastOut, anchor, handle) => {
    var _a, _b, _c, _d;
    if (!lastOut && !handle)
        return { type: "line", to: { ...anchor } };
    return { type: "cubic", c1: { x: prev.x + ((_a = lastOut === null || lastOut === void 0 ? void 0 : lastOut.x) !== null && _a !== void 0 ? _a : 0), y: prev.y + ((_b = lastOut === null || lastOut === void 0 ? void 0 : lastOut.y) !== null && _b !== void 0 ? _b : 0) }, c2: { x: anchor.x - ((_c = handle === null || handle === void 0 ? void 0 : handle.x) !== null && _c !== void 0 ? _c : 0), y: anchor.y - ((_d = handle === null || handle === void 0 ? void 0 : handle.y) !== null && _d !== void 0 ? _d : 0) }, to: { ...anchor } };
};
