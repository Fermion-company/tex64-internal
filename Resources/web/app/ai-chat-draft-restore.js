export const hasComposerDraft = (draft) => Boolean(draft && (draft.text.length || draft.attachments.length || draft.place));
