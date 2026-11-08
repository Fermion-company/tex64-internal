export type EditorTabLabel = {
  /** The file name, always shown. */
  name: string;
  /** Folder path shown quietly after the name; "" when nothing is needed. */
  detail: string;
};

/**
 * Labels for one tab strip, in the order of `paths`. A file whose name is
 * unique in the strip shows the name alone. Files sharing a name each add the
 * shortest trailing folder path that no other file of that name ends with
 * (`main.tex` and `appendix/main.tex` → "" and "appendix"; `a/x/main.tex` and
 * `b/x/main.tex` → "a/x" and "b/x"). A file that cannot be told apart by a
 * shorter tail, such as one at the workspace root, shows its whole folder
 * path, which is "" at the root. The full path stays in the tooltip.
 */
export const editorTabLabels = (paths: readonly string[]): EditorTabLabel[] => {
  const entries = paths.map((path) => {
    const folders = path.split("/").filter((part) => part.length > 0);
    const name = folders.pop() ?? path;
    return { name, folders };
  });
  const tail = (folders: readonly string[], depth: number) =>
    folders.slice(folders.length - depth).join("/");
  return entries.map((entry, index) => {
    const others = entries.filter(
      (other, otherIndex) => otherIndex !== index && other.name === entry.name
    );
    if (others.length === 0) {
      return { name: entry.name, detail: "" };
    }
    const { folders } = entry;
    for (let depth = 1; depth <= folders.length; depth += 1) {
      const candidate = tail(folders, depth);
      const shared = others.some(
        (other) => other.folders.length >= depth && tail(other.folders, depth) === candidate
      );
      if (!shared) {
        return { name: entry.name, detail: candidate };
      }
    }
    return { name: entry.name, detail: folders.join("/") };
  });
};
