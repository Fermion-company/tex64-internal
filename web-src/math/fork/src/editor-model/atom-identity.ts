import type { Atom } from '../core/atom-class';

const identities = new WeakMap<object, number>();
let sequence = 0;

export const modelAtomId = (atom: object): number => {
  let id = identities.get(atom);
  if (id === undefined) {
    id = ++sequence;
    identities.set(atom, id);
  }
  return id;
};

export type ModelAtomIdentity = { id: number; shape: string };
const shape = (atom: Atom) => JSON.stringify([
  atom.type, atom.value, atom.mode, atom.treeDepth, atom.parentBranch,
]);

export const captureModelAtomIdentities = (atoms: readonly Atom[]): ModelAtomIdentity[] =>
  atoms.map(atom => ({ id: modelAtomId(atom), shape: shape(atom) }));

export const restoreModelAtomIdentities = (
  atoms: readonly Atom[], saved?: ModelAtomIdentity[]
): void => {
  // Only an internal, structurally identical Undo snapshot restores lineage.
  // Ordinary JSON/LaTeX insertion creates fresh identities.
  if (!saved || saved.length !== atoms.length || saved.some((item, at) =>
    !Number.isInteger(item.id) || item.id < 1 || item.shape !== shape(atoms[at]))) return;
  atoms.forEach((atom, at) => identities.set(atom, saved[at].id));
};
