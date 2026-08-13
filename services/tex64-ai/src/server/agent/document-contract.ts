/**
 * The agent layer imports document-domain contracts through this file only.
 * Keeping the seam here prevents AI SDK details from leaking into the domain
 * and makes domain export changes a one-file adjustment.
 */
export {
  DocumentCitationStyleNameSchema,
  DocumentCitationStyleSchema,
  DocumentColumnCountSchema,
  DocumentLayoutPresetSchema,
  DocumentLayoutSchema,
  DocumentPageSizeSchema,
  DocumentOperationSchema,
  DocumentPatchSchema,
  DocumentSchema,
  type DocumentModel,
  type DocumentLayout,
  type DocumentCitationStyle,
  type DocumentNode,
  type DocumentOperation,
  type DocumentPatch,
  type StableId,
} from "@/domain/document";
