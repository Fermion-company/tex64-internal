/**
 * ESM Bridge — dynamic-import wrapper for LangChain (ESM-only) packages.
 *
 * Loads all LangChain modules needed for the OpenPrism-style AgentExecutor.
 */

"use strict";

let _modules = null;

const loadModules = async () => {
  if (_modules) return _modules;

  const [openaiMod, toolsMod, promptsMod, agentsMod, messagesMod, zodMod] =
    await Promise.all([
      import("@langchain/openai"),
      import("@langchain/core/tools"),
      import("@langchain/core/prompts"),
      import("langchain/agents"),
      import("@langchain/core/messages"),
      import("zod"),
    ]);

  _modules = {
    ChatOpenAI: openaiMod.ChatOpenAI,
    DynamicStructuredTool: toolsMod.DynamicStructuredTool,
    ChatPromptTemplate: promptsMod.ChatPromptTemplate,
    MessagesPlaceholder: promptsMod.MessagesPlaceholder,
    createOpenAIToolsAgent: agentsMod.createOpenAIToolsAgent,
    AgentExecutor: agentsMod.AgentExecutor,
    HumanMessage: messagesMod.HumanMessage,
    AIMessage: messagesMod.AIMessage,
    SystemMessage: messagesMod.SystemMessage,
    ToolMessage: messagesMod.ToolMessage,
    z: zodMod.z,
  };

  return _modules;
};

module.exports = { loadModules };
