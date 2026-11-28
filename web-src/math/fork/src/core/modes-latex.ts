import { Mode } from './modes-utils';
import { Atom } from './atom';

import { LatexAtom, LatexGroupAtom } from '../atoms/latex';
import type { ToLatexOptions } from './types';

export class LatexMode extends Mode {
  constructor() {
    super('latex');
  }

  createAtom(command: string): Atom | null {
    return new LatexAtom(command);
  }

  serialize(run: Atom[], options: ToLatexOptions): string[] {
    return run.map((atom) => {
      if (atom instanceof LatexGroupAtom) return atom._serialize(options);
      return atom instanceof LatexAtom && !atom.isSuggestion ? atom.value : '';
    });
  }

  getFont(): null {
    return null;
  }
}

new LatexMode();
