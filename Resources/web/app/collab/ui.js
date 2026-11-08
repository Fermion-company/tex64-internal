// The one dialog (File › Collaborate…) and the participant dots that appear
// left of Build only while a session runs.
import { uiText } from "../i18n.js";
import { showEditorNotice } from "../editor-notice.js";
import { createExplain, explainedHeading } from "../explain.js";
import { markFocus, restoreFocus } from "../focus-key.js";
import { collabSession } from "./session.js";
const MAX_DOTS = 5;
export const initCollabUi = () => {
    const dots = document.getElementById("collab-participants");
    let dialog = null;
    // Which ▾ are open while the dialog stays open; updates rebuild the dialog.
    const explainOpen = new Set();
    let pendingLink = "";
    let busy = false;
    let errorText = "";
    let defaultName = "";
    // The route a new session takes, from the last status call.
    let idleRoute = "lan";
    // Which invite link the host copies: the edit link or the view link.
    let linkAccess = "edit";
    // The start view's "Join with link ▾": open while the dialog is, or when it
    // opened on an invite link.
    let joinOpen = false;
    // The link just copied reads "Copied" on its button for a moment.
    let copied = null;
    let copiedTimer = null;
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
        return uiText(`Receiving files: ${incoming.files} left (${megabytes(incoming.bytes)})`, `ファイルを受け取り中（残り ${incoming.files} 件・${megabytes(incoming.bytes)}）`);
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
            lines.push(uiText(`Shared smaller: ${files}`, `縮小して共有: ${files}`));
        }
        if (limited === null || limited === void 0 ? void 0 : limited.skipped.length) {
            const files = list(limited.skipped, (item) => `${item.path}（${megabytes(item.size)}）`);
            lines.push(uiText(`Too large, not shared: ${files}`, `容量超過で未共有: ${files}`));
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
        return uiText(`Later edits kept as: ${list}`, `退出後の編集を退避しました: ${list}`);
    };
    const field = (className, label) => {
        const input = el("input", `tool-input ${className}`);
        input.setAttribute("aria-label", label);
        return input;
    };
    const initialOf = (name) => (Array.from(name.trim())[0] || "?").toUpperCase();
    // The clipboard API, else a copy from a field that is never shown.
    const copyText = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        }
        catch {
            const scratch = el("textarea", "collab-copy-scratch");
            scratch.value = text;
            scratch.setAttribute("aria-hidden", "true");
            dialog === null || dialog === void 0 ? void 0 : dialog.append(scratch);
            scratch.select();
            const copied = document.execCommand("copy");
            scratch.remove();
            return copied;
        }
    };
    // `resetFocus`: the dialog is opening, or an action (start, join, leave)
    // has just finished, so focus starts over.
    const renderDialog = (resetFocus = false) => {
        if (!dialog)
            return;
        const state = collabSession.getState();
        const title = el("h2", "tool-dialog-title", uiText("Collaborate", "共同編集"));
        if (state.active && state.name) {
            const project = el("span", "tool-dialog-title-detail", ` · ${state.name}`);
            project.dataset.noI18n = "true";
            title.append(project);
        }
        title.id = "collab-dialog-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const content = el("div", "collab-dialog-body");
        let firstFocus = null;
        const error = el("p", "tool-dialog-error", errorText);
        error.setAttribute("role", "status");
        if (state.phase === "starting" || state.phase === "opening" || (busy && !state.active)) {
            content.append(el("p", "tool-dialog-note", state.role === "guest"
                ? uiText("Joining…", "参加中…")
                : uiText("Starting…", "開始中…")));
        }
        else if (!state.active) {
            const nameRow = el("label", "collab-field");
            nameRow.append(el("span", "tool-dialog-label", uiText("Your name", "表示名")));
            const nameField = field("collab-name-input", uiText("Your name", "表示名"));
            nameField.maxLength = 40;
            nameField.dataset.focusKey = "name";
            nameField.value = defaultName;
            nameField.addEventListener("input", () => { defaultName = nameField.value; });
            nameRow.append(nameField);
            const start = button(uiText("Start", "開始"), () => void run(() => collabSession.start(nameField.value.trim())));
            start.dataset.focusKey = "start-session";
            const startExplain = createExplain(idleRoute === "relay"
                ? uiText("People can join over the internet. Everything is encrypted between the computers; the relay in between cannot read it.", "インターネット越しに参加できます。内容は参加者の間で暗号化され、間の中継サーバーには読めません。")
                : uiText("Starting a session opens a port on this computer; macOS may ask to allow incoming connections. Only people on the same network (LAN / VPN) can join.", "セッションを開始するとこのMacがポートを開きます。macOSが接続の許可を確認することがあります。参加できるのは同じネットワーク（LAN / VPN）にいる人だけです。"), { topic: uiText("starting a session", "セッションの開始"), memory: explainOpen, key: "start" });
            const startRow = el("div", "collab-start-row has-explain");
            startRow.append(start, startExplain.button);
            const joinSection = el("div", "collab-section collab-join");
            // Joining waits behind ▾ so that Start is the one obvious action.
            const joinToggle = el("button", "collab-disclosure", uiText("Join with link", "リンクで参加"));
            joinToggle.type = "button";
            joinToggle.dataset.focusKey = "join-toggle";
            joinToggle.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');
            const joinBody = el("div", "collab-join-body");
            joinBody.id = "collab-join-body";
            joinToggle.setAttribute("aria-controls", joinBody.id);
            const linkField = field("collab-join-input", uiText("Invite link", "招待リンク"));
            linkField.placeholder = uiText("Invite link", "招待リンク");
            linkField.value = pendingLink;
            linkField.dataset.noI18n = "true";
            linkField.dataset.focusKey = "join-link";
            const join = button(uiText("Join", "参加"), () => void run(() => collabSession.join(linkField.value.trim(), nameField.value.trim())));
            join.dataset.focusKey = "join";
            const row = el("div", "collab-link-row");
            row.append(linkField, join);
            joinBody.append(row);
            joinSection.append(joinToggle, joinBody);
            const startSection = el("div", "collab-section collab-start");
            startSection.append(startRow, startExplain.panel);
            // A pasted link makes Join the action and puts Start away; closing the ▾
            // brings Start back.
            const syncPrimary = () => {
                const hasLink = joinOpen && linkField.value.trim().length > 0;
                join.classList.toggle("is-primary", hasLink);
                start.classList.toggle("is-primary", !hasLink);
                startSection.hidden = hasLink;
            };
            const syncJoin = () => {
                joinToggle.setAttribute("aria-expanded", String(joinOpen));
                joinBody.hidden = !joinOpen;
                syncPrimary();
            };
            joinToggle.addEventListener("click", () => {
                joinOpen = !joinOpen;
                syncJoin();
                if (joinOpen)
                    linkField.focus();
            });
            if (pendingLink)
                joinOpen = true;
            linkField.addEventListener("input", () => { pendingLink = linkField.value; syncPrimary(); });
            syncJoin();
            content.append(nameRow, startSection, joinSection);
            firstFocus = pendingLink ? linkField : nameField;
        }
        else {
            if (state.inviteLink) {
                const invite = el("div", "collab-section");
                const inviteHeading = el("p", "tool-dialog-label", uiText("Invite link", "招待リンク"));
                if (state.route === "relay")
                    invite.append(inviteHeading);
                else
                    invite.append(...explainedHeading(inviteHeading, uiText("Only people on the same LAN / VPN can join.", "同じLAN / VPNの人だけが参加できます。"), { memory: explainOpen, key: "invite" }));
                const row = el("div", "collab-link-row collab-dialog-link");
                // The link itself is not shown (it carries the address and a token);
                // Copy puts the chosen one on the clipboard and says so for a moment.
                const linkFor = () => (linkAccess === "view" && state.viewInviteLink ? state.viewInviteLink : state.inviteLink || "");
                const copyLabel = () => (copied === linkAccess ? uiText("Link copied", "コピーしました") : uiText("Copy", "コピー"));
                const copy = button(copyLabel(), () => {
                    const access = linkAccess;
                    void copyText(linkFor()).then((done) => {
                        if (!done) {
                            errorText = uiText("Could not copy the link.", "リンクをコピーできませんでした。");
                            renderDialog();
                            return;
                        }
                        copied = access;
                        copy.textContent = copyLabel();
                        if (copiedTimer !== null)
                            window.clearTimeout(copiedTimer);
                        copiedTimer = window.setTimeout(() => {
                            copiedTimer = null;
                            copied = null;
                            const current = dialog === null || dialog === void 0 ? void 0 : dialog.querySelector('[data-focus-key="copy"]');
                            if (current)
                                current.textContent = uiText("Copy", "コピー");
                        }, 1600);
                    });
                }, true);
                copy.dataset.focusKey = "copy";
                if (state.viewInviteLink) {
                    const access = el("div", "tool-segmented collab-access");
                    access.setAttribute("role", "group");
                    access.setAttribute("aria-label", uiText("What the link allows", "リンクでできること"));
                    const choices = [["edit", uiText("Edit link", "編集リンク")], ["view", uiText("View link", "閲覧リンク")]];
                    for (const [value, label] of choices) {
                        const option = el("button", "", label);
                        option.type = "button";
                        option.dataset.access = value;
                        option.dataset.focusKey = `access-${value}`;
                        option.setAttribute("aria-pressed", String(linkAccess === value));
                        option.addEventListener("click", () => {
                            linkAccess = value;
                            for (const other of access.querySelectorAll("button"))
                                other.setAttribute("aria-pressed", String(other === option));
                            copy.textContent = copyLabel();
                        });
                        access.append(option);
                    }
                    row.append(access);
                }
                row.append(el("span", "tool-dialog-spacer"), copy);
                invite.append(row);
                content.append(invite);
            }
            const people = el("div", "collab-section");
            const peopleHeading = el("p", "tool-dialog-label", `${uiText("Participants", "参加者")} · ${state.participants.length}`);
            // A view-only guest's ▾: what viewing allows.
            if (state.role === "guest" && state.access === "view") {
                people.append(...explainedHeading(peopleHeading, uiText("You can read, follow and build, but not edit.", "読む・追う・ビルドはできますが、編集はできません。"), { memory: explainOpen, key: "people" }));
            }
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
                content.append(el("p", "tool-dialog-note", uiText("Reconnecting to the host…", "ホストに再接続中…")));
            if (state.role === "host" && state.connected === false)
                content.append(el("p", "tool-dialog-note", uiText("Reconnecting to the relay…", "中継サーバーに再接続中…")));
            if (preservedText(state))
                content.append(el("p", "tool-dialog-note", preservedText(state)));
        }
        const actions = el("div", "tool-dialog-actions");
        if (state.active) {
            const leave = state.role === "host"
                ? button(uiText("End session…", "終了…"), () => {
                    if (!window.confirm(uiText("End the session for everyone?", "全員のセッションを終了しますか？")))
                        return;
                    void run(() => collabSession.leave());
                })
                : button(uiText("Leave", "退出"), () => void run(() => collabSession.leave()));
            if (state.role === "host")
                leave.classList.add("is-danger");
            leave.dataset.focusKey = "leave";
            actions.append(leave, el("span", "tool-dialog-spacer"));
        }
        const close = button(uiText("Close", "閉じる"), () => dialog === null || dialog === void 0 ? void 0 : dialog.close());
        close.dataset.role = "close";
        close.dataset.focusKey = "close";
        actions.append(close);
        // A rebuild (a participant joining, a transfer's progress) gives focus
        // back to the control the user was on. When that control is gone, or
        // focus starts over, it goes to the field to fill in, else Close.
        const focusMark = markFocus(dialog);
        dialog.replaceChildren(title, content, error, actions);
        window.requestAnimationFrame(() => {
            if (!dialog)
                return;
            if (!resetFocus) {
                if (restoreFocus(dialog, focusMark))
                    return;
                const active = document.activeElement;
                if (active && active !== dialog && dialog.contains(active))
                    return;
            }
            (firstFocus !== null && firstFocus !== void 0 ? firstFocus : close).focus();
        });
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
            renderDialog(true);
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
                explainOpen.clear();
                joinOpen = false;
                copied = null;
                if (copiedTimer !== null)
                    window.clearTimeout(copiedTimer);
                copiedTimer = null;
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
            renderDialog(true);
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
