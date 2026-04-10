export type EnvStatusSummary = {
  hasAnyResult: boolean;
  hasEngine: boolean;
  latexmkAvailable: boolean;
  synctexAvailable: boolean;
  latexindentAvailable: boolean;
  runtimeReady: boolean;
  missingRequired: string[];
  missingRecommended: string[];
  statusByCommand: Record<string, boolean>;
};

export const createEnvStatusManager = (params: {
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  envCheckTargets: string[];
  envDisplayTargets: string[];
  texEngineCommands: Set<string>;
  onStatusSummaryChange?: (summary: EnvStatusSummary) => void;
}) => {
  const envCheckState = new Map<string, boolean>();
  let envCheckRetryTimer: number | null = null;
  let envCheckRetryCount = 0;
  const envCheckMaxRetries = 4;

  const hasDetectedEngine = () =>
    Array.from(params.texEngineCommands).some(
      (engine) => envCheckState.get(engine) === true
    );

  const getStatusSummary = (): EnvStatusSummary => {
    const hasAnyResult = params.envCheckTargets.some((command) =>
      envCheckState.has(command)
    );
    const hasEngine = hasDetectedEngine();
    const latexmkAvailable = envCheckState.get("latexmk") === true;
    const synctexAvailable = envCheckState.get("synctex") === true;
    const latexindentAvailable = envCheckState.get("latexindent") === true;
    const missingRequired: string[] = [];
    if (!hasEngine) {
      missingRequired.push("engine");
    }
    if (!latexmkAvailable) {
      missingRequired.push("latexmk");
    }
    if (!synctexAvailable) {
      missingRequired.push("synctex");
    }
    const missingRecommended: string[] = [];
    if (!latexindentAvailable) {
      missingRecommended.push("latexindent");
    }
    const statusByCommand = Object.fromEntries(envCheckState.entries());
    return {
      hasAnyResult,
      hasEngine,
      latexmkAvailable,
      synctexAvailable,
      latexindentAvailable,
      runtimeReady: missingRequired.length === 0,
      missingRequired,
      missingRecommended,
      statusByCommand,
    };
  };

  const emitStatusSummary = () => {
    params.onStatusSummaryChange?.(getStatusSummary());
  };

  const renderEnvStatus = (envName: string, available: boolean | null) => {
    const item = document.querySelector(`.env-item[data-env="${envName}"]`);
    if (!item) {
      return;
    }

    const statusBadge = item.querySelector(".env-badge");
    const actionBtn = item.querySelector(".env-btn");

    if (statusBadge) {
      if (available === null) {
        statusBadge.className = "env-badge checking";
        statusBadge.textContent = "Checking...";
      } else {
        statusBadge.className = available ? "env-badge ok" : "env-badge error";
        statusBadge.textContent = available ? "Available" : "Not found";
      }
    }

    if (actionBtn instanceof HTMLElement) {
      actionBtn.classList.remove("is-hidden");
      if (available === null) {
        actionBtn.setAttribute("disabled", "true");
        return;
      }
      actionBtn.removeAttribute("disabled");
      actionBtn.textContent = available ? "Update/Reinstall" : "install";
    }
  };

  const checkEnvironmentStatus = (isRetry = false) => {
    if (!isRetry) {
      envCheckRetryCount = 0;
    }
    if (envCheckRetryTimer !== null) {
      window.clearTimeout(envCheckRetryTimer);
      envCheckRetryTimer = null;
    }
    params.envDisplayTargets.forEach((envName) => renderEnvStatus(envName, null));
    params.envCheckTargets.forEach((command) => envCheckState.delete(command));
    emitStatusSummary();
    let postedAll = true;
    params.envCheckTargets.forEach((command) => {
      if (!params.postToNative({ type: "env:check", command }, true)) {
        postedAll = false;
      }
    });
    if (postedAll) {
      envCheckRetryCount = 0;
      return;
    }
    envCheckRetryCount += 1;
    if (envCheckRetryCount >= envCheckMaxRetries) {
      envCheckRetryCount = 0;
      params.envDisplayTargets.forEach((envName) => renderEnvStatus(envName, false));
      return;
    }
    envCheckRetryTimer = window.setTimeout(() => {
      envCheckRetryTimer = null;
      checkEnvironmentStatus(true);
    }, 400);
  };

  const updateEnvStatus = (command: string, available: boolean) => {
    if (!command) {
      return;
    }
    envCheckState.set(command, available);
    if (params.texEngineCommands.has(command)) {
      const hasEngine = hasDetectedEngine();
      renderEnvStatus("lualatex", hasEngine);
      emitStatusSummary();
      return;
    }
    renderEnvStatus(command, available);
    emitStatusSummary();
  };

  return {
    checkEnvironmentStatus,
    updateEnvStatus,
    getStatusSummary,
  };
};
