// The one dialog (File › Collaborate…) and the participant dots that appear
// left of Build only while a session runs.
import { uiText } from "../i18n.js";
import { showEditorNotice } from "../editor-notice.js";
import { createExplain, explainedHeading } from "../explain.js";
import { collabSession } from "./session.js";
const MAX_DOTS = 5;
export const initCollabUi = () => {
    const dots = document.getElementById("collab-participants");
    let dialog = null;
    let pendingLink = "";
    let busy = false;
    let errorText = "";
    let defaultName = "";
    // The route a new session takes, from the last status call.
    let idleRoute = "lan";
    // Which invite link the host is showing: the edit link or the view link.
    let linkAccess = "edit";
    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        node.className = className;
        node.textContent = text;
        return node;
    };
    const button = (label, handler, primary = false) => {
        const node = el("button", `tool-button${primary ? " is-primary" : ""}`, label);
        node.type = "button";
        node.addEventListener("click", handler);
        return node;
    };
    const renderDots = (state) => {
        if (!dots)
            return;
        dots.setAttribute("aria-label", uiText("Collaboration session", "共同編集のセッション"));
        if (!state.active) {
            dots.hidden = true;
            dots.replaceChildren();
            dots.title = uiText("Collaboration session", "共同編集のセッション");
            return;
        }
        dots.hidden = false;
        dots.replaceChildren();
        const participants = state.participants;
        participants.slice(0, MAX_DOTS).forEach((participant) => {
            const dot = el("span", `collab-dot${participant.connected ? "" : " is-offline"}${participant.self ? " is-self" : ""}`);
            dot.style.setProperty("--collab-color", participant.color);
            dot.title = participant.name;
            dot.dataset.noI18n = "true";
            dots.append(dot);
        });
        if (participants.length > MAX_DOTS) {
            const more = el("span", "collab-dot-more", `+${participants.length - MAX_DOTS}`);
            more.dataset.noI18n = "true";
            dots.append(more);
        }
        const incoming = state.role === "guest" && state.incoming && state.incoming.files > 0
            ? uiText(` · receiving ${state.incoming.files} file(s)`, `・ファイルを受け取り中（残り ${state.incoming.files} 件）`)
            : "";
        dots.title = state.connected === false
            ? uiText("Reconnecting…", "再接続中…")
            : participants.map((participant) => participant.name).join(", ") + incoming;
        dots.setAttribute("aria-label", uiText("Collaboration session", "共同編集のセッション"));
    };
    const megabytes = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
    const incomingText = (state) => {
        const incoming = state.role === "guest" ? state.incoming : null;
        if (!incoming || incoming.files <= 0)
            return "";
        return uiText(`Receiving files from the host: ${incoming.files} left (${megabytes(incoming.bytes)})`, `ホストからファイルを受け取り中（残り ${incoming.files} 件・${megabytes(incoming.bytes)}）`);
    };
    // Every file over the size limit stays listed here: a smaller copy is
    // shared, or nothing is.
    const limitedText = (state) => {
        const limited = state.limitedFiles;
        const list = (items, label) => {
            const shown = items.slice(0, 3).map(label).join(uiText(", ", "、"));
            return items.length > 3 ? shown + uiText(` and ${items.length - 3} more`, ` ほか ${items.length - 3} 件`) : shown;
        };
        const lines = [];
        if (limited === null || limited === void 0 ? void 0 : limited.reduced.length) {
            const files = list(limited.reduced, (item) => `${item.path}（${megabytes(item.original)} → ${megabytes(item.size)}）`);
            lines.push(uiText(`Shared as a smaller copy (over the size limit): ${files}`, `大きすぎるため画質を落として共有: ${files}`));
        }
        if (limited === null || limited === void 0 ? void 0 : limited.skipped.length) {
            const files = list(limited.skipped, (item) => `${item.path}（${megabytes(item.size)}）`);
            lines.push(uiText(`Too large to share: ${files}`, `大きすぎて共有されていない: ${files}`));
        }
        return lines;
    };
    const preservedText = (state) => {
        const preserved = Number(state.preserved || 0);
        if (state.role !== "guest" || preserved <= 0)
            return "";
        const names = (state.preservedFiles || []).slice(0, 3);
        const rest = preserved - names.length;
        const list = names.join(", ") + (rest > 0 ? uiText(` and ${rest} more`, ` ほか ${rest} 件`) : "");
        return uiText(`Edited after you left, kept as: ${list}`, `退出後に編集した分を退避しました: ${list}`);
    };
    const field = (className, label) => {
        const input = el("input", `tool-input ${className}`);
        input.setAttribute("aria-label", label);
        return input;
    };
    const initialOf = (name) => (Array.from(name.trim())[0] || "?").toUpperCase();
    const renderDialog = () => {
        if (!dialog)
            return;
        const state = collabSession.getState();
        const eyebrow = el("p", "tool-dialog-eyebrow", "Collaborate");
        eyebrow.dataset.noI18n = "true";
        if (state.active && state.name) {
            const detail = el("span", "tool-dialog-eyebrow-detail", `· ${state.name}`);
            eyebrow.append(detail);
        }
        const title = el("h2", "tool-dialog-title", uiText("Collaborate", "共同編集"));
        title.id = "collab-dialog-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const content = el("div", "collab-dialog-body");
        const error = el("p", "tool-dialog-error", errorText);
        error.setAttribute("role", "status");
        if (state.phase === "starting" || state.phase === "opening" || (busy && !state.active)) {
            content.append(el("p", "tool-dialog-note", state.role === "guest"
                ? uiText("Joining the session…", "セッションに参加しています…")
                : uiText("Starting the session…", "セッションを開始しています…")));
        }
        else if (!state.active) {
            const nameRow = el("label", "collab-field");
            nameRow.append(el("span", "tool-dialog-label", uiText("Your name", "表示名")));
            const nameField = field("collab-name-input", uiText("Your name", "表示名"));
            nameField.maxLength = 40;
            nameField.value = defaultName;
            nameField.addEventListener("input", () => { defaultName = nameField.value; });
            nameRow.append(nameField);
            const start = button(uiText("Start a session", "セッションを開始"), () => void run(() => collabSession.start(nameField.value.trim())));
            const startExplain = createExplain(idleRoute === "relay"
                ? uiText("People can join over the internet. Everything is encrypted between the computers; the relay in between cannot read it.", "インターネット越しに参加できます。内容は参加者の間で暗号化され、間の中継サーバーには読めません。")
                : uiText("Starting a session opens a port on this computer; macOS may ask to allow incoming connections. Only people on the same network (LAN / VPN) can join.", "セッションを開始するとこの Mac がポートを開きます。macOS が接続の許可を確認することがあります。参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。"));
            const startRow = el("div", "collab-start-row has-explain");
            startRow.append(start, startExplain.button);
            const joinSection = el("div", "collab-section collab-join");
            joinSection.append(el("p", "tool-dialog-label", uiText("Join with a link", "招待リンクで参加")));
            const linkField = field("collab-join-input", uiText("Paste an invite link", "招待リンクを貼り付け"));
            linkField.placeholder = uiText("Paste an invite link", "招待リンクを貼り付け");
            linkField.value = pendingLink;
            linkField.dataset.noI18n = "true";
            const join = button(uiText("Join", "参加"), () => void run(() => collabSession.join(linkField.value.trim(), nameField.value.trim())));
            const row = el("div", "collab-link-row");
            row.append(linkField, join);
            joinSection.append(row);
            const startSection = el("div", "collab-section collab-start");
            startSection.append(startRow, startExplain.panel);
            const syncPrimary = () => {
                const hasLink = linkField.value.trim().length > 0;
                join.classList.toggle("is-primary", hasLink);
                start.classList.toggle("is-primary", !hasLink);
                startSection.hidden = hasLink;
            };
            linkField.addEventListener("input", () => { pendingLink = linkField.value; syncPrimary(); });
            syncPrimary();
            content.append(nameRow, startSection, joinSection);
            window.requestAnimationFrame(() => (pendingLink ? linkField : nameField).focus());
        }
        else {
            if (state.inviteLink) {
                const invite = el("div", "collab-section");
                invite.append(...explainedHeading(el("p", "tool-dialog-label", uiText("Invite link", "招待リンク")), state.route === "relay"
                    ? uiText("Anyone with the link can join from anywhere.", "リンクを知っている人は、どこからでも参加できます。")
                    : uiText("Only people on the same network (LAN / VPN) can join.", "参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。")));
                const linkFor = () => (linkAccess === "view" && state.viewInviteLink ? state.viewInviteLink : state.inviteLink || "");
                const link = field("", uiText("Invite link", "招待リンク"));
                link.readOnly = true;
                link.value = linkFor();
                link.dataset.noI18n = "true";
                const copy = button(uiText("Copy", "コピー"), () => {
                    var _a;
                    void ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(linkFor()).then(() => { copy.textContent = uiText("Copied", "コピーしました"); }, () => { link.select(); }));
                }, true);
                if (state.viewInviteLink) {
                    const access = el("div", "tool-segmented collab-access");
                    access.setAttribute("role", "group");
                    access.setAttribute("aria-label", uiText("What the link allows", "リンクでできること"));
                    const choices = [["edit", uiText("Can edit", "編集できる")], ["view", uiText("View only", "閲覧のみ")]];
                    for (const [value, label] of choices) {
                        const option = el("button", "", label);
                        option.type = "button";
                        option.dataset.access = value;
                        option.setAttribute("aria-pressed", String(linkAccess === value));
                        option.addEventListener("click", () => {
                            linkAccess = value;
                            for (const other of access.querySelectorAll("button"))
                                other.setAttribute("aria-pressed", String(other === option));
                            link.value = linkFor();
                            copy.textContent = uiText("Copy", "コピー");
                        });
                        access.append(option);
                    }
                    invite.append(access);
                }
                const row = el("div", "collab-link-row collab-dialog-link");
                row.append(link, copy);
                invite.append(row);
                content.append(invite);
            }
            const people = el("div", "collab-section");
            const peopleHeading = el("p", "tool-dialog-label", `${uiText("Participants", "参加者")} · ${state.participants.length}`);
            // A guest's ▾: where its copy lives, and what viewing allows.
            const guestExplain = [];
            if (state.role === "guest" && state.access === "view") {
                guestExplain.push(uiText("You joined to view: you can read, follow and build, but not edit.", "閲覧のみで参加しています。読む・追う・ビルドはできますが、編集はできません。"));
            }
            if (state.role === "guest" && state.rootPath) {
                const where = el("p", "", "");
                where.append(`${uiText("Your copy", "写しの場所")}: `, el("code", "", state.rootPath), uiText(". It stays after you leave.", "。退出後も残ります。"));
                where.dataset.noI18n = "true";
                guestExplain.push(where);
            }
            if (guestExplain.length)
                people.append(...explainedHeading(peopleHeading, guestExplain));
            else
                people.append(peopleHeading);
            const list = el("ul", "collab-people collab-dialog-participants");
            for (const participant of state.participants) {
                const reconnecting = participant.self && state.role === "guest" && state.connected === false;
                const row = el("li", `collab-person collab-participant${participant.connected ? "" : " is-offline"}`);
                const avatar = el("span", "collab-avatar", initialOf(participant.name));
                avatar.style.setProperty("--collab-color", participant.color);
                avatar.dataset.noI18n = "true";
                const name = el("span", "collab-person-name", participant.name);
                name.dataset.noI18n = "true";
                if (participant.self)
                    name.append(el("span", "collab-person-self", uiText("you", "自分")));
                row.append(avatar, name);
                const stateText = reconnecting ? uiText("reconnecting", "再接続中") : !participant.connected ? uiText("disconnected", "切断") : "";
                if (stateText)
                    row.append(el("span", "collab-person-state", stateText));
                const role = participant.host
                    ? el("span", "collab-role is-host", uiText("host", "ホスト"))
                    : el("span", "collab-role", participant.viewer ? uiText("view only", "閲覧のみ") : uiText("can edit", "編集"));
                row.append(role);
                list.append(row);
            }
            people.append(list);
            content.append(people);
            if (incomingText(state))
                content.append(el("p", "tool-dialog-note collab-incoming", incomingText(state)));
            for (const line of limitedText(state)) {
                const note = el("p", "tool-dialog-note collab-limited", line);
                note.dataset.noI18n = "true";
                content.append(note);
            }
            if (state.role === "guest" && state.connected === false)
                content.append(el("p", "tool-dialog-note", uiText("Reconnecting to the host…", "ホストに再接続しています…")));
            if (state.role === "host" && state.connected === false)
                content.append(el("p", "tool-dialog-note", uiText("Reconnecting to the relay…", "中継サーバーに再接続しています…")));
            if (preservedText(state))
                content.append(el("p", "tool-dialog-note", preservedText(state)));
        }
        const actions = el("div", "tool-dialog-actions");
        if (state.active) {
            const leave = state.role === "host"
                ? button(uiText("End the session…", "セッションを終了…"), () => {
                    if (!window.confirm(uiText("End the session for everyone? Each participant keeps their copy.", "全員のセッションを終了しますか？各参加者の写しはそのまま残ります。")))
                        return;
                    void run(() => collabSession.leave());
                })
                : button(uiText("Leave", "退出"), () => void run(() => collabSession.leave()));
            if (state.role === "host")
                leave.classList.add("is-danger");
            actions.append(leave, el("span", "tool-dialog-spacer"));
        }
        const close = button(uiText("Close", "閉じる"), () => dialog === null || dialog === void 0 ? void 0 : dialog.close());
        close.dataset.role = "close";
        actions.append(close);
        dialog.replaceChildren(eyebrow, title, content, error, actions);
        window.requestAnimationFrame(() => { if (!state.active && !busy)
            return; close.focus(); });
    };
    async function run(action) {
        if (busy)
            return;
        busy = true;
        errorText = "";
        renderDialog();
        try {
            await action();
            pendingLink = "";
        }
        catch (reason) {
            // The link and the name stay in the fields for a retry.
            errorText = reason instanceof Error ? reason.message : String(reason);
        }
        finally {
            busy = false;
            renderDialog();
        }
    }
    const openDialog = async (link = "") => {
        if (!collabSession.available)
            return;
        if (link)
            pendingLink = link;
        if (!dialog) {
            dialog = el("dialog", "tool-dialog collab-dialog");
            dialog.addEventListener("close", () => {
                dialog === null || dialog === void 0 ? void 0 : dialog.remove();
                dialog = null;
            });
            document.body.append(dialog);
            try {
                const status = await collabSession.status();
                defaultName = String(status.defaultName || "");
                idleRoute = status.route === "relay" ? "relay" : "lan";
            }
            catch { }
            if (!dialog)
                return;
            renderDialog();
            dialog.showModal();
            return;
        }
        renderDialog();
    };
    collabSession.onChange((state) => {
        if (!state.active)
            linkAccess = "edit";
        renderDots(state);
        renderDialog();
    });
    collabSession.onMessage("collab:invite", (message) => {
        void openDialog(String(message.link || ""));
    });
    collabSession.onMessage("collab:notice", (message) => {
        showEditorNotice(dots, String(message.message || ""), { owner: "collab", durationMs: 8000 });
    });
    dots === null || dots === void 0 ? void 0 : dots.addEventListener("click", () => void openDialog());
    renderDots(collabSession.getState());
    return { openDialog };
};
