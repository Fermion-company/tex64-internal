import type { WysiwygManualTrigger } from "./triggers-data/types.js";
import { MANUAL_TRIGGERS_PART_1 } from "./triggers-data/manual-part-1.js";
import { MANUAL_TRIGGERS_PART_2 } from "./triggers-data/manual-part-2.js";
import { MANUAL_TRIGGERS_PART_3 } from "./triggers-data/manual-part-3.js";
import { MANUAL_TRIGGERS_PART_4 } from "./triggers-data/manual-part-4.js";

export const MANUAL_TRIGGERS: WysiwygManualTrigger[] = [
  ...MANUAL_TRIGGERS_PART_1,
  ...MANUAL_TRIGGERS_PART_2,
  ...MANUAL_TRIGGERS_PART_3,
  ...MANUAL_TRIGGERS_PART_4,
];

export { ALIAS_TRIGGERS } from "./triggers-data/alias.js";
