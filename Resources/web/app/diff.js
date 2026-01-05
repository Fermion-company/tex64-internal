export const buildLineDiff = (beforeLines, afterLines) => {
    const rows = beforeLines.length;
    const cols = afterLines.length;
    const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
    for (let i = 1; i <= rows; i += 1) {
        for (let j = 1; j <= cols; j += 1) {
            if (beforeLines[i - 1] === afterLines[j - 1]) {
                table[i][j] = table[i - 1][j - 1] + 1;
            }
            else {
                table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
            }
        }
    }
    const diff = [];
    let i = rows;
    let j = cols;
    while (i > 0 && j > 0) {
        if (beforeLines[i - 1] === afterLines[j - 1]) {
            diff.push({ type: "same", line: beforeLines[i - 1] });
            i -= 1;
            j -= 1;
        }
        else if (table[i - 1][j] >= table[i][j - 1]) {
            diff.push({ type: "del", line: beforeLines[i - 1] });
            i -= 1;
        }
        else {
            diff.push({ type: "add", line: afterLines[j - 1] });
            j -= 1;
        }
    }
    while (i > 0) {
        diff.push({ type: "del", line: beforeLines[i - 1] });
        i -= 1;
    }
    while (j > 0) {
        diff.push({ type: "add", line: afterLines[j - 1] });
        j -= 1;
    }
    return diff.reverse();
};
export const buildDiffPreview = (before, after) => {
    const beforeText = before.trimEnd();
    const afterText = after.trimEnd();
    if (beforeText === afterText) {
        return "変更なし";
    }
    const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""];
    const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""];
    const diffLines = buildLineDiff(beforeLines, afterLines);
    const header = "差分（-削除 / +追加）";
    const body = diffLines
        .map((entry) => {
        const prefix = entry.type === "add" ? "+" : entry.type === "del" ? "-" : " ";
        return `${prefix} ${entry.line}`;
    })
        .join("\n");
    return `${header}\n${body}`;
};
