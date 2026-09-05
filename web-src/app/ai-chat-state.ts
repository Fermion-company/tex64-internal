import { uiText } from "./i18n.js";
import type { AgentNextStep, AgentPlan, AgentProposal, AgentQuestion } from "./types.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  /** When the message was added, for the relative time under a reply. */
  createdAt?: number;
  /** Next steps the agent offered with this reply. */
  proposals?: AgentNextStep[];
  /** A question the agent needs answered before going on. */
  question?: AgentQuestion;
  /** The plan recorded in Plan mode, reviewed here before it runs. */
  plan?: AgentPlan;
  /** The reader's rating of this reply, once given. */
  rating?: "up" | "down";
  /** A request waiting for the running turn to finish. */
  queued?: boolean;
  queueId?: string;
  /** The file changes the turn that produced this reply wrote. */
  changes?: AgentProposal[];
};

/** A request typed while a turn was running; sent when the turn ends. */
export type QueuedTurn = {
  id: string;
  text: string;
  parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  contextPayload?: Record<string, unknown>;
};

export type ChatState = {
  id: string;
  title: string;
  messages: ChatMessage[];
  proposals: Map<string, AgentProposal>;
  appliedProposalIds: Set<string>;
  statusMessage: string;
  hasUndo: boolean;
  /** Requests waiting behind the running turn, in order. */
  queue: QueuedTurn[];
  updatedAt?: number | null;
  branchedFrom?: string | null;
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
  queue: [],
  updatedAt: null,
  branchedFrom: null,
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
