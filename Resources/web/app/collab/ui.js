// The one dialog (File › Collaborate…) and the participant dots that appear
// left of Build only while a session runs.
import { uiText } from "../i18n.js";
import { showEditorNotice } from "../editor-notice.js";
import { collabSession } from "./session.js";
const MAX_DOTS = 5;
export const initCollabUi = () => {
    const dots = document.getElementById("collab-participants");
    let dialog = null;
    let pendingLink = "";
    let busy = false;
    let errorText = "";
    let defaultName = "";
    let infoText = "";
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
        dots.title = state.connected === false
            ? uiText("Reconnecting…", "再接続中…")
            : participants.map((participant) => participant.name).join(", ");
        dots.setAttribute("aria-label", uiText("Collaboration session", "共同編集のセッション"));
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
            const hostNote = el("p", "tool-dialog-note", idleRoute === "relay"
                ? uiText("People can join over the internet. Everything is encrypted between the computers; the relay in between cannot read it.", "インターネット越しに参加できます。内容は参加者の間で暗号化され、間の中継サーバーには読めません。")
                : uiText("Starting a session opens a port on this computer; macOS may ask to allow incoming connections. Only people on the same network (LAN / VPN) can join.", "セッションを開始するとこの Mac がポートを開きます。macOS が接続の許可を確認することがあります。参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。"));
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
            startSection.append(start, hostNote);
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
                invite.append(el("p", "tool-dialog-label", uiText("Invite link", "招待リンク")));
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
                invite.append(row, el("p", "tool-dialog-note", state.route === "relay"
                    ? uiText("Anyone with the link can join from anywhere.", "リンクを知っている人は、どこからでも参加できます。")
                    : uiText("Only people on the same network (LAN / VPN) can join.", "参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。")));
                content.append(invite);
            }
            const people = el("div", "collab-section");
            people.append(el("p", "tool-dialog-label", `${uiText("Participants", "参加者")} · ${state.participants.length}`));
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
            if (state.role === "guest" && state.access === "view")
                content.append(el("p", "tool-dialog-note", uiText("You joined to view: you can read, follow and build, but not edit.", "閲覧のみで参加しています。読む・追う・ビルドはできますが、編集はできません。")));
            if (state.role === "guest" && state.rootPath) {
                const where = el("p", "tool-dialog-note", "");
                where.append(`${uiText("Your copy", "写し")}: `);
                where.append(el("code", "", state.rootPath));
                where.append(` · ${uiText("It stays after you leave.", "退出後も残ります。")}`);
                where.dataset.noI18n = "true";
                content.append(where);
            }
            if (state.role === "guest" && state.connected === false)
                content.append(el("p", "tool-dialog-note", uiText("Reconnecting to the host…", "ホストに再接続しています…")));
            if (state.role === "host" && state.connected === false)
                content.append(el("p", "tool-dialog-note", uiText("Reconnecting to the relay…", "中継サーバーに再接続しています…")));
            if (infoText)
                content.append(el("p", "tool-dialog-note", infoText));
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
            const state = collabSession.getState();
            const preserved = Number(state.preserved || 0);
            const names = (state.preservedFiles || []).slice(0, 3);
            const rest = preserved - names.length;
            const list = names.join(", ") + (rest > 0 ? uiText(` and ${rest} more`, ` ほか ${rest} 件`) : "");
            infoText = preserved > 0
                ? uiText(`Edited after you left, kept as: ${list}`, `退出後に編集した分を退避しました: ${list}`)
                : "";
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
