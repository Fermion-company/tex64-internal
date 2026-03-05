import type { WysiwygPackId } from "../math-wysiwyg-packs.js";

export type WysiwygTriggerCandidate = {
  latex: string;
  label: string;
  displayLatex?: string;
};

export type WysiwygManualTrigger = {
  trigger: string;
  priority: number;
  candidates: WysiwygTriggerCandidate[];
  pack?: WysiwygPackId;
};

export type WysiwygAliasTrigger = {
  alias: string;
  canonical: string;
  priorityBoost?: number;
};
