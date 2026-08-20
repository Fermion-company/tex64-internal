// IPC for the Packages screen. Every handler answers on its own channel so the
// renderer can keep the list responsive while a long operation runs.
//
// Reads are cheap and local; writes may put a macOS administrator prompt in
// front of the user (when the TeX being managed is a system installation), so
// they always report back — including when the user cancels the prompt.
const createPackageHandlers = ({ packageService, sendToRenderer }) => {
  const guard = async (channel, run, extra = {}) => {
    if (!packageService) {
      sendToRenderer(channel, { ...extra, ok: false, error: "Package management is unavailable." });
      return;
    }
    try {
      const payload = await run();
      sendToRenderer(channel, { ...extra, ok: true, ...payload });
    } catch (error) {
      sendToRenderer(channel, {
        ...extra,
        ok: false,
        error: typeof error?.message === "string" ? error.message : "Operation failed.",
      });
    }
  };

  const handlePackagesCatalog = (options = {}) =>
    guard("packages:catalogResult", async () => {
      const catalog = await packageService.getCatalog({ force: options?.force === true });
      return catalog;
    });

  const handlePackagesSearchFiles = (term) =>
    guard(
      "packages:filesResult",
      async () => ({ matches: await packageService.searchFiles(term) }),
      { term }
    );

  const handlePackagesCtanSearch = (term) =>
    guard(
      "packages:ctanResult",
      async () => ({ matches: await packageService.searchCtan(term) }),
      { term }
    );

  const handlePackagesDetail = (name) =>
    guard("packages:detailResult", async () => ({ detail: await packageService.getDetail(name) }), {
      name,
    });

  const handlePackagesInstall = async (names) => {
    const list = Array.isArray(names) ? names : [names];
    sendToRenderer("packages:opStart", { op: "install", names: list });
    await guard(
      "packages:opResult",
      async () =>
        packageService.install(list, (progress) => {
          sendToRenderer("packages:opProgress", { op: "install", ...progress });
        }),
      { op: "install", names: list }
    );
  };

  const handlePackagesRemove = async (names, options = {}) => {
    const list = Array.isArray(names) ? names : [names];
    sendToRenderer("packages:opStart", { op: "remove", names: list });
    await guard("packages:opResult", async () => packageService.remove(list, options), {
      op: "remove",
      names: list,
    });
  };

  const handlePackagesUpdate = async () => {
    sendToRenderer("packages:opStart", { op: "update", names: [] });
    await guard(
      "packages:opResult",
      async () =>
        packageService.update((progress) => {
          sendToRenderer("packages:opProgress", { op: "update", ...progress });
        }),
      { op: "update", names: [] }
    );
  };

  return {
    handlePackagesCatalog,
    handlePackagesSearchFiles,
    handlePackagesCtanSearch,
    handlePackagesDetail,
    handlePackagesInstall,
    handlePackagesRemove,
    handlePackagesUpdate,
  };
};

module.exports = { createPackageHandlers };
