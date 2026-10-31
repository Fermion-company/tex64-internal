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
    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        node.className = className;
        node.textContent = text;
        return node;
    };
    const button = (label, handler, primary = false) => {
        const node = el("button", `history-button${primary ? " is-primary" : ""}`, label);
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
    const renderDialog = () => {
        if (!dialog)
            return;
        const state = collabSession.getState();
        const content = el("div", "collab-dialog-body");
        const title = el("h2", "", uiText("Collaborate", "共同編集"));
        title.id = "collab-dialog-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const error = el("p", "history-error", errorText);
        error.setAttribute("role", "status");
        if (state.phase === "starting" || state.phase === "opening" || (busy && !state.active)) {
            content.append(el("p", "history-local", state.role === "guest"
                ? uiText("Joining the session…", "セッションに参加しています…")
                : uiText("Starting the session…", "セッションを開始しています…")));
        }
        else if (!state.active) {
            const nameRow = el("label", "collab-dialog-field");
            nameRow.append(el("span", "", uiText("Your name", "表示名")));
            const nameField = el("input", "history-name");
            nameField.setAttribute("aria-label", uiText("Your name", "表示名"));
            nameField.maxLength = 40;
            nameField.value = defaultName;
            nameField.addEventListener("input", () => { defaultName = nameField.value; });
            nameRow.append(nameField);
            const start = button(uiText("Start a session", "セッションを開始"), () => void run(() => collabSession.start(nameField.value.trim())));
            const hostNote = el("p", "history-local", uiText("Starting a session opens a port on this computer; macOS may ask to allow incoming connections. Only people on the same network (LAN / VPN) can join.", "セッションを開始するとこの Mac がポートを開きます。macOS が接続の許可を確認することがあります。参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。"));
            const linkField = el("input", "history-name");
            linkField.placeholder = uiText("Paste an invite link", "招待リンクを貼り付け");
            linkField.setAttribute("aria-label", linkField.placeholder);
            linkField.value = pendingLink;
            linkField.dataset.noI18n = "true";
            const join = button(uiText("Join with the link", "招待リンクで参加"), () => void run(() => collabSession.join(linkField.value.trim(), nameField.value.trim())));
            const syncPrimary = () => {
                const hasLink = linkField.value.trim().length > 0;
                join.classList.toggle("is-primary", hasLink);
                start.classList.toggle("is-primary", !hasLink);
                hostNote.hidden = hasLink;
            };
            linkField.addEventListener("input", () => { pendingLink = linkField.value; syncPrimary(); });
            syncPrimary();
            const rows = el("div", "collab-dialog-rows");
            rows.append(linkField, join);
            content.append(nameRow, el("div", "collab-dialog-start"), hostNote, rows);
            content.querySelector(".collab-dialog-start").append(start);
            window.requestAnimationFrame(() => (pendingLink ? linkField : nameField).focus());
        }
        else {
            if (state.inviteLink) {
                const linkRow = el("div", "collab-dialog-link");
                const link = el("input", "history-name");
                link.readOnly = true;
                link.value = state.inviteLink;
                link.dataset.noI18n = "true";
                link.setAttribute("aria-label", uiText("Invite link", "招待リンク"));
                const copy = button(uiText("Copy", "コピー"), () => {
                    var _a;
                    void ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(state.inviteLink || "").then(() => { copy.textContent = uiText("Copied", "コピーしました"); }, () => { link.select(); }));
                });
                linkRow.append(link, copy);
                content.append(linkRow, el("p", "history-local", uiText("Only people on the same network (LAN / VPN) can join.", "参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。")));
            }
            const list = el("div", "collab-dialog-participants");
            for (const participant of state.participants) {
                const row = el("div", "collab-participant");
                const dot = el("span", `collab-dot${participant.connected ? "" : " is-offline"}`);
                dot.style.setProperty("--collab-color", participant.color);
                const name = el("span", "collab-participant-name", participant.self ? `${participant.name} ${uiText("(you)", "（自分）")}` : participant.name);
                name.dataset.noI18n = "true";
                const reconnecting = participant.self && state.role === "guest" && state.connected === false;
                const status = el("span", "history-date", participant.host
                    ? uiText("host", "ホスト")
                    : reconnecting ? uiText("reconnecting", "再接続中")
                        : participant.connected ? uiText("connected", "接続中") : uiText("disconnected", "切断"));
                row.append(dot, name, status);
                list.append(row);
            }
            content.append(list);
            if (state.role === "guest" && state.rootPath) {
                const where = el("p", "history-local", `${uiText("Your copy", "写し")}: ${state.rootPath} · ${uiText("It stays after you leave.", "退出後も残ります。")}`);
                where.dataset.noI18n = "true";
                content.append(where);
            }
            if (state.role === "guest" && state.connected === false)
                content.append(el("p", "history-local", uiText("Reconnecting to the host…", "ホストに再接続しています…")));
            if (infoText)
                content.append(el("p", "history-local", infoText));
        }
        const actions = el("div", "history-confirm-actions");
        const close = button(uiText("Close", "閉じる"), () => dialog === null || dialog === void 0 ? void 0 : dialog.close());
        close.autofocus = true;
        actions.append(close);
        if (state.active) {
            const leave = state.role === "host"
                ? button(uiText("End the session…", "セッションを終了…"), () => {
                    if (!window.confirm(uiText("End the session for everyone? Each participant keeps their copy.", "全員のセッションを終了しますか？各参加者の写しはそのまま残ります。")))
                        return;
                    void run(() => collabSession.leave());
                })
                : button(uiText("Leave", "退出"), () => void run(() => collabSession.leave()));
            actions.append(leave);
        }
        dialog.replaceChildren(title, content, error, actions);
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
            dialog = el("dialog", "history-confirm collab-dialog");
            dialog.addEventListener("close", () => {
                dialog === null || dialog === void 0 ? void 0 : dialog.remove();
                dialog = null;
            });
            document.body.append(dialog);
            try {
                const status = await collabSession.status();
                defaultName = String(status.defaultName || "");
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
