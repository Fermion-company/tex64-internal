/** Remove one optional outer tikzpicture wrapper while preserving its body. */
export const stripTikzWrapper = (tex) => {
    const normalized = tex.replace(/\r\n?/g, "\n");
    const match = normalized.match(/^\s*\\begin\{tikzpicture\}(?:\s*\[[^\]]*\])?\s*\n?([\s\S]*?)\n?\s*\\end\{tikzpicture\}\s*$/);
    return (match ? match[1] : normalized).trim();
};
