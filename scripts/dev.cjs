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
      if (!child.killed) {
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
  await runOnce("npm", ["run", "-s", "web:build"]);

  const tscWatch = spawnChild("npm", ["run", "-s", "web:watch"], {
    env: { ...process.env },
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
