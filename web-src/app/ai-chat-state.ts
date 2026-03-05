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
  statusMessage: string;
  hasUndo: boolean;
  autonomous: boolean;
  autoLoopBudget: number;
};

export const createChatState = (
  id: string,
  title: string,
  autonomous: boolean,
  autoLoopBudget: number
): ChatState => ({
  id,
  title,
  messages: [],
  proposals: new Map(),
  statusMessage: "待機中",
  hasUndo: false,
  autonomous,
  autoLoopBudget,
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
  defaultAutonomous: boolean;
  defaultAutoLoopBudget: number;
  resolveChatTitle: (chatId: string) => string;
  onChatCreated?: () => void;
}) => {
  const {
    chatId,
    activeChatId,
    chats,
    chatIndex,
    defaultAutonomous,
    defaultAutoLoopBudget,
    resolveChatTitle,
    onChatCreated,
  } = options;
  if (chatId && !chatIndex.has(chatId)) {
    const chat = createChatState(
      chatId,
      resolveChatTitle(chatId),
      defaultAutonomous,
      defaultAutoLoopBudget
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
  defaultAutonomous: boolean;
  defaultAutoLoopBudget: number;
}) => {
  const {
    chats,
    chatIndex,
    makeChatId,
    resolveChatTitle,
    defaultAutonomous,
    defaultAutoLoopBudget,
  } = options;
  const id = makeChatId();
  const chat = createChatState(
    id,
    resolveChatTitle(id),
    defaultAutonomous,
    defaultAutoLoopBudget
  );
  chats.push(chat);
  chatIndex.set(id, chat);
  return chat;
};
