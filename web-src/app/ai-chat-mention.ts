/**
 * @-mention file picker for the AI chat input.
 *
 * When the user types `@` in the textarea, a dropdown appears with workspace files.
 * Selecting a file inserts the path into the textarea and tracks it in explicitContextPaths.
 */

type MentionControllerDeps = {
  aiInput: HTMLTextAreaElement;
  getWorkspaceFiles: () => string[];
};

type MentionController = {
  /** File paths explicitly mentioned via the @-picker in the current draft. */
  getExplicitPaths: () => string[];
  /** Clear tracked paths (call after sending a message). */
  clearExplicitPaths: () => void;
  /** Destroy the controller and remove event listeners. */
  destroy: () => void;
};

const MAX_VISIBLE_ITEMS = 8;

export const createMentionController = (deps: MentionControllerDeps): MentionController => {
  const { aiInput, getWorkspaceFiles } = deps;
  const explicitPaths: string[] = [];

  // ── Popover DOM ──
  const popover = document.createElement("div");
  popover.className = "ai-mention-popover";
  popover.style.display = "none";
  // Insert right before the input container so it floats above
  const inputArea = aiInput.closest(".ai-input-area");
  if (inputArea) {
    inputArea.appendChild(popover);
  } else {
    aiInput.parentElement?.appendChild(popover);
  }

  let items: string[] = [];
  let selectedIndex = 0;
  let mentionStart = -1; // cursor position where '@' was typed

  const hide = () => {
    popover.style.display = "none";
    mentionStart = -1;
    items = [];
    selectedIndex = 0;
  };

  const renderItems = () => {
    popover.innerHTML = "";
    const visible = items.slice(0, MAX_VISIBLE_ITEMS);
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-mention-empty";
      empty.textContent = "File not found";
      popover.appendChild(empty);
      return;
    }
    visible.forEach((filePath, index) => {
      const item = document.createElement("div");
      item.className = "ai-mention-item";
      if (index === selectedIndex) item.classList.add("is-selected");
      item.textContent = filePath;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent textarea blur
        selectItem(index);
      });
      item.addEventListener("mouseenter", () => {
        selectedIndex = index;
        updateSelection();
      });
      popover.appendChild(item);
    });
    if (items.length > MAX_VISIBLE_ITEMS) {
      const more = document.createElement("div");
      more.className = "ai-mention-more";
      more.textContent = `... ${items.length - MAX_VISIBLE_ITEMS} more`;
      popover.appendChild(more);
    }
  };

  const updateSelection = () => {
    const children = popover.querySelectorAll(".ai-mention-item");
    children.forEach((child, i) => {
      child.classList.toggle("is-selected", i === selectedIndex);
    });
  };

  const selectItem = (index: number) => {
    const filePath = items[index];
    if (!filePath || mentionStart < 0) {
      hide();
      return;
    }
    // Replace @query with the file path
    const before = aiInput.value.slice(0, mentionStart);
    const after = aiInput.value.slice(aiInput.selectionStart);
    aiInput.value = `${before}${filePath} ${after}`;
    const newPos = before.length + filePath.length + 1;
    aiInput.setSelectionRange(newPos, newPos);
    aiInput.dispatchEvent(new Event("input", { bubbles: true }));
    // Track the mentioned path
    if (!explicitPaths.includes(filePath)) {
      explicitPaths.push(filePath);
    }
    hide();
    aiInput.focus();
  };

  const filterFiles = (query: string) => {
    const allFiles = getWorkspaceFiles();
    const lowerQuery = query.toLowerCase();
    if (!lowerQuery) return allFiles.slice(0, 50);
    return allFiles
      .filter((f) => f.toLowerCase().includes(lowerQuery))
      .slice(0, 50);
  };

  const onInput = () => {
    // IME fallback: detect @ insertion via input event when keydown didn't trigger
    if (mentionStart < 0) {
      const cursorPos = aiInput.selectionStart;
      if (cursorPos > 0 && aiInput.value[cursorPos - 1] === "@") {
        mentionStart = cursorPos;
        items = filterFiles("");
        selectedIndex = 0;
        popover.style.display = "block";
        renderItems();
      }
      return;
    }
    const cursorPos = aiInput.selectionStart;
    if (cursorPos < mentionStart) {
      hide();
      return;
    }
    const query = aiInput.value.slice(mentionStart, cursorPos);
    // If user typed a space after @, cancel the mention
    if (query.includes(" ") || query.includes("\n")) {
      hide();
      return;
    }
    items = filterFiles(query);
    selectedIndex = 0;
    renderItems();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (mentionStart < 0) {
      // Check for @ trigger
      if (e.key === "@" || (e.key === "2" && e.shiftKey)) {
        // Will be handled in onInput after the character is inserted
        // Set mentionStart after the @ character
        setTimeout(() => {
          const pos = aiInput.selectionStart;
          // Verify that an @ was actually inserted
          if (pos > 0 && aiInput.value[pos - 1] === "@") {
            mentionStart = pos;
            items = filterFiles("");
            selectedIndex = 0;
            popover.style.display = "block";
            renderItems();
          }
        }, 0);
      }
      return;
    }

    // Popover is open — handle navigation
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, Math.min(items.length, MAX_VISIBLE_ITEMS) - 1);
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
    getExplicitPaths: () => [...explicitPaths],
    clearExplicitPaths: () => {
      explicitPaths.length = 0;
    },
    destroy: () => {
      aiInput.removeEventListener("input", onInput);
      aiInput.removeEventListener("keydown", onKeyDown, true);
      aiInput.removeEventListener("blur", onBlur);
      popover.remove();
    },
  };
};
