const { spawn } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const spawnChild = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
  return child;
};

const runOnce = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawnChild(command, args, options);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });

const children = [];
const nonInferenceEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !["TEX64_AGENTS_API_KEY", "OPENAI_API_KEY", "TEX64_LLM_API_KEY"].includes(name)));
const ensureAiWeb = async () => {
  const url = process.env.TEX64_AI_WEB_URL || "http://localhost:3100";
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("The AI development server must be local.");
  const ready = async () => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  };
  if (await ready()) return;
  const child = spawnChild("npm", ["run", "dev", "--", "--port", parsed.port || "3100"], {
    cwd: path.join(repoRoot, "services/tex64-ai"), env: nonInferenceEnv(),
  });
  children.push(child);
  let failed = false;
  child.once("error", () => { failed = true; });
  child.once("exit", () => { failed = true; });
  for (let attempt = 0; attempt < 90; attempt++) {
    if (failed) throw new Error("The AI development server exited before it was ready.");
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The AI development server did not become ready.");
};
const shutdown = (signal = "SIGTERM") => {
  // Try graceful shutdown first; fall back to SIGKILL shortly after.
  children.forEach((child) => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  });
  setTimeout(() => {
    children.forEach((child) => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    });
  }, 1200).unref();
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

const main = async () => {
  // Keep renderer assets fresh to avoid the "old code" confusion in dev.
  await runOnce("npm", ["run", "-s", "web:build"], { env: nonInferenceEnv() });
  if (process.env.TEX64_AGENT_RUNTIME === "agents-api") await ensureAiWeb();

  const tscWatch = spawnChild("npm", ["run", "-s", "web:watch"], {
    env: nonInferenceEnv(),
  });
  children.push(tscWatch);

  // Electron reads renderer assets from Resources/web/, so the tsc watcher updates the UI.
  const electronDev = spawnChild("npm", ["run", "-s", "electron:dev:fast"], {
    env: {
      ...process.env,
      TEX64_SKIP_STARTUP_WEB_BUILD: "1",
      // Allow launching dev app even when an installed TeX64 instance already holds single-instance lock.
      TEX64_ALLOW_MULTI_INSTANCE: "1",
    },
  });
  children.push(electronDev);

  electronDev.on("exit", (code) => {
    shutdown();
    process.exitCode = code ?? 0;
  });
};

main().catch((error) => {
  console.error("[dev] failed");
  console.error(error);
  shutdown();
  process.exitCode = 1;
});
