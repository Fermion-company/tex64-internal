export type HistoryVersion = {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  preRestore?: string;
  restoredFrom?: string;
};

export type HistoryTitleLabels = {
  unnamed: string;
  beforeRestore: string;
  interruptedRestore: string;
  returned: string;
  restored: (name: string) => string;
};

export const historyVersionTitle = (
  version: HistoryVersion,
  versions: readonly HistoryVersion[],
  labels: HistoryTitleLabels,
): string => {
  if (version.kind === "safety") {
    return versions.some((item) => item.preRestore === version.id)
      ? labels.beforeRestore : labels.interruptedRestore;
  }
  if (version.label) return version.label;
  if (version.kind === "restore") {
    const target = versions.find((item) => item.id === version.restoredFrom);
    return target?.kind === "safety"
      ? labels.returned : labels.restored(target?.label || labels.unnamed);
  }
  return labels.unnamed;
};

export type HistoryDateLabel = {
  group: string;
  today: boolean;
  time: string;
  compact: string;
  exact: string;
};

const pad = (value: number) => String(value).padStart(2, "0");
const localDay = (date: Date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;

export const historyDateLabels = (
  versions: readonly HistoryVersion[],
  now = new Date(),
): Map<string, HistoryDateLabel> => {
  // One record per ID. Repeated references to a version do not create a
  // timestamp collision; the first record is authoritative, as in title lookup.
  const unique = new Map<string, HistoryVersion>();
  for (const version of versions) if (!unique.has(version.id)) unique.set(version.id, version);
  const dates = new Map<string, Date>();
  const minutes = new Map<string, string[]>();
  const seconds = new Map<string, string[]>();
  for (const version of unique.values()) {
    const date = new Date(version.createdAt);
    if (!Number.isFinite(date.getTime())) throw new RangeError(`Invalid history date: ${version.id}`);
    dates.set(version.id, date);
    const minute = `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const second = `${minute}:${pad(date.getSeconds())}`;
    minutes.set(minute, [...(minutes.get(minute) || []), version.id]);
    seconds.set(second, [...(seconds.get(second) || []), version.id]);
  }
  const suffixes = new Map<string, string>();
  for (const ids of seconds.values()) {
    if (ids.length < 2) continue;
    // Use a common prefix length so short or shared-prefix IDs stay distinct.
    let length = Math.min(4, Math.max(...ids.map((id) => id.length)));
    while (new Set(ids.map((id) => id.slice(0, length))).size < ids.length) length += 1;
    for (const id of ids) suffixes.set(id, ` · ${id.slice(0, length)}`);
  }
  const result = new Map<string, HistoryDateLabel>();
  for (const [id, date] of dates) {
    const day = localDay(date);
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const showSeconds = (minutes.get(`${day} ${hm}`)?.length || 0) > 1;
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
