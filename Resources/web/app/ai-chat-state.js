import { uiText } from "./i18n.js";
export const createChatState = (id, title) => ({
    id,
    title,
    messages: [],
    proposals: new Map(),
    appliedProposalIds: new Set(),
    statusMessage: uiText("Waiting", "待機中"),
    hasUndo: false,
});
export const getChat = (chatIndex, activeChatId, chatId) => {
    var _a, _b;
    if (chatId && chatIndex.has(chatId)) {
        return (_a = chatIndex.get(chatId)) !== null && _a !== void 0 ? _a : null;
    }
    return activeChatId ? (_b = chatIndex.get(activeChatId)) !== null && _b !== void 0 ? _b : null : null;
};
export const ensureChat = (options) => {
    const { chatId, activeChatId, chats, chatIndex, resolveChatTitle, onChatCreated, } = options;
    if (chatId && !chatIndex.has(chatId)) {
        const chat = createChatState(chatId, resolveChatTitle(chatId));
        chats.push(chat);
        chatIndex.set(chatId, chat);
        onChatCreated === null || onChatCreated === void 0 ? void 0 : onChatCreated();
    }
    return getChat(chatIndex, activeChatId, chatId);
};
export const createChat = (options) => {
    const { chats, chatIndex, makeChatId, resolveChatTitle, } = options;
    const id = makeChatId();
    const chat = createChatState(id, resolveChatTitle(id));
    chats.push(chat);
    chatIndex.set(id, chat);
    return chat;
};
