import { uiText } from "./i18n.js";
import type { AgentProposal } from "./types.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

export type ChatState = {
  id: string;
  title: string;
  messages: ChatMessage[];
  proposals: Map<string, AgentProposal>;
  appliedProposalIds: Set<string>;
  statusMessage: string;
  hasUndo: boolean;
};

export const createChatState = (
  id: string,
  title: string
): ChatState => ({
  id,
  title,
  messages: [],
  proposals: new Map(),
  appliedProposalIds: new Set(),
  statusMessage: uiText("Waiting", "待機中"),
  hasUndo: false,
});

export const getChat = (
  chatIndex: Map<string, ChatState>,
  activeChatId: string | null,
  chatId?: string | null
) => {
  if (chatId && chatIndex.has(chatId)) {
    return chatIndex.get(chatId) ?? null;
  }
  return activeChatId ? chatIndex.get(activeChatId) ?? null : null;
};

export const ensureChat = (options: {
  chatId?: string | null;
  activeChatId: string | null;
  chats: ChatState[];
  chatIndex: Map<string, ChatState>;
  resolveChatTitle: (chatId: string) => string;
  onChatCreated?: () => void;
}) => {
  const {
    chatId,
    activeChatId,
    chats,
    chatIndex,
    resolveChatTitle,
    onChatCreated,
  } = options;
  if (chatId && !chatIndex.has(chatId)) {
    const chat = createChatState(
      chatId,
      resolveChatTitle(chatId)
    );
    chats.push(chat);
    chatIndex.set(chatId, chat);
    onChatCreated?.();
  }
  return getChat(chatIndex, activeChatId, chatId);
};

export const createChat = (options: {
  chats: ChatState[];
  chatIndex: Map<string, ChatState>;
  makeChatId: () => string;
  resolveChatTitle: (chatId: string) => string;
}) => {
  const {
    chats,
    chatIndex,
    makeChatId,
    resolveChatTitle,
  } = options;
  const id = makeChatId();
  const chat = createChatState(
    id,
    resolveChatTitle(id)
  );
  chats.push(chat);
  chatIndex.set(id, chat);
  return chat;
};
