import type { MonacoModel, MonacoModelContentChange } from "./types.js";

type Change = { offset: number; text: string; removed: string };
type Revision = { version: number; length: number; hash: number; changes: Change[]; cost: number };
type History = {
  identity: object;
  version: number;
  text: string;
  revisions: Revision[];
  cost: number;
};
export type LiveEditAnchor = {
  identity: object;
  version: number;
  startOffset: number;
  endOffset: number;
};

const histories = new WeakMap<MonacoModel, History>();
// Keep minutes of typing without retaining a full document for every key.
const MAX_REVISIONS = 4096;
const MAX_CHANGE_UNITS = 4 * 1024 * 1024;

const hashText = (text: string) => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash;
};

const resetHistory = (history: History, text: string) => {
  history.version += 1;
  history.text = text;
  history.revisions = [];
  history.cost = 0;
};

const recordChanges = (history: History, current: string, edits: MonacoModelContentChange[]) => {
  const previous = history.text;
  const changes: Change[] = [];
  let reconstructed = previous;
  // Monaco emits a batch from the end backwards, and deferred events may
  // concatenate successive batches. Preserve its order instead of sorting.
  for (const edit of edits) {
    const { rangeOffset: offset, rangeLength: length, text } = edit;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || length < 0 ||
        offset < 0 || offset + length > reconstructed.length || typeof text !== "string") {
      resetHistory(history, current);
      return;
    }
    changes.push({ offset, text, removed: reconstructed.slice(offset, offset + length) });
    reconstructed = reconstructed.slice(0, offset) + text + reconstructed.slice(offset + length);
  }
  // A flush/EOL normalization or an unsupported event must never invent a map.
  if (reconstructed !== current) {
    resetHistory(history, current);
    return;
  }
  if (previous === current && !changes.length) return;
  const cost = changes.reduce((sum, change) => sum + 32 + change.text.length + change.removed.length, 0);
  history.revisions.push({ version: history.version, length: previous.length, hash: hashText(previous), changes, cost });
  history.version += 1;
  history.text = current;
  history.cost += cost;
  while (history.revisions.length > MAX_REVISIONS || history.cost > MAX_CHANGE_UNITS) {
    history.cost -= history.revisions.shift()!.cost;
  }
};

export const trackLiveEditModel = (model: MonacoModel) => {
  let history = histories.get(model);
  if (history) {
    if (history.text !== model.getValue()) resetHistory(history, model.getValue());
    return history;
  }
  history = { identity: {}, version: 0, text: model.getValue(), revisions: [], cost: 0 };
  histories.set(model, history);
  const tracked = history;
  const contentListener = model.onDidChangeContent?.((event) => {
    if (event.isFlush) resetHistory(tracked, model.getValue());
    else recordChanges(tracked, model.getValue(), event.changes);
  });
  model.onWillDispose?.(() => {
    contentListener?.dispose();
    resetHistory(tracked, "");
    histories.delete(model);
  });
  return history;
};

const moveRange = (start: number, end: number, changes: Change[]) => {
  for (const change of changes) {
    const changeEnd = change.offset + change.removed.length;
    if (start === end && change.offset === start) return null;
    if (changeEnd <= start) {
      const delta = change.text.length - change.removed.length;
      start += delta;
      end += delta;
    }
    else if (change.offset < end) return null;
  }
  return { startOffset: start, endOffset: end };
};

const anchorAtCurrent = (history: History, startOffset: number, endOffset: number): LiveEditAnchor | null => {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) ||
      startOffset < 0 || endOffset < startOffset || endOffset > history.text.length) return null;
  return { identity: history.identity, version: history.version, startOffset, endOffset };
};

export const captureLiveEditAnchor = (model: MonacoModel, start: number, end: number) =>
  anchorAtCurrent(trackLiveEditModel(model), start, end);

export const rebaseLiveEditAnchor = (model: MonacoModel, anchor: LiveEditAnchor) => {
  const history = trackLiveEditModel(model);
  if (anchor.identity !== history.identity) return null;
  if (anchor.version === history.version) return anchorAtCurrent(history, anchor.startOffset, anchor.endOffset);
  const index = history.revisions.findIndex((revision) => revision.version === anchor.version);
  if (index < 0) return null;
  let range = { startOffset: anchor.startOffset, endOffset: anchor.endOffset };
  for (let i = index; i < history.revisions.length; i += 1) {
    range = moveRange(range.startOffset, range.endOffset, history.revisions[i].changes);
    if (!range) return null;
  }
  return anchorAtCurrent(history, range.startOffset, range.endOffset);
};

export const anchorFromLiveEditSnapshot = (
  model: MonacoModel, sourceText: string, startOffset: number, endOffset: number
) => {
  const history = trackLiveEditModel(model);
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) ||
      startOffset < 0 || endOffset < startOffset || endOffset > sourceText.length) return null;
  if (history.text === sourceText) return anchorAtCurrent(history, startOffset, endOffset);
  const hash = hashText(sourceText);
  const candidates = history.revisions.map((revision, index) =>
    revision.length === sourceText.length && revision.hash === hash ? index : -1
  ).filter((index) => index >= 0);
  if (!candidates.length) return null;

  let text = history.text;
  let restoredIndex = history.revisions.length;
  // A snapshot names an absolute source range, not a logical text identity.
  // The newest exact state also permits editing again after Undo restores it.
  for (const index of candidates.reverse()) {
    while (restoredIndex > index) {
      const revision = history.revisions[--restoredIndex];
      for (let i = revision.changes.length - 1; i >= 0; i -= 1) {
        const change = revision.changes[i];
        text = text.slice(0, change.offset) + change.removed + text.slice(change.offset + change.text.length);
      }
    }
    if (text !== sourceText) continue; // Hashes only select candidates; equality is exact.
    const version = history.revisions[index]?.version ?? history.version;
    return rebaseLiveEditAnchor(model, { identity: history.identity, version, startOffset, endOffset });
  }
  return null;
};
