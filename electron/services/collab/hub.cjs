"use strict";

// The session hub. One per app. Holds the session state, a Y.Doc per shared
// text file plus one session Y.Doc (manifest `files`, `comments`), encodes /
// decodes y-protocols sync and awareness messages, and moves them between
// three kinds of peers: the renderer (IPC), network peers (transport-ws), and
// the disk (disk-sync). The host runs the ws server; guests connect to it and
// keep a mirror of the workspace under ~/TeX64 Collab/.

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
const invite = require("./invite.cjs");
const { WorkspaceManifest, safeRelativePath, resolveInsideRoot, looksTextByName, hashBuffer, MAX_TEXT_BYTES } = require("./manifest.cjs");
const { DiskSync, DISK_ORIGIN } = require("./disk-sync.cjs");

const SESSION_DOC = "$session";
const RENDERER = "renderer";
const LOCAL = "local";
const SCAN_INTERVAL_MS = 3000;
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

  isSyncedTextPath(relativePath) {
    const session = this.session;
    if (!session || session.phase !== "active") return false;
    const entry = session.docs.get(relativePath);
    return Boolean(entry && !entry.deleted && entry.attached);
  }

  status() {
    const session = this.session;
    if (!session) return { active: false, phase: "idle" };
    const participants = [];
    for (const peer of session.peers.values()) {
      participants.push({ id: peer.id, name: peer.name, color: peer.color, connected: peer.connected, host: peer.host, self: peer.id === session.selfId });
    }
    return {
      active: session.phase === "active",
      phase: session.phase,
      role: session.role,
      sessionId: session.id,
      epoch: session.epoch,
      name: session.name,
      inviteLink: session.inviteLink || null,
      selfId: session.selfId,
      connected: session.role === "host" ? true : Boolean(session.transport?.connected),
      participants,
      rootPath: session.rootPath,
      preserved: session.preserved ? session.preserved.length : 0,
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
    try {
      session.peers.set(session.selfId, { id: session.selfId, name: displayName, color: this.nextColor(session), connected: true, host: true, conn: null });
      this.createSessionDoc(session);
      session.manifest = new WorkspaceManifest(rootPath);
      await session.manifest.scan();
      const files = session.sessionDoc.getMap("files");
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
            session.knownBinaryHashes.set(relative, entry.hash);
            files.set(relative, { kind: "binary", hash: entry.hash, size: entry.size, by: session.selfId });
          }
        }
      }, LOCAL);
      await this.loadCommentsFromDisk(session);
      session.diskSync.coordinated = true;
      const host = new transport.HostTransport({ token: session.token });
      const port = await host.start();
      session.transport = host;
      session.inviteLink = invite.buildInviteLink({ host: invite.localHostAddress(), port, token: session.token, name: sessionName });
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
      const guest = new transport.GuestTransport({
        host: parsed.host,
        port: parsed.port,
        token: parsed.token,
        hello: { clientId: session.selfId, name: displayName },
      });
      session.transport = guest;
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
      // Doc frames follow the welcome immediately; everything that decides
      // how they are written must be in place before the first await below.
      session.joining = true;
      session.preserved = [];
      session.diskSync.paused = true;
      session.id = hello.sessionId;
      session.name = hello.name || session.name;
      session.epoch = hello.epoch || 1;
      session.hostName = hello.hostName;
      session.rootFile = hello.rootFile || "";
      session.rootPath = path.join(this.deps.collabRoot(), `${safeSessionFolderName(session.name)}-${session.id.slice(0, 8)}`);
      const rejoining = await fsp.readdir(session.rootPath).then((names) => names.some((name) => name !== ".tex64")).catch(() => false);
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
      // The session doc tells us which files exist; wait for every text doc
      // and every blob, then write the mirror and open it.
      await this.waitForInitialSync(session);
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
      session.manifest = new WorkspaceManifest(session.rootPath);
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

  // Guest join onto an existing mirror: keep a copy of a file whose local
  // content differs from what the host sends.
  async preserveLocal(session, relative, incoming) {
    if (!session.joining || !session.rootPath) return;
    const absolute = path.join(session.rootPath, relative);
    let current;
    try {
      current = await fsp.readFile(absolute);
    } catch {
      return;
    }
    if (typeof incoming === "string" ? current.toString("utf8") === incoming : Buffer.from(incoming).equals(current)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const extension = path.extname(relative);
    const target = `${absolute.slice(0, absolute.length - extension.length)}.local-${stamp}${extension}`;
    try {
      await fsp.copyFile(absolute, target);
      session.preserved.push(relative);
    } catch (error) {
      console.warn("[collab] preserve failed", relative, error?.message || error);
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
        const blobsReady = sessionReady && session.pendingBlobs.size === 0;
        if (sessionReady && docsReady && blobsReady) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          if (sessionReady && docsReady) {
            // Missing blobs are refetched by the manifest scan later.
            resolve();
            return;
          }
          reject(Object.assign(new Error(text(this.deps.locale(), "The host did not send the project in time.", "ホストからプロジェクトを受け取れませんでした。")), { code: "COLLAB_TIMEOUT" }));
          return;
        }
        setTimeout(check, 100).unref?.();
      };
      check();
    });
  }

  async leave() {
    const session = this.session;
    if (!session) return { ok: true };
    const role = session.role;
    session.phase = "leaving";
    this.pushState();
    await session.diskSync.flush();
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
      void this.preserveLocal(session, docId, entry.ytext.toString()).then(() => this.attachDoc(session, docId, baseline));
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
      else if (!(origin && origin.socket)) session.transport.broadcast(frame);
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
        peers: [...session.peers.values()].map((item) => ({ id: item.id, name: item.name, color: item.color, connected: item.connected, host: item.host })),
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
      // (Re)connected to the host: ask for everything we know about.
      session.reconnected = Boolean(session.id);
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
      void this.leave();
    }
  }

  broadcastPeers(session) {
    if (session.role !== "host") return;
    session.transport.broadcast(transport.encodeControl({
      type: "peers",
      peers: [...session.peers.values()].map((item) => ({ id: item.id, name: item.name, color: item.color, connected: item.connected, host: item.host })),
    }));
  }

  onPeerFrame(session, conn, frame) {
    if (this.session !== session) return;
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
          void this.leave();
        }
        return;
      case "need-blob":
        if (session.role !== "host" || !Array.isArray(message.paths)) return;
        for (const relative of message.paths.slice(0, 500)) void this.sendBlob(session, relative, conn);
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
      next.set(item.id, { id: item.id, name: sanitizeName(item.name, "guest"), color: typeof item.color === "string" ? item.color : COLORS[0], connected: item.connected !== false, host: item.host === true, conn: null });
    }
    if (!next.has(session.selfId)) next.set(session.selfId, { id: session.selfId, name: session.displayName, color: COLORS[1], connected: true, host: false, conn: null });
    session.peers = next;
    if (hostName) session.hostName = hostName;
    this.pushState();
  }

  // Guest: the session doc arrived, so the file list is known. Create empty
  // docs for every text file and request every binary.
  onSessionDocSynced(session) {
    const files = session.sessionDoc.getMap("files");
    const needed = [];
    files.forEach((entry, relative) => {
      if (!entry || entry.deleted) return;
      if (!safeRelativePath(relative)) return;
      if (entry.kind === "text") {
        if (!session.docs.has(relative)) {
          this.createDoc(session, relative, null);
          this.sendSyncStep1(session, relative);
        }
      } else if (entry.kind === "binary" && entry.hash) {
        if (session.knownBinaryHashes.get(relative) !== entry.hash) {
          needed.push(relative);
          session.pendingBlobs?.add(relative);
        }
      }
    });
    if (needed.length) session.transport.broadcast(transport.encodeControl({ type: "need-blob", paths: needed }));
  }

  onRemoteFileEntry(session, relative, entry) {
    if (!safeRelativePath(relative)) return;
    if (!entry) return;
    if (entry.deleted) {
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
    if (entry.kind === "binary" && entry.hash && session.knownBinaryHashes.get(relative) !== entry.hash) {
      if (session.role === "guest") {
        session.pendingBlobs?.add(relative);
        session.transport.broadcast(transport.encodeControl({ type: "need-blob", paths: [relative] }));
      }
      // The host receives the bytes directly from the guest that changed them.
    }
  }

  async removeLocal(session, relative) {
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
    const absolute = await resolveInsideRoot(session.rootPath, relative);
    if (!absolute) return;
    let bytes;
    try {
      bytes = await fsp.readFile(absolute);
    } catch {
      return;
    }
    const hash = hashBuffer(bytes);
    const frame = transport.encodeBlob(relative, hash, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (conn) session.transport.send(conn, frame);
    else session.transport.broadcast(frame, except);
  }

  async onBlob(session, conn, frame) {
    const relative = safeRelativePath(frame.path);
    if (!relative || !session.rootPath) return;
    if (!looksTextByName(relative) || frame.bytes.length > MAX_TEXT_BYTES) {
      // fallthrough: binary payload
    }
    const hash = hashBuffer(Buffer.from(frame.bytes));
    if (hash !== frame.hash) return;
    if (session.knownBinaryHashes.get(relative) === hash) {
      session.pendingBlobs?.delete(relative);
      return;
    }
    const absolute = await resolveInsideRoot(session.rootPath, relative);
    if (!absolute) return;
    await this.preserveLocal(session, relative, frame.bytes);
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
      session.pendingBlobs?.delete(relative);
      if (session.role === "host") {
        session.transport.broadcast(transport.encodeBlob(relative, hash, frame.bytes), conn);
        session.sessionDoc.transact(() => {
          session.sessionDoc.getMap("files").set(relative, { kind: "binary", hash, size: frame.bytes.length, by: session.selfId });
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
      for (const relative of [...added, ...changed]) {
        const entry = session.manifest.get(relative);
        if (!entry) continue;
        if (entry.kind === "text") {
          const doc = session.docs.get(relative);
          if (!doc || doc.deleted) {
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
        } else if (entry.kind === "binary") {
          if (session.knownBinaryHashes.get(relative) === entry.hash) continue;
          const shared = files.get(relative);
          if (shared && shared.hash === entry.hash) {
            session.knownBinaryHashes.set(relative, entry.hash);
            session.pendingBlobs?.delete(relative);
            continue;
          }
          session.knownBinaryHashes.set(relative, entry.hash);
          session.sessionDoc.transact(() => files.set(relative, { kind: "binary", hash: entry.hash, size: entry.size, by: session.selfId }), LOCAL);
          void this.sendBlob(session, relative);
        }
      }
      for (const relative of removed) {
        const shared = files.get(relative);
        if (shared?.deleted) continue;
        const doc = session.docs.get(relative);
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
          if (entry && !entry.deleted && entry.kind === "binary" && entry.hash && session.knownBinaryHashes.get(relative) !== entry.hash) needed.push(relative);
        });
        if (needed.length) session.transport.broadcast(transport.encodeControl({ type: "need-blob", paths: needed }));
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
