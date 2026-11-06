"use strict";

// The session hub. One per app. Holds the session state, a Y.Doc per shared
// text file plus one session Y.Doc (manifest `files`, `comments`), encodes /
// decodes y-protocols sync and awareness messages, and moves them between
// three kinds of peers: the renderer (IPC), network peers (transport-ws), and
// the disk (disk-sync). The host runs the ws server; guests connect to it and
// keep a mirror of the workspace under ~/TeX64 Collab/. A guest who joined
// with the view link reads along: the host drops every change it sends (text,
// comments, files), and its own app keeps the mirror equal to the host's.

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Y = require("yjs");
const syncProtocol = require("y-protocols/sync");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const transport = require("./transport-ws.cjs");
const relay = require("./relay-transport.cjs");
const invite = require("./invite.cjs");
const { WorkspaceManifest, safeRelativePath, resolveInsideRoot, looksTextByName, hashBuffer, extensionOf, MAX_TEXT_BYTES, MAX_BINARY_BYTES } = require("./manifest.cjs");
const { DiskSync, DISK_ORIGIN } = require("./disk-sync.cjs");

const SESSION_DOC = "$session";
const RENDERER = "renderer";
const LOCAL = "local";
const SCAN_INTERVAL_MS = 3000;
// A guest asks again for a file it still lacks only this often: a 50 MB figure
// on a slow link takes longer than a scan, and each request would send it anew.
const BLOB_REREQUEST_MS = 30000;

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1048576).toFixed(value >= 10 * 1048576 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
};
const UPDATE_LOG_MAX_BYTES = 200 * 1024 * 1024;
const JOIN_TIMEOUT_MS = 90000;
const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5"];

const text = (locale, en, ja) => (locale === "ja" ? ja : en);

const sanitizeName = (value, fallback) => {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "";
  return name || fallback;
};

const safeSessionFolderName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "session";

class CollabHub extends EventEmitter {
  // deps: workspace, state, sendCollab(message), withWorkspaceMutation,
  //       trackSaved(path, content), openWorkspacePath(root), refreshTree(),
  //       recordVersion(label), locale(), userName(), collabRoot()
  constructor(deps) {
    super();
    this.deps = deps;
    this.session = null;
    this.stateTimer = null;
  }

  // ----------------------------------------------------------------- status
  isActive() {
    return Boolean(this.session?.phase === "active");
  }

  isGuest() {
    return this.session?.role === "guest";
  }

  isHost() {
    return this.session?.role === "host";
  }

  isViewer() {
    return this.session?.role === "guest" && this.session.access === "view";
  }

  isSyncedTextPath(relativePath) {
    const session = this.session;
    if (!session || session.phase !== "active") return false;
    const entry = session.docs.get(relativePath);
    return Boolean(entry && !entry.deleted && entry.attached);
  }

  // The relay a new session would use, or null when the app selects LAN.
  relayServer() {
    return invite.relayServerOrigin(this.deps.relayUrl?.() || "");
  }

  status() {
    const session = this.session;
    if (!session) return { active: false, phase: "idle", route: this.relayServer() ? "relay" : "lan" };
    const participants = [];
    for (const peer of session.peers.values()) {
      participants.push({ id: peer.id, name: peer.name, color: peer.color, connected: peer.connected, host: peer.host, viewer: peer.viewer === true, self: peer.id === session.selfId });
    }
    return {
      active: session.phase === "active",
      phase: session.phase,
      role: session.role,
      sessionId: session.id,
      epoch: session.epoch,
      name: session.name,
      inviteLink: session.inviteLink || null,
      viewInviteLink: session.viewInviteLink || null,
      route: session.route || "lan",
      access: session.access,
      selfId: session.selfId,
      // A LAN host is always reachable; a relay host is while its link to the relay is up.
      connected: session.role === "host" ? session.transport?.connected !== false : Boolean(session.transport?.connected),
      participants,
      rootPath: session.rootPath,
      preserved: session.preserved ? session.preserved.length : 0,
      // A guest: files the host shares that have not arrived yet (figures
      // keep arriving after the mirror opens).
      incoming: session.role === "guest" ? this.incomingFiles(session) : null,
      // Files over the size limit: shared as a smaller copy, or not shared.
      limitedFiles: this.limitedFiles(session),
      preservedFiles: session.preserved ? session.preserved.slice(0, 3) : [],
      textFiles: [...session.docs.keys()].filter((id) => id !== SESSION_DOC && !session.docs.get(id).deleted),
    };
  }

  pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.deps.sendCollab({ type: "collab:state", ...this.status() });
      this.emit("state", this.status());
    }, 20);
    this.stateTimer.unref?.();
  }

  notice(message) {
    this.deps.sendCollab({ type: "collab:notice", message });
  }

  // ------------------------------------------------------------- lifecycle
  newSession(role, { id, name, token, rootPath, displayName }) {
    const selfId = invite.createSessionId().slice(0, 16);
    const session = {
      id,
      name,
      token,
      role,
      access: "edit",
      epoch: 1,
      phase: "starting",
      rootPath,
      selfId,
      displayName,
      docs: new Map(),
      peers: new Map(),
      rendererDocs: new Set(),
      transport: null,
      inviteLink: null,
      knownBinaryHashes: new Map(),
      manifest: null,
      scanTimer: null,
      scanning: false,
      diskSync: null,
      commentsTimer: null,
      colorCursor: 0,
    };
    session.diskSync = new DiskSync({
      rootPath: () => session.rootPath,
      withWorkspaceMutation: (operation) => this.deps.withWorkspaceMutation(operation),
      withFileMutation: (relative, operation) => this.deps.workspace.withFileMutation(relative, operation),
      trackSaved: (relative, content) => this.deps.trackSaved?.(relative, content),
      onSaved: (relative, digest) => {
        if (this.session !== session) return;
        this.deps.sendCollab({ type: "collab:saved", path: relative, hash: digest, sessionId: session.id, epoch: session.epoch });
        void session.manifest?.refresh(relative);
      },
      onNotice: (relative) => {
        this.notice(text(this.deps.locale(), `${relative}: kept the edits in progress because they conflicted with an external change.`, `${relative}: 外部変更と競合したため、編集中の内容を残しました。`));
      },
      onMissing: (relative) => {
        if (this.session === session) void this.rescan();
      },
      onReverted: (relative) => {
        this.notice(text(this.deps.locale(), `${relative}: you joined to view, so the host's content was put back.`, `${relative}: 閲覧のみで参加しているため、ホストの内容に戻しました。`));
      },
    });
    this.session = session;
    return session;
  }

  async start({ name } = {}) {
    if (this.session) throw Object.assign(new Error("A session is already running."), { code: "COLLAB_ACTIVE" });
    const rootPath = this.deps.workspace.getRootPath();
    if (!rootPath) throw Object.assign(new Error("Open a project folder first."), { code: "NO_WORKSPACE" });
    const displayName = sanitizeName(name, this.deps.userName());
    const sessionName = path.basename(rootPath);
    const session = this.newSession("host", {
      id: invite.createSessionId(),
      name: sessionName,
      token: invite.createToken(),
      rootPath,
      displayName,
    });
    session.viewToken = invite.createToken();
    try {
      session.peers.set(session.selfId, { id: session.selfId, name: displayName, color: this.nextColor(session), connected: true, host: true, conn: null });
      this.createSessionDoc(session);
      session.manifest = this.newManifest(rootPath);
      await session.manifest.scan();
      const files = session.sessionDoc.getMap("files");
      // What is shared for each non-text file (a smaller copy of an image
      // over the limit is made here, once).
      const shared = new Map();
      for (const [relative, entry] of session.manifest.entries) {
        if (entry.kind !== "text") shared.set(relative, await this.sharedEntry(session, relative, entry));
      }
      session.sessionDoc.transact(() => {
        for (const [relative, entry] of session.manifest.entries) {
          if (entry.kind === "text") {
            let content;
            try {
              content = fs.readFileSync(path.join(rootPath, relative), "utf8");
            } catch {
              continue;
            }
            const doc = this.createDoc(session, relative, content);
            doc.synced = true;
            files.set(relative, { kind: "text", by: session.selfId });
            this.attachDoc(session, relative, content);
          } else {
            if (entry.hash) session.knownBinaryHashes.set(relative, entry.hash);
            files.set(relative, shared.get(relative));
          }
        }
      }, LOCAL);
      await this.loadCommentsFromDisk(session);
      session.diskSync.coordinated = true;
      const server = this.relayServer();
      let host;
      if (server) {
        const room = invite.createRelayRoom();
        host = new relay.RelayHostTransport({ server, ...room, token: session.token, viewToken: session.viewToken });
        session.transport = host;
        try {
          await host.start();
        } catch (error) {
          const message = error?.code === "COLLAB_RELAY_BUSY"
            ? text(this.deps.locale(), "Too many sessions are open from this network. End one you no longer use.", "このネットワークから開いているセッションが多すぎます。使っていないセッションを終了してください。")
            : text(this.deps.locale(), "Could not reach the collaboration relay. Check the internet connection.", "共同編集の中継サーバーに接続できませんでした。インターネット接続を確かめてください。");
          throw Object.assign(new Error(message), { code: error?.code || "COLLAB_RELAY_UNREACHABLE" });
        }
        session.route = "relay";
        const linkRelay = { server, roomId: room.roomId, key: room.key };
        session.inviteLink = invite.buildInviteLink({ relay: linkRelay, token: session.token, name: sessionName });
        session.viewInviteLink = invite.buildInviteLink({ relay: linkRelay, token: session.viewToken, name: sessionName });
        host.on("relay", () => this.pushState());
      } else {
        host = new transport.HostTransport({ token: session.token, viewToken: session.viewToken });
        const port = await host.start();
        session.transport = host;
        session.route = "lan";
        const hosts = invite.localHostAddresses();
        session.inviteLink = invite.buildInviteLink({ hosts, port, token: session.token, name: sessionName });
        session.viewInviteLink = invite.buildInviteLink({ hosts, port, token: session.viewToken, name: sessionName });
      }
      host.on("open", (conn) => this.onPeerOpen(session, conn));
      host.on("close", (conn) => this.onPeerClose(session, conn));
      host.on("message", (conn, frame) => this.onPeerFrame(session, conn, frame));
      host.on("error", (error) => console.warn("[collab] server error", error?.message || error));
      session.phase = "active";
      this.startScanning(session);
      this.pushState();
      void this.autoRecord(session, "start");
      return this.status();
    } catch (error) {
      this.teardown(session);
      throw error;
    }
  }

  async join({ link, name } = {}) {
    if (this.session) throw Object.assign(new Error("A session is already running."), { code: "COLLAB_ACTIVE" });
    const parsed = invite.parseInviteLink(link);
    if (!parsed) throw Object.assign(new Error(text(this.deps.locale(), "This is not an invite link.", "招待リンクではありません。")), { code: "COLLAB_BAD_LINK" });
    const displayName = sanitizeName(name, this.deps.userName());
    const session = this.newSession("guest", {
      id: null,
      name: parsed.name || "session",
      token: parsed.token,
      rootPath: null,
      displayName,
    });
    session.pendingBlobs = new Set();
    session.joinWaiters = [];
    this.pushState();
    try {
      const greeting = { clientId: session.selfId, name: displayName };
      const guest = parsed.relay
        ? new relay.RelayGuestTransport({ ...parsed.relay, token: parsed.token, hello: greeting })
        : new transport.GuestTransport({ host: parsed.host, hosts: parsed.hosts, port: parsed.port, token: parsed.token, hello: greeting });
      session.transport = guest;
      session.route = parsed.relay ? "relay" : "lan";
      let welcomeTimer = null;
      const welcome = new Promise((resolve, reject) => {
        session.resolveWelcome = (message) => {
          clearTimeout(welcomeTimer);
          resolve(message);
        };
        welcomeTimer = setTimeout(() => reject(Object.assign(new Error(text(this.deps.locale(), "Could not reach the host.", "ホストに接続できませんでした。")), { code: "COLLAB_UNREACHABLE" })), 20000);
        welcomeTimer.unref?.();
        guest.once("gaveUp", ({ code }) => {
          clearTimeout(welcomeTimer);
          reject(Object.assign(new Error(code === 4005
            ? text(this.deps.locale(), "The session is full.", "セッションの人数が上限です。")
            : text(this.deps.locale(), "The host refused this link.", "ホストがこのリンクを受け付けませんでした。")), { code: "COLLAB_REFUSED" }));
        });
      });
      guest.on("open", (conn) => this.onPeerOpen(session, conn));
      guest.on("close", (conn, info) => this.onPeerClose(session, conn, info));
      guest.on("message", (conn, frame) => this.onPeerFrame(session, conn, frame));
      guest.on("reconnecting", () => this.pushState());
      guest.connect();
      const hello = await welcome;
      // The welcome names the mirror folder: only a session id this app
      // could have made (32 hex digits) and a folder inside the collab root.
      if (typeof hello.sessionId !== "string" || !/^[0-9a-f]{32}$/.test(hello.sessionId)) {
        throw Object.assign(new Error(text(this.deps.locale(), "The host refused this link.", "ホストがこのリンクを受け付けませんでした。")), { code: "COLLAB_REFUSED" });
      }
      // Doc frames follow the welcome immediately; everything that decides
      // how they are written must be in place before the first await below.
      session.joining = true;
      session.preserved = [];
      session.mirrorHashes = null;
      session.diskSync.paused = true;
      session.id = hello.sessionId;
      session.name = hello.name || session.name;
      session.epoch = hello.epoch || 1;
      session.hostName = hello.hostName;
      session.rootFile = hello.rootFile || "";
      session.access = hello.access === "view" ? "view" : "edit";
      session.diskSync.readOnly = session.access === "view";
      const collabRoot = path.resolve(this.deps.collabRoot());
      session.rootPath = path.join(collabRoot, `${safeSessionFolderName(session.name)}-${session.id.slice(0, 8)}`);
      if (path.dirname(session.rootPath) !== collabRoot || [".", ".."].includes(path.basename(session.rootPath))) {
        throw Object.assign(new Error(text(this.deps.locale(), "The host refused this link.", "ホストがこのリンクを受け付けませんでした。")), { code: "COLLAB_REFUSED" });
      }
      await fsp.mkdir(collabRoot, { recursive: true });
      if ((await fsp.lstat(session.rootPath).catch(() => null))?.isSymbolicLink()) {
        throw Object.assign(new Error(text(this.deps.locale(), "The host refused this link.", "ホストがこのリンクを受け付けませんでした。")), { code: "COLLAB_REFUSED" });
      }
      const rejoining = await fsp.readdir(session.rootPath).then((names) => names.some((name) => name !== ".tex64")).catch(() => false);
      if (rejoining) session.mirrorHashes = await this.readMirrorManifest(session);
      await fsp.mkdir(path.join(session.rootPath, ".tex64"), { recursive: true });
      if (rejoining) {
        // Edits made in the mirror after leaving are kept: a History version
        // first (when the lease is free), and any file that differs from the
        // host's copy is set aside as <name>.local-<stamp><ext> before the
        // host's content replaces it.
        session.phase = "opening";
        await this.deps.openWorkspacePath(session.rootPath);
        if (this.session !== session) throw new Error("The join was cancelled.");
        session.diskSync.coordinated = true;
        try {
          await this.deps.recordVersion?.(this.recordLabel("rejoin", [displayName]));
        } catch {}
        session.phase = "starting";
      }
      if (session.rootFile) {
        const settingsPath = path.join(session.rootPath, ".tex64", "settings.json");
        let settings = {};
        try {
          settings = JSON.parse(await fsp.readFile(settingsPath, "utf8")) || {};
        } catch {}
        settings.rootFile = session.rootFile;
        await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      }
      this.createSessionDoc(session);
      this.sendSyncStep1(session, SESSION_DOC);
      // The session doc tells us which files exist; wait for every text doc,
      // then write the mirror and open it. Files (figures) that are still on
      // their way arrive afterwards: over the internet a 50 MB figure would
      // otherwise hold the whole project back.
      await this.waitForInitialSync(session);
      session.initialBlobs = new Set(session.pendingBlobs);
      session.diskSync.resume();
      await session.diskSync.flush(60000);
      session.joining = false;
      if (!rejoining) {
        session.phase = "opening";
        await this.deps.openWorkspacePath(session.rootPath);
        if (this.session !== session) throw new Error("The join was cancelled.");
        session.diskSync.coordinated = true;
      } else {
        this.deps.refreshTree?.();
      }
      session.manifest = this.newManifest(session.rootPath);
      await session.manifest.scan();
      for (const [relative, entry] of session.manifest.entries) {
        if (entry.kind === "binary") session.knownBinaryHashes.set(relative, entry.hash);
      }
      session.phase = "active";
      this.startScanning(session);
      this.pushState();
      void this.autoRecord(session, "join");
      return this.status();
    } catch (error) {
      this.teardown(session);
      this.pushState();
      throw error;
    }
  }

  // On leaving, a guest records the hash of every mirrored file so a rejoin
  // can tell "edited here after leaving" from "changed by the host meanwhile".
  mirrorManifestPath(session) {
    return path.join(session.rootPath, ".tex64", "collab-mirror.json");
  }

  async writeMirrorManifest(session) {
    if (!session.rootPath || !session.manifest) return;
    try {
      await session.manifest.scan();
      const files = {};
      for (const [relative, entry] of session.manifest.entries) {
        if (entry.kind === "binary") files[relative] = entry.hash;
        else if (entry.kind === "skipped") continue;
        else {
          try {
            files[relative] = hashBuffer(await fsp.readFile(path.join(session.rootPath, relative)));
          } catch {}
        }
      }
      await fsp.writeFile(this.mirrorManifestPath(session), JSON.stringify({ schema: 1, sessionId: session.id, files }, null, 2), "utf8");
    } catch (error) {
      console.warn("[collab] mirror manifest failed", error?.message || error);
    }
  }

  async readMirrorManifest(session) {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.mirrorManifestPath(session), "utf8"));
      return parsed && typeof parsed.files === "object" ? parsed.files : null;
    } catch {
      return null;
    }
  }

  // Guest join onto an existing mirror: keep a copy of a file edited here
  // after leaving (its hash moved from the one recorded at leave time) that
  // the host's content is about to replace — or, with `incoming` null, that
  // the host deleted meanwhile. Without a leave-time record, any file that
  // differs from the host's copy is kept. Returns false when a copy was
  // needed and could not be made: the caller must not replace the file then.
  async preserveLocal(session, relative, incoming) {
    // While joining, and for files of the join that arrive after the mirror
    // opened (session.initialBlobs).
    if ((!session.joining && !session.initialBlobs?.has(relative)) || !session.rootPath) return true;
    const absolute = path.join(session.rootPath, relative);
    let current;
    try {
      current = await fsp.readFile(absolute);
    } catch (error) {
      // Nothing there to keep; any other failure (EACCES …) keeps the file.
      return error?.code === "ENOENT";
    }
    if (incoming !== null && (typeof incoming === "string" ? current.toString("utf8") === incoming : Buffer.from(incoming).equals(current))) return true;
    if (session.mirrorHashes) {
      const recorded = session.mirrorHashes[relative];
      if (recorded && recorded === hashBuffer(current)) return true;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const extension = path.extname(relative);
    const target = `${absolute.slice(0, absolute.length - extension.length)}.local-${stamp}${extension}`;
    try {
      await fsp.copyFile(absolute, target);
      session.preserved.push(path.relative(session.rootPath, target));
      // A file of the join that arrived after the mirror opened: the join's
      // own report has already been shown.
      if (!session.joining) {
        const kept = path.relative(session.rootPath, target);
        this.notice(text(this.deps.locale(), `${relative}: edited after you left, kept as ${kept}.`, `${relative}: 退出後に編集した分を ${kept} として退避しました。`));
      }
      return true;
    } catch (error) {
      console.warn("[collab] preserve failed", relative, error?.message || error);
      return false;
    }
  }

  waitForInitialSync(session) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + JOIN_TIMEOUT_MS;
      const check = () => {
        if (this.session !== session) {
          reject(new Error("The join was cancelled."));
          return;
        }
        const sessionReady = Boolean(session.docs.get(SESSION_DOC)?.synced);
        const docsReady = sessionReady && [...session.docs.values()].every((doc) => doc.docId === SESSION_DOC || doc.deleted || doc.synced);
        if (sessionReady && docsReady) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(Object.assign(new Error(text(this.deps.locale(), "The host did not send the project in time.", "ホストからプロジェクトを受け取れませんでした。")), { code: "COLLAB_TIMEOUT" }));
          return;
        }
        setTimeout(check, 100).unref?.();
      };
      check();
    });
  }

  // `leaseHeld`: the caller (a project switch) already holds the workspace
  // mutation lease, so the shared files are written under their file guards
  // only — waiting for the lease would wait for ourselves. Every shared edit
  // must be on disk before the docs go: if that fails, the session stays and
  // the caller fails.
  async leave({ leaseHeld = false } = {}) {
    const session = this.session;
    if (!session) return { ok: true };
    const role = session.role;
    const previousPhase = session.phase;
    session.phase = "leaving";
    this.pushState();
    // No new timed writes while leaving; flushHeld writes what is dirty.
    if (leaseHeld) session.diskSync.paused = true;
    const flushed = leaseHeld ? await session.diskSync.flushHeld() : await session.diskSync.flush();
    if (!flushed) {
      if (this.session === session) {
        session.phase = previousPhase;
        if (leaseHeld) session.diskSync.resume();
        this.pushState();
      }
      throw Object.assign(new Error(text(this.deps.locale(), "Some shared files could not be saved, so the session stays open. Try again.", "共有中のファイルを保存できなかったため、セッションを続けています。もう一度お試しください。")), { code: "COLLAB_FLUSH_FAILED" });
    }
    if (role === "guest") await this.writeMirrorManifest(session);
    // The JSON file must hold the final line numbers before the editor reads
    // it back outside the session.
    clearTimeout(session.commentsTimer);
    session.commentsTimer = null;
    await this.persistComments(session, { silent: true });
    if (role === "host") {
      session.transport?.broadcast(transport.encodeControl({ type: "end" }));
    }
    const names = this.participantNames(session);
    this.teardown(session);
    this.pushState();
    this.deps.sendCollab({ type: "collab:comments", sessionId: session.id });
    void this.deps.recordVersion?.(this.recordLabel(role === "host" ? "end" : "leave", names)).catch(() => {});
    return { ok: true };
  }

  end() {
    return this.leave();
  }

  teardown(session) {
    if (this.session !== session) return;
    this.session = null;
    clearInterval(session.scanTimer);
    clearTimeout(session.commentsTimer);
    session.diskSync.stop();
    try {
      session.transport?.close();
    } catch {}
    for (const doc of session.docs.values()) {
      try {
        doc.ydoc.destroy();
      } catch {}
    }
    session.docs.clear();
    session.rendererDocs.clear();
    session.peers.clear();
    if (session.resolveWelcome) session.resolveWelcome = null;
  }

  async flush() {
    const session = this.session;
    if (!session) return true;
    return session.diskSync.flush();
  }

  // -------------------------------------------------------------- history
  participantNames(session) {
    return [...session.peers.values()].map((peer) => peer.name);
  }

  recordLabel(reason, names) {
    const list = [...new Set(names)].join(", ");
    const ja = { start: "開始", end: "終了", join: "参加", leave: "退出", rejoin: "再参加前" }[reason] || reason;
    const en = { start: "started", end: "ended", join: "joined", leave: "left", rejoin: "before rejoining" }[reason] || reason;
    return text(this.deps.locale(), `Collaboration ${en}: ${list}`, `共同編集 ${ja}: ${list}`);
  }

  async autoRecord(session, reason) {
    if (this.session !== session || !this.deps.recordVersion) return;
    try {
      await session.diskSync.flush();
      if (this.session !== session) return;
      await this.deps.recordVersion(this.recordLabel(reason, this.participantNames(session)));
    } catch {
      // The lease was not free (Axiom, a build, another operation): skip silently.
    }
  }

  // ------------------------------------------------------------------ docs
  createSessionDoc(session) {
    const doc = this.createDoc(session, SESSION_DOC, null);
    session.sessionDoc = doc.ydoc;
    const files = doc.ydoc.getMap("files");
    files.observe((event, transaction) => {
      if (transaction.origin === LOCAL) return;
      for (const key of event.keysChanged) this.onRemoteFileEntry(session, key, files.get(key));
    });
    const comments = doc.ydoc.getMap("comments");
    comments.observeDeep(() => this.scheduleCommentsPersist(session));
    return doc;
  }

  createDoc(session, docId, initialContent) {
    const existing = session.docs.get(docId);
    if (existing) return existing;
    const ydoc = new Y.Doc({ gc: true });
    const ytext = docId === SESSION_DOC ? null : ydoc.getText("content");
    const entry = { docId, ydoc, ytext, synced: false, attached: false, deleted: false };
    if (ytext && typeof initialContent === "string" && initialContent.length) {
      ydoc.transact(() => ytext.insert(0, initialContent), DISK_ORIGIN);
    }
    ydoc.on("update", (update, origin) => this.onDocUpdate(session, entry, update, origin));
    session.docs.set(docId, entry);
    return entry;
  }

  attachDoc(session, docId, baselineContent) {
    const entry = session.docs.get(docId);
    if (!entry || entry.attached || entry.deleted || docId === SESSION_DOC) return;
    entry.attached = true;
    session.diskSync.attach(docId, entry.ytext, baselineContent);
  }

  // A doc becomes writable once we hold its content: immediately for docs we
  // created from disk, after SyncStep2 for docs received from a peer.
  attachIfReady(session, docId) {
    const entry = session.docs.get(docId);
    if (!entry || entry.attached || entry.deleted || !entry.synced || docId === SESSION_DOC) return;
    if (!session.rootPath) return;
    let baseline = null;
    try {
      baseline = fs.readFileSync(path.join(session.rootPath, docId), "utf8");
    } catch {}
    if (session.joining && baseline !== null && baseline !== entry.ytext.toString()) {
      void this.preserveLocal(session, docId, entry.ytext.toString()).then((kept) => {
        if (kept) this.attachDoc(session, docId, baseline);
      });
      return;
    }
    this.attachDoc(session, docId, baseline);
  }

  onDocUpdate(session, entry, update, origin) {
    if (this.session !== session) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    const frame = transport.encodeDocFrame(transport.FRAME_SYNC, entry.docId, encoding.toUint8Array(encoder));
    if (session.transport) {
      if (session.role === "host") session.transport.broadcast(frame, origin && origin.socket ? origin : null);
      else if (!(origin && origin.socket) && session.access !== "view") session.transport.broadcast(frame);
    }
    if (origin !== RENDERER && session.rendererDocs.has(entry.docId)) {
      this.deps.sendCollab({ type: "collab:doc", sessionId: session.id, epoch: session.epoch, docId: entry.docId, kind: "sync", bytes: encoding.toUint8Array(encoder) });
    }
    if (entry.ytext && entry.attached && origin !== DISK_ORIGIN) session.diskSync.noteUpdate(entry.docId);
    if (entry.docId === SESSION_DOC) this.pushState();
    else if (session.role === "host" && origin !== DISK_ORIGIN) this.logUpdate(session, entry.docId, update, origin);
    // Comment anchors follow the text; keep the JSON's absolute lines current.
    if (entry.docId !== SESSION_DOC && session.sessionDoc?.getMap("comments").size) this.scheduleCommentsPersist(session, 1500);
  }

  // Who wrote what: the host appends every participant update to
  // .tex64/collab/<session>/updates.log (JSON Lines). Oldest log rotates out
  // past 200 MB. Line-level blame is not built on top of this yet.
  logUpdate(session, docId, update, origin) {
    const who = origin === RENDERER ? session.selfId : origin && origin.id ? origin.id : "?";
    const line = `${JSON.stringify({ t: Date.now(), who, doc: docId, update: Buffer.from(update).toString("base64") })}\n`;
    session.updateLog ||= { queue: Promise.resolve(), bytes: 0 };
    const directory = path.join(session.rootPath, ".tex64", "collab", session.id);
    const file = path.join(directory, "updates.log");
    session.updateLog.queue = session.updateLog.queue.then(async () => {
      try {
        if (session.updateLog.bytes === 0) {
          await fsp.mkdir(directory, { recursive: true });
          session.updateLog.bytes = (await fsp.stat(file).catch(() => ({ size: 0 }))).size || 1;
        }
        if (session.updateLog.bytes + line.length > UPDATE_LOG_MAX_BYTES) {
          await fsp.rename(file, `${file}.1`).catch(() => {});
          session.updateLog.bytes = 1;
        }
        await fsp.appendFile(file, line, "utf8");
        session.updateLog.bytes += line.length;
      } catch (error) {
        console.warn("[collab] update log failed", error?.message || error);
      }
    });
  }

  sendSyncStep1(session, docId, conn = null) {
    const entry = session.docs.get(docId);
    if (!entry || !session.transport) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, entry.ydoc);
    const frame = transport.encodeDocFrame(transport.FRAME_SYNC, docId, encoding.toUint8Array(encoder));
    if (conn) session.transport.send(conn, frame);
    else session.transport.broadcast(frame);
  }

  // Applies a sync message from a peer or the renderer; returns the reply bytes
  // (empty when nothing needs sending back).
  applySync(session, entry, payload, origin) {
    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();
    const messageType = syncProtocol.readSyncMessage(decoder, encoder, entry.ydoc, origin);
    if (messageType === syncProtocol.messageYjsSyncStep2 && !entry.synced) {
      entry.synced = true;
      this.attachIfReady(session, entry.docId);
      if (entry.docId === SESSION_DOC && session.role === "guest") this.onSessionDocSynced(session);
    }
    return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
  }

  // ---------------------------------------------------------- peers (ws)
  nextColor(session) {
    const color = COLORS[session.colorCursor % COLORS.length];
    session.colorCursor += 1;
    return color;
  }

  onPeerOpen(session, conn) {
    if (this.session !== session) return;
    if (session.role === "host") {
      const existing = session.peers.get(conn.id);
      if (!existing) {
        for (const [id, stale] of session.peers) {
          if (!stale.connected && !stale.host && stale.name === sanitizeName(conn.hello?.name, "")) session.peers.delete(id);
        }
      }
      const peer = existing || { id: conn.id, name: sanitizeName(conn.hello?.name, "guest"), color: this.nextColor(session), connected: true, host: false, conn };
      peer.conn = conn;
      peer.connected = true;
      peer.viewer = conn.access === "view";
      peer.name = sanitizeName(conn.hello?.name, peer.name);
      session.peers.set(conn.id, peer);
      const welcome = {
        type: "welcome",
        sessionId: session.id,
        name: session.name,
        epoch: session.epoch,
        hostName: session.displayName,
        rootFile: session.rootFileCache || "",
        color: peer.color,
        access: conn.access === "view" ? "view" : "edit",
        peers: [...session.peers.values()].map((item) => ({ id: item.id, name: item.name, color: item.color, connected: item.connected, host: item.host, viewer: item.viewer === true })),
      };
      const sendWelcome = (rootFile) => {
        welcome.rootFile = rootFile || "";
        session.transport.send(conn, transport.encodeControl(welcome));
        for (const docId of session.docs.keys()) this.sendSyncStep1(session, docId, conn);
        this.broadcastPeers(session);
        this.pushState();
        if (!existing) void this.autoRecord(session, "join");
      };
      this.deps.workspace.rootInfo().then((info) => {
        session.rootFileCache = info?.path || "";
        sendWelcome(session.rootFileCache);
      }, () => sendWelcome(""));
    } else {
      // (Re)connected to the host: ask for everything we know about, and
      // for every missing file again at the next scan.
      session.reconnected = Boolean(session.id);
      session.blobRequests?.clear();
      this.pushState();
    }
  }

  onPeerClose(session, conn, info) {
    if (this.session !== session) return;
    if (session.role === "host") {
      const peer = session.peers.get(conn.id);
      if (peer && peer.conn === conn) {
        peer.connected = false;
        peer.conn = null;
        this.broadcastPeers(session);
        this.pushState();
        // A dropped socket usually reconnects within seconds; only a peer
        // that stays away counts as having left.
        setTimeout(() => {
          if (this.session === session && session.peers.get(conn.id) === peer && !peer.connected) void this.autoRecord(session, "leave");
        }, 15000).unref?.();
      }
      return;
    }
    this.pushState();
    if (info?.code === 1000 && session.phase === "active") {
      // The host ended the session or closed cleanly; keep the files, stop.
      this.notice(text(this.deps.locale(), "The host ended the session. Your files stay in this folder.", "ホストがセッションを終了しました。ファイルはこのフォルダに残っています。"));
      void this.leave().catch((error) => this.notice(error?.message || String(error)));
    }
  }

  broadcastPeers(session) {
    if (session.role !== "host") return;
    session.transport.broadcast(transport.encodeControl({
      type: "peers",
      peers: [...session.peers.values()].map((item) => ({ id: item.id, name: item.name, color: item.color, connected: item.connected, host: item.host, viewer: item.viewer === true })),
    }));
  }

  // What a view-only guest may send: requests for state (SyncStep1),
  // presence, and requests for files. Its SyncStep2 replies, updates and
  // file bytes are dropped, so nothing it holds reaches anyone.
  viewerMayApply(session, frame) {
    if (frame.kind === transport.FRAME_AWARENESS) return true;
    if (frame.kind === transport.FRAME_CONTROL) return frame.message.type === "need-blob";
    if (frame.kind !== transport.FRAME_SYNC) return false;
    if (!session.docs.has(frame.docId)) return false;
    try {
      return decoding.readVarUint(decoding.createDecoder(frame.payload)) === syncProtocol.messageYjsSyncStep1;
    } catch {
      return false;
    }
  }

  onPeerFrame(session, conn, frame) {
    if (this.session !== session || session.phase === "leaving") return;
    if (session.role === "host" && conn.access !== "edit" && !this.viewerMayApply(session, frame)) return;
    try {
      if (frame.kind === transport.FRAME_SYNC) {
        const entry = this.docForPeer(session, frame.docId);
        if (!entry) return;
        const reply = this.applySync(session, entry, frame.payload, conn);
        if (reply) session.transport.send(conn, transport.encodeDocFrame(transport.FRAME_SYNC, frame.docId, reply));
        return;
      }
      if (frame.kind === transport.FRAME_AWARENESS) {
        if (session.role === "host") session.transport.broadcast(transport.encodeDocFrame(transport.FRAME_AWARENESS, frame.docId, frame.payload), conn);
        if (session.rendererDocs.has(frame.docId)) {
          this.deps.sendCollab({ type: "collab:doc", sessionId: session.id, epoch: session.epoch, docId: frame.docId, kind: "awareness", bytes: frame.payload });
        }
        return;
      }
      if (frame.kind === transport.FRAME_CONTROL) {
        this.onControl(session, conn, frame.message);
        return;
      }
      if (frame.kind === transport.FRAME_BLOB) {
        void this.onBlob(session, conn, frame);
      }
    } catch (error) {
      console.warn("[collab] peer frame failed", error?.message || error);
    }
  }

  // Which docs a peer may address: the session doc, any known text doc, and
  // (so updates can arrive before the manifest entry) any valid text path.
  docForPeer(session, docId) {
    if (docId === SESSION_DOC) return session.docs.get(SESSION_DOC) || null;
    const existing = session.docs.get(docId);
    if (existing) return existing.deleted ? null : existing;
    if (!safeRelativePath(docId) || !looksTextByName(docId)) return null;
    const entry = this.createDoc(session, docId, null);
    this.sendSyncStep1(session, docId);
    return entry;
  }

  onControl(session, conn, message) {
    switch (message.type) {
      case "welcome":
        if (session.role !== "guest") return;
        if (session.resolveWelcome) {
          const resolve = session.resolveWelcome;
          session.resolveWelcome = null;
          resolve(message);
        } else if (session.id && message.sessionId === session.id) {
          // Reconnected: resync every doc from our state vectors.
          for (const docId of session.docs.keys()) this.sendSyncStep1(session, docId);
        }
        this.applyPeers(session, message.peers, message.hostName);
        return;
      case "peers":
        if (session.role === "guest") this.applyPeers(session, message.peers);
        return;
      case "end":
        if (session.role === "guest") {
          this.notice(text(this.deps.locale(), "The host ended the session. Your files stay in this folder.", "ホストがセッションを終了しました。ファイルはこのフォルダに残っています。"));
          void this.leave().catch((error) => this.notice(error?.message || String(error)));
        }
        return;
      case "need-blob":
        if (session.role !== "host" || !Array.isArray(message.paths)) return;
        // Only files the session shares as binaries; anything else in the
        // host's folder is not the guest's to read.
        for (const relative of message.paths.slice(0, 500)) {
          const shared = typeof relative === "string" ? session.sessionDoc.getMap("files").get(relative) : null;
          if (shared && !shared.deleted && shared.kind === "binary" && shared.hash) void this.sendBlob(session, relative, conn);
        }
        return;
      default:
        return;
    }
  }

  applyPeers(session, peers, hostName) {
    if (!Array.isArray(peers)) return;
    const next = new Map();
    for (const item of peers) {
      if (!item || typeof item.id !== "string") continue;
      next.set(item.id, { id: item.id, name: sanitizeName(item.name, "guest"), color: typeof item.color === "string" ? item.color : COLORS[0], connected: item.connected !== false, host: item.host === true, viewer: item.viewer === true, conn: null });
    }
    if (!next.has(session.selfId)) next.set(session.selfId, { id: session.selfId, name: session.displayName, color: COLORS[1], connected: true, host: false, viewer: session.access === "view", conn: null });
    session.peers = next;
    if (hostName) session.hostName = hostName;
    this.pushState();
  }

  // Guest: the session doc arrived, so the file list is known. Create empty
  // docs for every text file and request every binary.
  onSessionDocSynced(session) {
    const files = session.sessionDoc.getMap("files");
    const needed = [];
    let reduced = 0;
    let skipped = 0;
    files.forEach((entry, relative) => {
      if (!entry || entry.deleted) return;
      if (!safeRelativePath(relative)) return;
      if (entry.kind === "text") {
        if (!session.docs.has(relative)) {
          this.createDoc(session, relative, null);
          this.sendSyncStep1(session, relative);
        }
      } else if (this.lacksFile(session, relative, entry)) {
        needed.push(relative);
        session.pendingBlobs?.add(relative);
      }
      // Told once, together, below; not again file by file.
      if (entry.kind === "skipped") skipped += Number(this.markLimitNotice(session, relative, entry));
      else if (entry.from) reduced += Number(this.markLimitNotice(session, relative, entry));
    });
    this.requestBlobs(session, needed);
    if (reduced || skipped) {
      const parts = [];
      if (reduced) parts.push(text(this.deps.locale(), `${reduced} shared as a smaller copy`, `画質を落として共有されているファイルが ${reduced} 件`));
      if (skipped) parts.push(text(this.deps.locale(), `${skipped} too large to share`, `大きすぎて共有されていないファイルが ${skipped} 件`));
      this.notice(text(this.deps.locale(), `Large files: ${parts.join(", ")}. The Collaborate dialog lists them.`, `${parts.join("、")}あります。共同編集のダイアログに一覧があります。`));
    }
  }

  // A file shared as `entry` that this peer does not have: neither that
  // version nor — for a smaller copy — the original it was made from.
  lacksFile(session, relative, entry) {
    if (!entry || entry.deleted || entry.kind !== "binary" || !entry.hash) return false;
    const known = session.knownBinaryHashes.get(relative);
    return known !== entry.hash && !(entry.from && known === entry.from);
  }

  fileLimit() {
    const limit = Number(this.deps.fileLimitBytes?.());
    return Number.isFinite(limit) && limit > 0 ? limit : MAX_BINARY_BYTES;
  }

  newManifest(rootPath) {
    return new WorkspaceManifest(rootPath, { binaryLimit: this.fileLimit() });
  }

  // The session-doc entry for a non-text file on this peer's disk: the file
  // itself; for an image over the limit, a smaller copy (`from` names the
  // original, which stays untouched); otherwise a note that it is not shared.
  // The owner is told about each smaller copy and each file left out.
  async sharedEntry(session, relative, entry) {
    const by = session.selfId;
    const limit = formatBytes(this.fileLimit());
    if (entry.kind === "binary" && !entry.oversize) return { kind: "binary", hash: entry.hash, size: entry.size, by };
    const reduced = entry.kind === "binary" ? await this.reducedCopy(session, relative, entry) : null;
    if (!reduced) {
      if (this.markLimitNotice(session, relative, { kind: "skipped", size: entry.size })) {
        this.notice(text(this.deps.locale(), `${relative} (${formatBytes(entry.size)}) is larger than ${limit} and is not shared.`, `${relative}（${formatBytes(entry.size)}）は ${limit} を超えるため共有していません。`));
      }
      return { kind: "skipped", size: entry.size, by };
    }
    if (this.markLimitNotice(session, relative, { hash: reduced.hash })) {
      this.notice(text(
        this.deps.locale(),
        `${relative} is larger than ${limit}, so a smaller copy (${formatBytes(entry.size)} → ${formatBytes(reduced.size)}) is shared; your file is unchanged.`,
        `${relative} は ${limit} を超えるため、画質を落とした写し（${formatBytes(entry.size)} → ${formatBytes(reduced.size)}）を共有しています。手元のファイルはそのままです。`,
      ));
    }
    return { kind: "binary", hash: reduced.hash, size: reduced.size, from: entry.hash, original: entry.size, by };
  }

  // A smaller copy of an image over the limit, made once per original and
  // kept in .tex64/collab-reduced/ (outside what is shared).
  reducedCopy(session, relative, entry) {
    session.reducedCopies ||= new Map();
    if (!session.reducedCopies.has(entry.hash)) {
      const making = (async () => {
        const limit = this.fileLimit();
        const extension = extensionOf(relative);
        const cache = path.join(session.rootPath, ".tex64", "collab-reduced", `${entry.hash}.${extension}`);
        let bytes = await fsp.readFile(cache).catch(() => null);
        if (!bytes || bytes.length > limit) {
          const absolute = await resolveInsideRoot(session.rootPath, relative);
          if (!absolute || !this.deps.reduceImage) return null;
          try {
            bytes = await this.deps.reduceImage({ path: absolute, extension, maxBytes: limit });
          } catch (error) {
            console.warn("[collab] image reduce failed", relative, error?.message || error);
            bytes = null;
          }
          if (!bytes || bytes.length > limit) return null;
          await fsp.mkdir(path.dirname(cache), { recursive: true });
          await fsp.writeFile(cache, bytes);
        }
        return { hash: hashBuffer(bytes), size: bytes.length, path: cache };
      })();
      session.reducedCopies.set(entry.hash, making);
      // A failure is not remembered: the next scan may try again.
      making.then((copy) => { if (!copy) session.reducedCopies.delete(entry.hash); }, () => session.reducedCopies.delete(entry.hash));
    }
    return session.reducedCopies.get(entry.hash);
  }

  // Each smaller copy and each file left out is told once per session.
  markLimitNotice(session, relative, entry) {
    session.limitNotices ||= new Set();
    const key = `${relative}\0${entry.kind === "skipped" ? `skip:${entry.size}` : entry.hash}`;
    if (session.limitNotices.has(key)) return false;
    session.limitNotices.add(key);
    return true;
  }

  // A peer's large file, told once (after the join, which tells them together).
  noticeRemoteLimit(session, relative, entry) {
    if (session.joining || !entry || entry.by === session.selfId) return;
    if (entry.kind === "skipped") {
      if (this.markLimitNotice(session, relative, entry)) {
        this.notice(text(this.deps.locale(), `${relative} (${formatBytes(entry.size)}) is too large to be shared.`, `${relative}（${formatBytes(entry.size)}）は大きすぎるため共有されていません。`));
      }
    } else if (entry.kind === "binary" && entry.from && this.markLimitNotice(session, relative, entry)) {
      this.notice(text(
        this.deps.locale(),
        `${relative} is shared as a smaller copy (${formatBytes(entry.original)} → ${formatBytes(entry.size)}); its owner keeps the full file.`,
        `${relative} は元のファイルが大きいため、画質を落として共有されています（${formatBytes(entry.original)} → ${formatBytes(entry.size)}）。`,
      ));
    }
  }

  // Files over the limit in this session: { reduced: [{ path, size, original }], skipped: [{ path, size }] }.
  limitedFiles(session) {
    const reduced = [];
    const skipped = [];
    session.sessionDoc?.getMap("files").forEach((entry, relative) => {
      if (!entry || entry.deleted) return;
      if (entry.kind === "skipped") skipped.push({ path: relative, size: entry.size });
      else if (entry.kind === "binary" && entry.from) reduced.push({ path: relative, size: entry.size, original: entry.original });
    });
    return { reduced, skipped };
  }

  // `repeat`: the scan asking again for what is still missing; a path asked
  // for within BLOB_REREQUEST_MS is left out.
  requestBlobs(session, paths, { repeat = false } = {}) {
    session.blobRequests ||= new Map();
    const now = Date.now();
    const due = repeat ? paths.filter((relative) => now - (session.blobRequests.get(relative) || 0) >= BLOB_REREQUEST_MS) : paths;
    if (!due.length) return;
    for (const relative of due) session.blobRequests.set(relative, now);
    session.transport.broadcast(transport.encodeControl({ type: "need-blob", paths: due }));
    this.pushState();
  }

  // What a guest still waits for: { files, bytes } (sizes from the session doc).
  incomingFiles(session) {
    const files = session.sessionDoc?.getMap("files");
    let bytes = 0;
    for (const relative of session.pendingBlobs || []) bytes += Number(files?.get(relative)?.size) || 0;
    return { files: session.pendingBlobs?.size || 0, bytes };
  }

  // A file the guest waited for is in (or no longer needed).
  blobSettled(session, relative) {
    session.pendingBlobs?.delete(relative);
    session.blobRequests?.delete(relative);
    session.initialBlobs?.delete(relative);
    this.pushState();
  }

  onRemoteFileEntry(session, relative, entry) {
    if (!safeRelativePath(relative)) return;
    if (!entry) return;
    if (entry.deleted) {
      if (session.pendingBlobs?.has(relative)) this.blobSettled(session, relative);
      void this.removeLocal(session, relative);
      return;
    }
    if (entry.kind === "text") {
      const doc = session.docs.get(relative);
      if (!doc) {
        this.createDoc(session, relative, null);
        this.sendSyncStep1(session, relative);
      } else if (doc.deleted) {
        doc.deleted = false;
        doc.synced = false;
        this.sendSyncStep1(session, relative);
      } else {
        this.attachIfReady(session, relative);
      }
      return;
    }
    this.noticeRemoteLimit(session, relative, entry);
    if (this.lacksFile(session, relative, entry)) {
      if (session.role === "guest") {
        session.pendingBlobs?.add(relative);
        this.requestBlobs(session, [relative]);
      }
      // The host receives the bytes directly from the guest that changed them.
    }
  }

  async removeLocal(session, relative) {
    if (!(await this.preserveLocal(session, relative, null))) return;
    const doc = session.docs.get(relative);
    if (doc) {
      doc.deleted = true;
      doc.attached = false;
      session.diskSync.detach(relative);
      session.rendererDocs.delete(relative);
    }
    session.knownBinaryHashes.delete(relative);
    if (!session.rootPath) return;
    const absolute = await resolveInsideRoot(session.rootPath, relative);
    if (!absolute) return;
    try {
      if (session.diskSync.coordinated) {
        await this.deps.withWorkspaceMutation(() => this.deps.workspace.withFileMutation(relative, () => fsp.rm(absolute, { force: true })));
      } else {
        await fsp.rm(absolute, { force: true });
      }
    } catch (error) {
      console.warn("[collab] remove failed", relative, error?.message || error);
    }
    await session.manifest?.refresh(relative);
    this.deps.refreshTree?.();
    this.pushState();
  }

  async sendBlob(session, relative, conn = null, except = null) {
    if (!safeRelativePath(relative) || !session.rootPath) return;
    // Guests that ask for the same file while it is still being sent share
    // one frame: a 50 MB figure for ten guests is one buffer, not ten.
    session.blobFrames ||= new Map();
    // An image over the limit goes out as its smaller copy; a file that is
    // not shared does not go out at all.
    const entry = session.manifest?.get(relative);
    if (entry?.kind === "skipped") return;
    const reduced = entry?.oversize ? await this.reducedCopy(session, relative, entry) : null;
    if (entry?.oversize && !reduced) return;
    const known = reduced ? reduced.hash : session.knownBinaryHashes.get(relative);
    let frame = known ? session.blobFrames.get(`${relative}\0${known}`)?.deref() : null;
    let hash = frame ? known : null;
    if (!frame) {
      const absolute = reduced ? reduced.path : await resolveInsideRoot(session.rootPath, relative);
      if (!absolute) return;
      let bytes;
      try {
        bytes = await fsp.readFile(absolute);
      } catch {
        return;
      }
      // Grown past the limit since the last scan: the next scan decides.
      if (bytes.length > this.fileLimit()) return;
      hash = hashBuffer(bytes);
      frame = transport.encodeBlob(relative, hash, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      for (const [key, ref] of session.blobFrames) if (!ref.deref()) session.blobFrames.delete(key);
      session.blobFrames.set(`${relative}\0${hash}`, new WeakRef(frame));
    }
    // A request repeated while the same version of the file is the last one
    // on its way to that peer is not queued again (the relay route honours it).
    const options = { slot: `blob:${relative}`, version: hash };
    if (conn) session.transport.send(conn, frame, options);
    else session.transport.broadcast(frame, except, options);
  }

  async onBlob(session, conn, frame) {
    const relative = safeRelativePath(frame.path);
    if (!relative || !session.rootPath) return;
    if (!looksTextByName(relative) || frame.bytes.length > MAX_TEXT_BYTES) {
      // fallthrough: binary payload
    }
    const hash = hashBuffer(Buffer.from(frame.bytes));
    if (hash !== frame.hash) return;
    const shared = session.sessionDoc?.getMap("files").get(relative);
    const known = session.knownBinaryHashes.get(relative);
    // The same version, or a smaller copy of the original this peer holds.
    if (known === hash || (shared?.from && shared.hash === hash && known === shared.from)) {
      this.blobSettled(session, relative);
      return;
    }
    const absolute = await resolveInsideRoot(session.rootPath, relative);
    if (!absolute) return;
    if (!(await this.preserveLocal(session, relative, frame.bytes))) return;
    const write = async () => {
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fsp.writeFile(temporary, Buffer.from(frame.bytes));
      await fsp.rename(temporary, absolute);
    };
    try {
      if (session.diskSync.coordinated) await this.deps.withWorkspaceMutation(() => this.deps.workspace.withFileMutation(relative, write));
      else await write();
      session.knownBinaryHashes.set(relative, hash);
      await session.manifest?.refresh(relative);
      this.blobSettled(session, relative);
      if (session.role === "host") {
        session.transport.broadcast(transport.encodeBlob(relative, hash, frame.bytes), conn);
        // A guest's smaller copy keeps naming the original it came from, so
        // that guest is not sent its own copy back.
        const copyOf = shared?.hash === hash && shared.from ? { from: shared.from, original: shared.original } : {};
        session.sessionDoc.transact(() => {
          session.sessionDoc.getMap("files").set(relative, { kind: "binary", hash, size: frame.bytes.length, by: session.selfId, ...copyOf });
        }, LOCAL);
      }
      this.deps.refreshTree?.();
    } catch (error) {
      console.warn("[collab] blob write failed", relative, error?.message || error);
    }
  }

  // ----------------------------------------------------------- manifest
  startScanning(session) {
    clearInterval(session.scanTimer);
    session.scanTimer = setInterval(() => void this.rescan(), SCAN_INTERVAL_MS);
    session.scanTimer.unref?.();
  }

  async rescan() {
    const session = this.session;
    if (!session || session.phase !== "active" || !session.manifest || session.scanning) return;
    session.scanning = true;
    try {
      const { added, changed, removed } = await session.manifest.scan();
      if (this.session !== session) return;
      const files = session.sessionDoc.getMap("files");
      // A view-only guest announces nothing: a shared file changed here goes
      // back to the host's content, a new file stays local.
      const viewOnly = session.role === "guest" && session.access === "view";
      for (const relative of [...added, ...changed]) {
        const entry = session.manifest.get(relative);
        if (!entry) continue;
        if (entry.kind === "text") {
          const doc = session.docs.get(relative);
          if (!doc || doc.deleted) {
            if (viewOnly) continue;
            let content;
            try {
              content = await fsp.readFile(path.join(session.rootPath, relative), "utf8");
            } catch {
              continue;
            }
            if (doc) {
              doc.deleted = false;
              doc.synced = true;
              session.docs.delete(relative);
            }
            const created = this.createDoc(session, relative, content);
            created.synced = true;
            session.sessionDoc.transact(() => files.set(relative, { kind: "text", by: session.selfId }), LOCAL);
            this.attachDoc(session, relative, content);
            this.sendSyncStep1(session, relative);
          } else if (doc.attached) {
            void session.diskSync.ingestDisk(relative);
          } else {
            this.attachIfReady(session, relative);
          }
        } else {
          // A binary, or a file over the limit that is not shared.
          if (entry.kind === "binary" && session.knownBinaryHashes.get(relative) === entry.hash) continue;
          const shared = files.get(relative);
          if (viewOnly) {
            // The request below fetches the host's bytes again.
            if (entry.kind === "binary" && shared && !shared.deleted) session.knownBinaryHashes.set(relative, entry.hash);
            continue;
          }
          if (entry.kind === "binary" && shared && (shared.hash === entry.hash || shared.from === entry.hash)) {
            session.knownBinaryHashes.set(relative, entry.hash);
            if (session.pendingBlobs?.has(relative)) this.blobSettled(session, relative);
            continue;
          }
          // A file of the join that has not arrived yet: what is on disk is
          // an old copy (a rejoin), not this guest's change to share. When
          // the host's bytes arrive, an edited old copy is kept beside them.
          if (session.initialBlobs?.has(relative)) continue;
          if (entry.kind === "skipped" && shared?.kind === "skipped" && shared.size === entry.size) continue;
          if (entry.hash) session.knownBinaryHashes.set(relative, entry.hash);
          else session.knownBinaryHashes.delete(relative);
          const next = await this.sharedEntry(session, relative, entry);
          if (this.session !== session) return;
          session.sessionDoc.transact(() => files.set(relative, next), LOCAL);
          if (next.kind === "binary") void this.sendBlob(session, relative);
        }
      }
      for (const relative of removed) {
        const shared = files.get(relative);
        if (shared?.deleted) continue;
        // A file that was never shared: nobody has a copy to remove.
        if (shared?.kind === "skipped") {
          if (!viewOnly) session.sessionDoc.transact(() => files.delete(relative), LOCAL);
          continue;
        }
        // Removing the old copy of a file still on its way deletes nothing for others.
        if (session.initialBlobs?.has(relative)) continue;
        const doc = session.docs.get(relative);
        if (viewOnly) {
          if (doc?.attached) session.diskSync.noteUpdate(relative);
          session.knownBinaryHashes.delete(relative);
          continue;
        }
        if (doc) {
          doc.deleted = true;
          doc.attached = false;
          session.diskSync.detach(relative);
          session.rendererDocs.delete(relative);
        }
        session.knownBinaryHashes.delete(relative);
        session.sessionDoc.transact(() => files.set(relative, { deleted: true, by: session.selfId, t: Date.now() }), LOCAL);
      }
      // Guest: binaries the host announced but we still lack.
      if (session.role === "guest") {
        const needed = [];
        files.forEach((entry, relative) => {
          if (this.lacksFile(session, relative, entry)) needed.push(relative);
        });
        this.requestBlobs(session, needed, { repeat: true });
      }
    } catch (error) {
      console.warn("[collab] scan failed", error?.message || error);
    } finally {
      session.scanning = false;
    }
  }

  // The existing workspace watcher saw a change on an open file.
  ingestDisk(relative) {
    const session = this.session;
    if (!session || session.phase !== "active") return false;
    const doc = session.docs.get(relative);
    if (!doc || !doc.attached) return false;
    void session.diskSync.ingestDisk(relative);
    return true;
  }

  // ---------------------------------------------------------- renderer
  handleRendererFrame(frame) {
    const session = this.session;
    if (!session || !frame || typeof frame !== "object") return;
    if (frame.sessionId !== session.id || frame.epoch !== session.epoch) return;
    const docId = typeof frame.docId === "string" ? frame.docId : "";
    if (!docId) return;
    if (frame.kind === "open") {
      const entry = docId === SESSION_DOC ? session.docs.get(SESSION_DOC) : session.docs.get(docId);
      if (!entry || entry.deleted || (docId !== SESSION_DOC && !entry.attached)) {
        this.deps.sendCollab({ type: "collab:docRefused", sessionId: session.id, epoch: session.epoch, docId });
        return;
      }
      session.rendererDocs.add(docId);
      return;
    }
    if (frame.kind === "close") {
      session.rendererDocs.delete(docId);
      return;
    }
    const bytes = frame.bytes instanceof Uint8Array ? frame.bytes : null;
    if (!bytes || bytes.length > transport.MAX_FRAME_BYTES) return;
    if (frame.kind === "sync") {
      const entry = session.docs.get(docId);
      if (!entry || entry.deleted) return;
      if (session.access === "view") {
        let type = -1;
        try {
          type = decoding.readVarUint(decoding.createDecoder(bytes));
        } catch {}
        if (type !== syncProtocol.messageYjsSyncStep1) return;
      }
      const reply = this.applySync(session, entry, bytes, RENDERER);
      if (reply) this.deps.sendCollab({ type: "collab:doc", sessionId: session.id, epoch: session.epoch, docId, kind: "sync", bytes: reply });
      return;
    }
    if (frame.kind === "awareness") {
      if (!session.transport) return;
      session.transport.broadcast(transport.encodeDocFrame(transport.FRAME_AWARENESS, docId, bytes));
    }
  }

  // ---------------------------------------------------------- comments
  commentsPath(session) {
    return path.join(session.rootPath, ".tex64", "comments.json");
  }

  positionOf(content, offset) {
    const clamped = Math.max(0, Math.min(content.length, offset));
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < clamped; i++) {
      if (content.charCodeAt(i) === 10) {
        line += 1;
        lineStart = i + 1;
      }
    }
    return { lineNumber: line, column: clamped - lineStart + 1 };
  }

  offsetOf(content, lineNumber, column) {
    let line = 1;
    let offset = 0;
    while (line < lineNumber) {
      const next = content.indexOf("\n", offset);
      if (next < 0) return content.length;
      offset = next + 1;
      line += 1;
    }
    const lineEnd = content.indexOf("\n", offset);
    const end = lineEnd < 0 ? content.length : lineEnd;
    return Math.min(end, offset + Math.max(0, column - 1));
  }

  // Session comments → the JSON file the editor reads outside sessions.
  exportComments(session) {
    const comments = [];
    const map = session.sessionDoc.getMap("comments");
    map.forEach((value, id) => {
      if (!(value instanceof Y.Map)) return;
      const filePath = value.get("filePath");
      const doc = session.docs.get(filePath);
      let range = value.get("range") || null;
      if (doc?.ytext && value.get("anchor") && value.get("head")) {
        try {
          const content = doc.ytext.toString();
          const anchor = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.get("anchor")), doc.ydoc);
          const head = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.get("head")), doc.ydoc);
          if (anchor && head) {
            const start = this.positionOf(content, Math.min(anchor.index, head.index));
            const end = this.positionOf(content, Math.max(anchor.index, head.index));
            range = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
          }
        } catch {}
      }
      if (!range) return;
      const replies = value.get("replies");
      comments.push({
        id,
        filePath,
        range,
        text: value.get("text") || "",
        author: value.get("author") || "",
        createdAt: value.get("createdAt") || Date.now(),
        updatedAt: value.get("updatedAt") || Date.now(),
        resolved: value.get("resolved") === true,
        replies: replies instanceof Y.Array ? replies.toArray() : [],
      });
    });
    return { schema: 1, comments };
  }

  scheduleCommentsPersist(session, delay = 400) {
    if (this.session !== session) return;
    if (session.commentsTimer) return;
    session.commentsTimer = setTimeout(() => {
      session.commentsTimer = null;
      void this.persistComments(session);
    }, delay);
    session.commentsTimer.unref?.();
  }

  async persistComments(session, { silent = false } = {}) {
    if (this.session !== session || !session.rootPath || !session.sessionDoc) return;
    try {
      const payload = this.exportComments(session);
      const target = this.commentsPath(session);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
      if (!silent) this.deps.sendCollab({ type: "collab:comments", sessionId: session.id });
    } catch (error) {
      console.warn("[collab] comments persist failed", error?.message || error);
    }
  }

  async loadCommentsFromDisk(session) {
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(this.commentsPath(session), "utf8"));
    } catch {
      return;
    }
    if (!parsed || !Array.isArray(parsed.comments)) return;
    const map = session.sessionDoc.getMap("comments");
    session.sessionDoc.transact(() => {
      for (const item of parsed.comments) {
        if (!item || typeof item.id !== "string" || typeof item.filePath !== "string" || !item.range) continue;
        const ymap = new Y.Map();
        ymap.set("filePath", item.filePath);
        ymap.set("text", String(item.text || "").slice(0, 4000));
        ymap.set("author", String(item.author || "").slice(0, 80));
        ymap.set("createdAt", Number(item.createdAt) || Date.now());
        ymap.set("updatedAt", Number(item.updatedAt) || Date.now());
        ymap.set("resolved", item.resolved === true);
        ymap.set("range", item.range);
        const replies = new Y.Array();
        if (Array.isArray(item.replies)) replies.push(item.replies.filter((reply) => reply && typeof reply.text === "string").slice(0, 200));
        ymap.set("replies", replies);
        const doc = session.docs.get(item.filePath);
        if (doc?.ytext) {
          const content = doc.ytext.toString();
          const start = this.offsetOf(content, item.range.startLineNumber, item.range.startColumn);
          const end = this.offsetOf(content, item.range.endLineNumber, item.range.endColumn);
          ymap.set("anchor", Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.ytext, start)));
          ymap.set("head", Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.ytext, end, -1)));
        }
        map.set(item.id, ymap);
      }
    }, LOCAL);
  }
}

module.exports = { CollabHub, SESSION_DOC, COLORS };
