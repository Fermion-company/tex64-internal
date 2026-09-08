import type { Atom } from '../core/atom-class';
import type { ArrayAtom } from '../atoms/array';
import type { ModelAtomMetadata } from '../public/core-types';
import { modelAtomId } from './atom-identity';

/** One operation's logical snapshot. No DOM reads or LaTeX serialization. */
export function modelAtomMetadata(atoms: readonly Atom[]): ModelAtomMetadata[] {
  const offsets = new Map(atoms.map((atom, offset) => [atom, offset]));
  const depths = new Map<Atom, number>();
  const before = new Map<Atom, number>();
  const seenBranches = new Set<readonly Atom[]>();
  const depthOf = (atom: Atom): number => {
    const pending: Atom[] = [];
    let cursor: Atom | undefined = atom;
    while (cursor && !depths.has(cursor)) {
      pending.push(cursor);
      cursor = cursor.parent;
    }
    let depth = cursor ? depths.get(cursor)! : 0;
    while (pending.length) depths.set(pending.pop()!, ++depth);
    return depths.get(atom)! - 2;
  };
  return atoms.map((atom, offset) => {
    const result: ModelAtomMetadata = {
      offset, modelId: modelAtomId(atom), type: atom.type, mode: atom.mode,
      command: atom.command, depth: depthOf(atom),
    };
    if (atom.parent) {
      result.parentOffset = offsets.get(atom.parent) ?? -1;
      result.parentBranch = Array.isArray(atom.parentBranch)
        ? [...atom.parentBranch] : atom.parentBranch;
    }
    if (atom.value && atom.type !== 'first') {
      result.symbol = atom.value;
      const siblings = atom.siblings;
      if (!seenBranches.has(siblings)) {
        seenBranches.add(siblings);
        siblings.forEach((sibling, index) => before.set(sibling, offsets.get(siblings[index - 1]) ?? -1));
      }
      result.beforeOffset = before.get(atom) ?? -1;
    }
    if (atom.type === 'array') {
      const array = atom as ArrayAtom;
      result.array = {
        rows: array.rowCount, columns: array.colCount,
        alignments: array.colFormat.flatMap(column => 'align' in column ? [column.align] : []),
      };
    }
    return result;
  });
}
