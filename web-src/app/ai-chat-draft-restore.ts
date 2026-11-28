import type { AiImageAttachment } from "./ai-chat-attachments.js";
import type { DraftMention } from "./ai-chat-mention.js";

export type ComposerDraft = {
  text: string;
  attachments: AiImageAttachment[];
  mentions: DraftMention[];
  place: { page: number; path: string; line: number; text: string } | null;
};

export const hasComposerDraft = (draft: ComposerDraft | undefined) =>
  Boolean(draft && (draft.text.length || draft.attachments.length || draft.place));
