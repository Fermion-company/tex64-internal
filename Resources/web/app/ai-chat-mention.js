/**
 * @-mention picker for the AI chat input.
 *
 * Typing `@` opens a list of what the request can point at: files of the
 * workspace, sections of the document, labels, bib entries, and the latest
 * build issues. Picking one puts a short handle into the text and records
 * the exact place (path, line range, key) so the host can start there.
 */
import { aiText } from "./ai-i18n.js";
const MAX_VISIBLE_ITEMS = 12;
const MAX_PER_GROUP = 5;
const GROUP_ORDER = ["section", "label", "file", "bib", "issue"];
const GROUP_LABEL_KEY = {
    file: "mention_files",
    section: "mention_sections",
    label: "mention_labels",
    bib: "mention_bib",
    issue: "mention_issues",
};
const fileName = (path) => path.split("/").pop() || path;
/** The handle written into the draft for a candidate. */
const handleFor = (candidate) => {
    switch (candidate.kind) {
        case "file":
            return candidate.path;
        case "section":
            return `§${candidate.title || candidate.id}`;
        case "label":
            return candidate.key;
        case "bib":
            return candidate.key;
        case "issue":
            return candidate.path ? `${candidate.path}${candidate.line ? `:${candidate.line}` : ""}` : "issue";
    }
};
const searchText = (candidate) => {
    var _a, _b, _c;
    switch (candidate.kind) {
        case "file":
            return candidate.path;
        case "section":
            return `${(_a = candidate.number) !== null && _a !== void 0 ? _a : ""} ${candidate.title} ${candidate.path}`;
        case "label":
            return `${candidate.key} ${candidate.path}`;
        case "bib":
            return `${candidate.key} ${(_b = candidate.title) !== null && _b !== void 0 ? _b : ""}`;
        case "issue":
            return `${candidate.message} ${(_c = candidate.path) !== null && _c !== void 0 ? _c : ""}`;
    }
};
const toRef = (candidate) => {
    switch (candidate.kind) {
        case "file":
            return { kind: "file", path: candidate.path };
        case "section":
            return {
                kind: "section",
                path: candidate.path,
                id: candidate.id,
                title: candidate.title,
                line: candidate.line,
                endLine: candidate.endLine,
            };
        case "label":
            return { kind: "label", key: candidate.key, path: candidate.path, line: candidate.line };
        case "bib":
            return { kind: "bib", key: candidate.key, path: candidate.path, ...(candidate.title ? { title: candidate.title } : {}) };
        case "issue":
            return {
                kind: "issue",
                message: candidate.message,
                ...(candidate.path ? { path: candidate.path } : {}),
                ...(candidate.line ? { line: candidate.line } : {}),
            };
    }
};
export const createMentionController = (deps) => {
    var _a;
    const { aiInput, getCandidates, onOpen } = deps;
    let mentions = [];
    let previousValue = aiInput.value;
    // A mention belongs to its selected text. Editing elsewhere moves its
    // range; replacing or deleting the selection removes the structured context.
    const reconcileMentions = () => {
        const value = aiInput.value;
        if (value === previousValue)
            return;
        let prefix = 0;
        while (prefix < previousValue.length && prefix < value.length && previousValue[prefix] === value[prefix])
            prefix++;
        let oldEnd = previousValue.length;
        let newEnd = value.length;
        while (oldEnd > prefix && newEnd > prefix && previousValue[oldEnd - 1] === value[newEnd - 1]) {
            oldEnd--;
            newEnd--;
        }
        const shift = newEnd - oldEnd;
        mentions = mentions.flatMap(mention => {
            if (mention.end <= prefix)
                return [mention];
            if (mention.start >= oldEnd)
                return [{ ...mention, start: mention.start + shift, end: mention.end + shift }];
            return [];
        });
        previousValue = value;
    };
    const activeRefs = () => {
        reconcileMentions();
        const refs = new Map(mentions.map(({ ref }) => [JSON.stringify(ref), ref]));
        return [...refs.values()];
    };
    // ── Popover DOM ──
    const popover = document.createElement("div");
    popover.className = "ai-mention-popover";
    popover.style.display = "none";
    // Insert right before the input container so it floats above
    const inputArea = aiInput.closest(".ai-input-area");
    if (inputArea) {
        inputArea.appendChild(popover);
    }
    else {
        (_a = aiInput.parentElement) === null || _a === void 0 ? void 0 : _a.appendChild(popover);
    }
    let items = [];
    let selectedIndex = 0;
    let mentionStart = -1; // cursor position where '@' was typed
    let query = "";
    const hide = () => {
        popover.style.display = "none";
        mentionStart = -1;
        items = [];
        selectedIndex = 0;
        query = "";
    };
    const renderRow = (candidate, index) => {
        var _a;
        const item = document.createElement("div");
        item.className = `ai-mention-item is-${candidate.kind}`;
        if (index === selectedIndex)
            item.classList.add("is-selected");
        const main = document.createElement("span");
        main.className = "ai-mention-main";
        const meta = document.createElement("span");
        meta.className = "ai-mention-meta";
        switch (candidate.kind) {
            case "file":
                main.textContent = fileName(candidate.path);
                meta.textContent = candidate.path.includes("/") ? candidate.path : "";
                break;
            case "section":
                main.textContent = `${candidate.number ? `${candidate.number} ` : ""}${candidate.title}`;
                meta.textContent = `${fileName(candidate.path)} L${candidate.line}–${candidate.endLine}`;
                break;
            case "label":
                main.textContent = candidate.key;
                meta.textContent = `${fileName(candidate.path)}:${candidate.line}`;
                break;
            case "bib":
                main.textContent = candidate.key;
                meta.textContent = (_a = candidate.title) !== null && _a !== void 0 ? _a : fileName(candidate.path);
                break;
            case "issue":
                main.textContent = candidate.message;
                meta.textContent = candidate.path ? `${fileName(candidate.path)}${candidate.line ? `:${candidate.line}` : ""}` : "";
                break;
        }
        item.append(main, meta);
        item.addEventListener("mousedown", (e) => {
            e.preventDefault(); // prevent textarea blur
            selectItem(index);
        });
        item.addEventListener("mouseenter", () => {
            selectedIndex = index;
            updateSelection();
        });
        return item;
    };
    const renderItems = () => {
        popover.innerHTML = "";
        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "ai-mention-empty";
            empty.textContent = aiText("mention_empty");
            popover.appendChild(empty);
            return;
        }
        let lastKind = null;
        items.forEach((candidate, index) => {
            if (candidate.kind !== lastKind) {
                const head = document.createElement("div");
                head.className = "ai-mention-group";
                head.textContent = aiText(GROUP_LABEL_KEY[candidate.kind]);
                popover.appendChild(head);
                lastKind = candidate.kind;
            }
            popover.appendChild(renderRow(candidate, index));
        });
    };
    const updateSelection = () => {
        const children = popover.querySelectorAll(".ai-mention-item");
        children.forEach((child, i) => {
            child.classList.toggle("is-selected", i === selectedIndex);
        });
        const selected = children[selectedIndex];
        if (selected instanceof HTMLElement)
            selected.scrollIntoView({ block: "nearest" });
    };
    const selectItem = (index) => {
        const candidate = items[index];
        if (!candidate || mentionStart < 0) {
            hide();
            return;
        }
        const handle = handleFor(candidate);
        const before = aiInput.value.slice(0, mentionStart);
        const after = aiInput.value.slice(aiInput.selectionStart);
        aiInput.value = `${before}${handle} ${after}`;
        const newPos = before.length + handle.length + 1;
        aiInput.setSelectionRange(newPos, newPos);
        aiInput.dispatchEvent(new Event("input", { bubbles: true }));
        mentions.push({ ref: toRef(candidate), start: before.length - 1, end: before.length + handle.length });
        hide();
        aiInput.focus();
    };
    const filterCandidates = (rawQuery) => {
        var _a, _b, _c, _d, _e;
        const lower = rawQuery.trim().toLowerCase();
        const all = getCandidates();
        const groups = new Map();
        for (const candidate of all) {
            if (lower && !searchText(candidate).toLowerCase().includes(lower))
                continue;
            const list = (_a = groups.get(candidate.kind)) !== null && _a !== void 0 ? _a : [];
            if (list.length >= (lower ? MAX_PER_GROUP * 2 : MAX_PER_GROUP))
                continue;
            list.push(candidate);
            groups.set(candidate.kind, list);
        }
        // Every group with matches gets rows: rounds over the groups until the
        // list is full, so bib entries and issues are not pushed out by sections.
        const taken = new Map();
        let total = 0;
        let progressed = true;
        while (total < MAX_VISIBLE_ITEMS && progressed) {
            progressed = false;
            for (const kind of GROUP_ORDER) {
                const list = (_b = groups.get(kind)) !== null && _b !== void 0 ? _b : [];
                const count = (_c = taken.get(kind)) !== null && _c !== void 0 ? _c : 0;
                if (count >= list.length || total >= MAX_VISIBLE_ITEMS)
                    continue;
                taken.set(kind, count + 1);
                total += 1;
                progressed = true;
            }
        }
        const ordered = [];
        for (const kind of GROUP_ORDER) {
            ordered.push(...((_d = groups.get(kind)) !== null && _d !== void 0 ? _d : []).slice(0, (_e = taken.get(kind)) !== null && _e !== void 0 ? _e : 0));
        }
        return ordered;
    };
    const open = (position) => {
        mentionStart = position;
        query = "";
        items = filterCandidates("");
        selectedIndex = 0;
        popover.style.display = "block";
        renderItems();
        onOpen === null || onOpen === void 0 ? void 0 : onOpen();
    };
    const onInput = () => {
        reconcileMentions();
        const cursorPos = aiInput.selectionStart;
        if (mentionStart < 0) {
            const before = aiInput.value.slice(0, cursorPos);
            if (before.endsWith("@"))
                open(cursorPos);
            else {
                const pasted = /(?:^|\s)@([^\s@]+)$/u.exec(before);
                if (pasted)
                    open(cursorPos - pasted[1].length);
            }
            if (mentionStart < 0)
                return;
        }
        if (cursorPos < mentionStart) {
            hide();
            return;
        }
        query = aiInput.value.slice(mentionStart, cursorPos);
        // A section title or filename may itself contain spaces.
        if (/^\s|[\r\n]/u.test(query) || aiInput.value[mentionStart - 1] !== "@") {
            hide();
            return;
        }
        items = filterCandidates(query);
        selectedIndex = 0;
        renderItems();
    };
    const onKeyDown = (e) => {
        if (e.isComposing || e.keyCode === 229)
            return;
        if (mentionStart < 0) {
            // Check for @ trigger
            if (e.key === "@" || (e.key === "2" && e.shiftKey)) {
                // Will be handled in onInput after the character is inserted
                setTimeout(() => {
                    const pos = aiInput.selectionStart;
                    if (pos > 0 && aiInput.value[pos - 1] === "@" && mentionStart < 0)
                        open(pos);
                }, 0);
            }
            return;
        }
        // Popover is open — handle navigation
        if (e.key === "ArrowDown") {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, Math.max(0, items.length - 1));
            updateSelection();
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection();
            return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            if (items.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                selectItem(selectedIndex);
                return;
            }
            hide();
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            hide();
            return;
        }
    };
    const onBlur = () => {
        // Delay to allow mousedown on popover items
        setTimeout(() => {
            if (!popover.contains(document.activeElement)) {
                hide();
            }
        }, 150);
    };
    aiInput.addEventListener("input", onInput);
    aiInput.addEventListener("keydown", onKeyDown, true); // capture phase to intercept Enter
    aiInput.addEventListener("blur", onBlur);
    return {
        saveDraft: () => {
            reconcileMentions();
            return mentions.slice();
        },
        restoreDraft: (saved) => {
            hide();
            mentions = saved.slice();
            previousValue = aiInput.value;
        },
        getExplicitPaths: () => activeRefs().flatMap((ref) => (ref.kind === "file" ? [ref.path] : ref.kind === "section" ? [ref.path] : [])),
        getExplicitRefs: () => activeRefs().map((ref) => ({ ...ref })),
        clearExplicitPaths: () => {
            mentions = [];
        },
        refresh: () => {
            if (mentionStart < 0)
                return;
            items = filterCandidates(query);
            selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
            renderItems();
        },
        destroy: () => {
            aiInput.removeEventListener("input", onInput);
            aiInput.removeEventListener("keydown", onKeyDown, true);
            aiInput.removeEventListener("blur", onBlur);
            popover.remove();
        },
    };
};
