// Snippet store shared by the panel and the editor completion provider.
// The main process owns the files (electron/services/snippets.cjs); this keeps
// one in-memory copy so Monaco can answer a completion request synchronously.

export type SnippetScope = "builtin" | "global" | "workspace";

export type Snippet = {
  id: string;
  name: string;
  prefix: string;
  description: string;
  body: string;
  scope: SnippetScope;
};

type SnippetsBridge = {
  list: () => Promise<{ ok?: boolean; snippets?: Snippet[]; error?: string }>;
  save: (snippet: Partial<Snippet>) => Promise<{ ok?: boolean; snippet?: Snippet; error?: string }>;
  remove: (id: string, scope: SnippetScope) => Promise<{ ok?: boolean; error?: string }>;
};

const getBridge = (): SnippetsBridge | null => {
  const bridge = (window as unknown as { tex64Snippets?: SnippetsBridge }).tex64Snippets;
  return bridge && typeof bridge.list === "function" ? bridge : null;
};

let snippets: Snippet[] = [];
const listeners = new Set<(items: Snippet[]) => void>();

const notify = () => {
  listeners.forEach((listener) => {
    try {
      listener(snippets);
    } catch {
      /* a broken listener must not stop the others */
    }
  });
};

export const getSnippets = (): Snippet[] => snippets;

export const onSnippetsChange = (listener: (items: Snippet[]) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const reloadSnippets = async (): Promise<Snippet[]> => {
  const bridge = getBridge();
  if (!bridge) {
    return snippets;
  }
  const result = await bridge.list();
  if (Array.isArray(result?.snippets)) {
    snippets = result.snippets;
    notify();
  }
  return snippets;
};

export const saveSnippet = async (snippet: Partial<Snippet>) => {
  const bridge = getBridge();
  if (!bridge) {
    return { ok: false, error: "Snippets are unavailable." };
  }
  const result = await bridge.save(snippet);
  if (result?.ok !== false) {
    await reloadSnippets();
  }
  return result;
};

export const deleteSnippet = async (id: string, scope: SnippetScope) => {
  const bridge = getBridge();
  if (!bridge) {
    return { ok: false, error: "Snippets are unavailable." };
  }
  const result = await bridge.remove(id, scope);
  if (result?.ok !== false) {
    await reloadSnippets();
  }
  return result;
};
