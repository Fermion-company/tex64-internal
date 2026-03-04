import type { ChatState } from "./ai-chat-state.js";

type CreateHistoryControllerParams = {
  aiHistory: Element | null | undefined;
  aiHistoryList: Element | null | undefined;
  aiHistoryToggle: Element | null | undefined;
  chats: ChatState[];
  runningConversations: Set<string>;
  getActiveChatId: () => string | null;
  switchActiveChat: (chatId: string) => void;
};

export const createHistoryController = (params: CreateHistoryControllerParams) => {
  const {
    aiHistory,
    aiHistoryList,
    aiHistoryToggle,
    chats,
    runningConversations,
    getActiveChatId,
    switchActiveChat,
  } = params;

  let historyOpen = false;

  const renderHistoryList = () => {
    if (!(aiHistoryList instanceof HTMLElement)) return;
    aiHistoryList.replaceChildren();
    if (chats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-history-empty";
      empty.textContent = "履歴なし";
      aiHistoryList.appendChild(empty);
      return;
    }
    for (let i = chats.length - 1; i >= 0; i--) {
      const chat = chats[i];
      const item = document.createElement("button");
      item.className = "ai-history-item";
      item.type = "button";
      if (chat.id === getActiveChatId()) item.classList.add("is-active");
      if (runningConversations.has(chat.id)) item.classList.add("is-running");
      const suffixParts: string[] = [];
      if (runningConversations.has(chat.id)) suffixParts.push("実行中");
      if (chat.proposals.size > 0) suffixParts.push(`提案 ${chat.proposals.size}`);
      const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(" / ")})` : "";
      item.textContent = `${chat.title}${suffix}`;
      item.addEventListener("click", () => {
        switchActiveChat(chat.id);
        closeHistory();
      });
      aiHistoryList.appendChild(item);
    }
  };

  const toggleHistory = () => {
    historyOpen = !historyOpen;
    if (aiHistory instanceof HTMLElement) aiHistory.classList.toggle("is-open", historyOpen);
    if (historyOpen) renderHistoryList();
  };

  const closeHistory = () => {
    historyOpen = false;
    if (aiHistory instanceof HTMLElement) aiHistory.classList.remove("is-open");
  };

  if (aiHistoryToggle instanceof HTMLButtonElement) {
    aiHistoryToggle.addEventListener("click", toggleHistory);
  }

  return {
    renderHistoryList,
    closeHistory,
  };
};
