// The "Try Axiom" announcement shows what Axiom does instead of describing it:
// a request, the lines Axiom changes in main.tex, and the typeset result, as a
// short demo for each of the two requests the announcement names. The server
// still owns the title, the plans link and the allowance text; the allowance
// waits behind a ▾.
import { getUiLocale } from "./i18n.js";
import { createExplain } from "./explain.js";
// The announcement that asked people to try Axiom on their manuscript; later
// ones can ask for this screen with `template: "axiom-try"`.
const AXIOM_TRY_IDS = new Set(["2026-10-22-free-axiom-manuscript"]);
export const isAxiomTryAnnouncement = (entry) => Boolean(entry && entry.kind === "info" && (entry.template === "axiom-try" || AXIOM_TRY_IDS.has(entry.id)));
const pick = (text) => text[getUiLocale()] || text.en;
const TEXT = {
    openAxiom: { en: "Open Axiom", ja: "Axiom を開く", zh: "打开 Axiom", ko: "Axiom 열기", fr: "Ouvrir Axiom", de: "Axiom öffnen", es: "Abrir Axiom" },
    allowance: { en: "Allowance", ja: "利用枠", zh: "额度", ko: "사용량", fr: "Quota", de: "Kontingent", es: "Cuota" },
    examples: { en: "Examples", ja: "例", zh: "示例", ko: "예시", fr: "Exemples", de: "Beispiele", es: "Ejemplos" },
};
const EXAMPLES = [
    {
        id: "steps",
        tab: { en: "Add steps", ja: "途中式を加える", zh: "补充中间步骤", ko: "중간 과정 추가", fr: "Ajouter les étapes", de: "Zwischenschritte", es: "Añadir pasos" },
        ask: {
            en: "Add the intermediate steps to this formula",
            ja: "この式に途中式を加えて",
            zh: "给这个公式补上中间步骤",
            ko: "이 수식에 중간 과정을 추가해 줘",
            fr: "Ajoute les étapes intermédiaires à cette formule",
            de: "Ergänze die Zwischenschritte dieser Formel",
            es: "Añade los pasos intermedios a esta fórmula",
        },
        lines: [
            { text: "\\begin{align*}" },
            { text: "  (a+b)^2" },
            { text: "    &= (a+b)(a+b) \\\\", change: "added" },
            { text: "    &= a^2 + ab + ba + b^2 \\\\", change: "added" },
            { text: "    &= a^2 + 2ab + b^2" },
            { text: "\\end{align*}" },
        ],
        before: [["(a+b)^2", "= a^2 + 2ab + b^2"]],
        after: [
            ["(a+b)^2", "= (a+b)(a+b)"],
            ["", "= a^2 + ab + ba + b^2"],
            ["", "= a^2 + 2ab + b^2"],
        ],
        changedRows: [0, 1],
    },
    {
        id: "fix",
        tab: { en: "Fix an error", ja: "組版エラーを直す", zh: "修复排版错误", ko: "조판 오류 수정", fr: "Corriger une erreur", de: "Satzfehler beheben", es: "Corregir un error" },
        ask: {
            en: "Fix this typesetting error",
            ja: "この組版エラーを直して",
            zh: "修复这个排版错误",
            ko: "이 조판 오류를 고쳐 줘",
            fr: "Corrige cette erreur de composition",
            de: "Behebe diesen Satzfehler",
            es: "Corrige este error de composición",
        },
        lines: [
            { text: "\\[" },
            { text: "  f(x) = \\frac{1}{2 + x^2", change: "removed" },
            { text: "  f(x) = \\frac{1}{2 + x^2}", change: "added" },
            { text: "\\]" },
        ],
        error: "! Missing } inserted.",
        before: null,
        after: [["f(x)", "= \\frac{1}{2 + x^2}"]],
        changedRows: [0],
    },
];
const tex = (expr) => {
    if (!expr)
        return "";
    try {
        if (typeof katex !== "undefined")
            return katex.renderToString(`\\displaystyle ${expr}`, { throwOnError: false });
    }
    catch { }
    const fallback = document.createElement("span");
    fallback.textContent = expr.replace(/^\{\}/, "");
    return fallback.innerHTML;
};
const el = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text)
        node.textContent = text;
    return node;
};
const SPARK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5c.4 2.9 1.6 4.1 4.5 4.5-2.9.4-4.1 1.6-4.5 4.5-.4-2.9-1.6-4.1-4.5-4.5C6.4 5.6 7.6 4.4 8 1.5Z" fill="currentColor"/><path d="M12.5 10c.2 1.3.7 1.8 2 2-1.3.2-1.8.7-2 2-.2-1.3-.7-1.8-2-2 1.3-.2 1.8-.7 2-2Z" fill="currentColor" opacity=".7"/></svg>';
// One typeset page: rows aligned on "=" like align*, the changed rows marked.
const page = (rows, changed) => {
    const grid = el("div", "axiom-try-math");
    rows.forEach(([left, right], index) => {
        const row = el("div", "axiom-try-math-row");
        if (changed.includes(index))
            row.classList.add("is-changed");
        row.style.setProperty("--i", String(index));
        const lhs = el("span", "axiom-try-math-lhs");
        lhs.innerHTML = tex(left);
        const rhs = el("span", "axiom-try-math-rhs");
        rhs.innerHTML = tex(`{}${right}`);
        row.append(lhs, rhs);
        grid.append(row);
    });
    return grid;
};
// Steps the stage to a phase. What is not on screen yet, or any more, is not
// read out either.
const setPhase = (stage, phase) => {
    stage.dataset.phase = String(phase);
    const hide = (selector, hidden) => stage.querySelectorAll(selector).forEach((node) => node.setAttribute("aria-hidden", String(hidden)));
    hide(".axiom-try-ask", phase < 1);
    hide(".axiom-try-delta, .axiom-try-lines li.is-added", phase < 2);
    hide(".axiom-try-page.is-before", phase >= 3);
    hide(".axiom-try-page.is-after", phase < 3);
};
const stageFor = (example) => {
    const stage = el("div", "axiom-try-stage");
    stage.dataset.example = example.id;
    const ask = el("div", "axiom-try-ask");
    const mark = el("span", "axiom-try-ask-mark");
    mark.innerHTML = SPARK;
    ask.append(mark, el("span", "axiom-try-ask-text", pick(example.ask)));
    const source = el("div", "axiom-try-pane axiom-try-source");
    const sourceHead = el("div", "axiom-try-pane-head");
    const added = example.lines.filter((line) => line.change === "added").length;
    const removed = example.lines.filter((line) => line.change === "removed").length;
    const delta = el("span", "axiom-try-delta");
    if (removed)
        delta.append(el("span", "is-removed", `−${removed}`));
    delta.append(el("span", "is-added", `+${added}`));
    sourceHead.append(el("span", "axiom-try-file", "main.tex"), delta);
    if (example.error)
        sourceHead.append(el("span", "axiom-try-error", example.error));
    const lines = el("ol", "axiom-try-lines");
    let addedIndex = 0;
    example.lines.forEach((line) => {
        const item = el("li", line.change ? `is-${line.change}` : "");
        if (line.change === "added")
            item.style.setProperty("--i", String(addedIndex++));
        const gutter = el("span", "axiom-try-gutter", line.change === "added" ? "+" : line.change === "removed" ? "−" : "");
        gutter.setAttribute("aria-hidden", "true");
        item.append(gutter, el("code", "", line.text));
        lines.append(item);
    });
    source.append(sourceHead, lines);
    const pdf = el("div", "axiom-try-pane axiom-try-pdf");
    const pdfHead = el("div", "axiom-try-pane-head");
    pdfHead.append(el("span", "axiom-try-file", "main.pdf"));
    const paper = el("div", "axiom-try-paper");
    const before = el("div", "axiom-try-page is-before");
    if (example.before)
        before.append(page(example.before, []));
    else
        before.append(el("span", "axiom-try-page-error", example.error || ""));
    const after = el("div", "axiom-try-page is-after");
    after.append(page(example.after, example.changedRows));
    paper.append(before, after);
    pdf.append(pdfHead, paper);
    const panes = el("div", "axiom-try-panes");
    panes.append(source, pdf);
    stage.append(ask, panes);
    setPhase(stage, 0);
    return stage;
};
// The demo, then the allowance behind a ▾ (the announcement's own text after
// its first paragraph, which the demo replaces).
export const renderAxiomTry = (allowanceParagraphs) => {
    var _a, _b;
    const root = el("div", "axiom-try");
    const tabs = el("div", "axiom-try-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", pick(TEXT.examples));
    const holder = el("div", "axiom-try-holder");
    holder.setAttribute("role", "tabpanel");
    holder.id = `axiom-try-panel-${Date.now().toString(36)}`;
    // Tab stops on the demo too; it is named by the selected tab.
    holder.tabIndex = 0;
    const reduceMotion = (_b = (_a = window.matchMedia) === null || _a === void 0 ? void 0 : _a.call(window, "(prefers-reduced-motion: reduce)").matches) !== null && _b !== void 0 ? _b : false;
    const timers = [];
    let current = 0;
    let autoplay = !reduceMotion;
    const clearTimers = () => { while (timers.length)
        window.clearTimeout(timers.pop()); };
    const buttons = EXAMPLES.map((example, index) => {
        const tab = el("button", "axiom-try-tab", pick(example.tab));
        tab.type = "button";
        tab.id = `${holder.id}-${example.id}`;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", holder.id);
        tab.addEventListener("click", () => { autoplay = false; show(index); });
        tab.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft")
                return;
            event.preventDefault();
            const next = (index + (event.key === "ArrowRight" ? 1 : EXAMPLES.length - 1)) % EXAMPLES.length;
            autoplay = false;
            show(next);
            buttons[next].focus();
        });
        tabs.append(tab);
        return tab;
    });
    // Request → changed lines → typeset page, then the next example until
    // someone picks one or looks closer.
    const show = (index) => {
        clearTimers();
        current = index;
        buttons.forEach((tab, at) => {
            tab.setAttribute("aria-selected", String(at === index));
            tab.tabIndex = at === index ? 0 : -1;
        });
        holder.setAttribute("aria-labelledby", buttons[index].id);
        const stage = stageFor(EXAMPLES[index]);
        holder.replaceChildren(stage);
        if (reduceMotion) {
            setPhase(stage, 3);
            return;
        }
        const at = (ms, phase) => timers.push(window.setTimeout(() => setPhase(stage, phase), ms));
        at(60, 1);
        at(900, 2);
        at(1700, 3);
        if (autoplay)
            timers.push(window.setTimeout(() => { if (autoplay)
                show((current + 1) % EXAMPLES.length); }, 5600));
    };
    // Someone looking closer (focus or pointer in the demo) keeps the example
    // they are on; the examples stop taking turns for good.
    const stopAutoplay = () => { autoplay = false; };
    root.addEventListener("focusin", stopAutoplay);
    root.addEventListener("pointerenter", stopAutoplay);
    root.append(tabs, holder);
    if (allowanceParagraphs.length) {
        const explain = createExplain(allowanceParagraphs, { topic: pick(TEXT.allowance) });
        const row = el("div", "axiom-try-allowance has-explain");
        row.append(el("span", "", pick(TEXT.allowance)), explain.button);
        root.append(row, explain.panel);
    }
    show(0);
    return { root, stop: () => { autoplay = false; clearTimers(); } };
};
export const axiomTryText = { openAxiom: () => pick(TEXT.openAxiom) };
