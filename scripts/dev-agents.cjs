"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

// The existing developer key stays in the ignored file and the main process.
const envPath = path.join(__dirname, "../services/tex64-ai/.env.local");
if (!process.env.TEX64_AGENTS_API_KEY && fs.existsSync(envPath)) {
  process.env.TEX64_AGENTS_API_KEY = parseEnv(fs.readFileSync(envPath, "utf8")).OPENAI_API_KEY || "";
}
if (!process.env.TEX64_AGENTS_API_KEY) {
  console.error("Set TEX64_AGENTS_API_KEY or OPENAI_API_KEY in services/tex64-ai/.env.local.");
  process.exitCode = 1;
} else {
  process.env.TEX64_AGENT_RUNTIME = "agents-api";
  // Match the standard Axiom source default for the first comparison.
  process.env.TEX64_AGENTS_MODEL ||= "gpt-5.6-luna";
  console.log("[dev] Agents API trial: explicit messages only; automatic titles and follow-ups disabled.");
  require("./dev.cjs");
}
