'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Resolution has no process, network, configuration, or credential side effects.
// In packaged builds this tree MUST be in app.asar.unpacked (or extraResources).
function getGitRuntime({ resourcesPath = process.resourcesPath, platform = process.platform, arch = process.arch, baseEnv = process.env } = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
    const error = new Error(`Bundled Git is unavailable for ${platform}-${arch}`); error.code = 'GIT_RUNTIME_UNSUPPORTED'; throw error;
  }
  const key = `${platform}-${arch}`;
  const candidates = resourcesPath ? [
    path.join(resourcesPath, 'git-runtime', key),
    path.join(resourcesPath, 'app.asar.unpacked', 'Resources', 'git-runtime', key),
    path.join(resourcesPath, 'app', 'Resources', 'git-runtime', key),
  ] : [];
  // No source-checkout fallback when executing within a packaged asar.
  if (!__dirname.includes(`${path.sep}app.asar${path.sep}`)) candidates.push(path.resolve(__dirname, '..', '..', 'Resources', 'git-runtime', key));
  for (const root of candidates) {
    const binary = path.join(root, 'bin', 'git');
    const execPath = path.join(root, 'libexec', 'git-core');
    const credentialManager = path.join(execPath, 'git-credential-manager');
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(root, 'tex64-runtime.json'), 'utf8'));
      if (marker.schema !== 1 || marker.target !== key || marker.gitVersion !== '2.53.0' || marker.gcmVersion !== '2.9.0') continue;
      for (const filename of [binary, credentialManager]) fs.accessSync(filename, fs.constants.X_OK);
      const inherited = { ...baseEnv };
      // A shell may carry repository selectors, injected -c values, trace sinks,
      // alternate credential stores, or CLR startup hooks. None is an authority
      // for a TeX64 operation. The runner supplies any deliberate overrides later.
      for (const name of Object.keys(inherited)) {
        if (/^(GIT_|GCM_|DOTNET_|COMPlus_|DYLD_)/i.test(name) ||
            ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'BROWSER'].includes(name)) delete inherited[name];
      }
      const env = {
        ...inherited,
        PATH: [path.join(root, 'bin'), execPath, baseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(path.delimiter),
        GIT_EXEC_PATH: execPath,
        GIT_TEMPLATE_DIR: path.join(root, 'share', 'git-core', 'templates'),
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
        GCM_INTERACTIVE: '0', GCM_CREDENTIAL_STORE: 'keychain', DOTNET_MULTILEVEL_LOOKUP: '0',
      };
      return { root, binary, credentialManager, execPath, env, version: marker.gitVersion, gcmVersion: marker.gcmVersion, bundled: true };
    } catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  }
  const error = new Error('Bundled Git is missing. Run npm run git:fetch before packaging.'); error.code = 'GIT_RUNTIME_MISSING'; throw error;
}
module.exports = { getGitRuntime };
