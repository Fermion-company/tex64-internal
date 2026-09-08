export const historyVersionTitle = (version, versions, labels) => {
    if (version.kind === "safety") {
        return versions.some((item) => item.preRestore === version.id)
            ? labels.beforeRestore : labels.interruptedRestore;
    }
    if (version.label)
        return version.label;
    if (version.kind === "restore") {
        const target = versions.find((item) => item.id === version.restoredFrom);
        return (target === null || target === void 0 ? void 0 : target.kind) === "safety"
            ? labels.returned : labels.restored((target === null || target === void 0 ? void 0 : target.label) || labels.unnamed);
    }
    return labels.unnamed;
};
const pad = (value) => String(value).padStart(2, "0");
const localDay = (date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
export const historyDateLabels = (versions, now = new Date()) => {
    var _a;
    // One record per ID. Repeated references to a version do not create a
    // timestamp collision; the first record is authoritative, as in title lookup.
    const unique = new Map();
    for (const version of versions)
        if (!unique.has(version.id))
            unique.set(version.id, version);
    const dates = new Map();
    const minutes = new Map();
    const seconds = new Map();
    for (const version of unique.values()) {
        const date = new Date(version.createdAt);
        if (!Number.isFinite(date.getTime()))
            throw new RangeError(`Invalid history date: ${version.id}`);
        dates.set(version.id, date);
        const minute = `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        const second = `${minute}:${pad(date.getSeconds())}`;
        minutes.set(minute, [...(minutes.get(minute) || []), version.id]);
        seconds.set(second, [...(seconds.get(second) || []), version.id]);
    }
    const suffixes = new Map();
    for (const ids of seconds.values()) {
        if (ids.length < 2)
            continue;
        // Use a common prefix length so short or shared-prefix IDs stay distinct.
        let length = Math.min(4, Math.max(...ids.map((id) => id.length)));
        while (new Set(ids.map((id) => id.slice(0, length))).size < ids.length)
            length += 1;
        for (const id of ids)
            suffixes.set(id, ` · ${id.slice(0, length)}`);
    }
    const result = new Map();
    for (const [id, date] of dates) {
        const day = localDay(date);
        const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        const showSeconds = (((_a = minutes.get(`${day} ${hm}`)) === null || _a === void 0 ? void 0 : _a.length) || 0) > 1;
        const time = `${hm}${showSeconds ? `:${pad(date.getSeconds())}` : ""}${suffixes.get(id) || ""}`;
        const group = `${date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}/`}${date.getMonth() + 1}/${date.getDate()}`;
        const offset = -date.getTimezoneOffset();
        const zone = `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
        result.set(id, {
            group,
            today: day === localDay(now),
            time,
            compact: `${group} ${time}`,
            exact: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hm}:${pad(date.getSeconds())} (${zone})`,
        });
    }
    return result;
};
