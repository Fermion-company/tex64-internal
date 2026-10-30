// The one dialog (File › Collaborate…) and the participant dots that appear
// left of Build only while a session runs.

import { uiText } from "../i18n.js";
import { collabSession, type CollabState } from "./session.js";

const MAX_DOTS = 5;

export const initCollabUi = () => {
  const dots = document.getElementById("collab-participants") as HTMLButtonElement | null;
  let dialog: HTMLDialogElement | null = null;
  let pendingLink = "";
  let busy = false;
  let errorText = "";
  let defaultName = "";

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const button = (label: string, handler: () => void, primary = false) => {
    const node = el("button", `history-button${primary ? " is-primary" : ""}`, label);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  };

  const renderDots = (state: CollabState) => {
    if (!dots) return;
    if (!state.active) {
      dots.hidden = true;
      dots.replaceChildren();
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
  };

  const renderDialog = () => {
    if (!dialog) return;
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
    } else if (!state.active) {
      const nameField = el("input", "history-name") as HTMLInputElement;
      nameField.placeholder = uiText("Display name", "表示名");
      nameField.setAttribute("aria-label", nameField.placeholder);
      nameField.maxLength = 40;
      nameField.value = defaultName;
      const start = button(uiText("Start a session", "セッションを開始"), () => void run(() => collabSession.start(nameField.value.trim())), true);
      const linkField = el("input", "history-name") as HTMLInputElement;
      linkField.placeholder = uiText("Paste an invite link", "招待リンクを貼り付け");
      linkField.setAttribute("aria-label", linkField.placeholder);
      linkField.value = pendingLink;
      linkField.dataset.noI18n = "true";
      const join = button(uiText("Join with the link", "招待リンクで参加"), () => void run(() => collabSession.join(linkField.value.trim(), nameField.value.trim())));
      const rows = el("div", "collab-dialog-rows");
      rows.append(nameField, start, linkField, join);
      content.append(rows, el("p", "history-local", uiText(
        "Starting a session opens a port on this computer; macOS may ask to allow incoming connections.",
        "セッションを開始するとこの Mac がポートを開きます。macOS が接続の許可を確認することがあります。",
      )));
      window.requestAnimationFrame(() => (pendingLink ? linkField : nameField).focus());
    } else {
      if (state.inviteLink) {
        const linkRow = el("div", "collab-dialog-link");
        const link = el("input", "history-name") as HTMLInputElement;
        link.readOnly = true;
        link.value = state.inviteLink;
        link.dataset.noI18n = "true";
        link.setAttribute("aria-label", uiText("Invite link", "招待リンク"));
        const copy = button(uiText("Copy", "コピー"), () => {
          void navigator.clipboard?.writeText(state.inviteLink || "").then(
            () => { copy.textContent = uiText("Copied", "コピーしました"); },
            () => { link.select(); },
          );
        });
        linkRow.append(link, copy);
        content.append(linkRow);
      }
      const list = el("div", "collab-dialog-participants");
      for (const participant of state.participants) {
        const row = el("div", "collab-participant");
        const dot = el("span", `collab-dot${participant.connected ? "" : " is-offline"}`);
        dot.style.setProperty("--collab-color", participant.color);
        const name = el("span", "collab-participant-name", participant.name);
        name.dataset.noI18n = "true";
        const status = el("span", "history-date", participant.host
          ? uiText("host", "ホスト")
          : participant.connected ? uiText("connected", "接続中") : uiText("disconnected", "切断"));
        row.append(dot, name, status);
        list.append(row);
      }
      content.append(list);
      if (state.role === "guest" && state.connected === false) content.append(el("p", "history-local", uiText("Reconnecting to the host…", "ホストに再接続しています…")));
      content.append(button(state.role === "host" ? uiText("End the session", "セッションを終了") : uiText("Leave", "退出"), () => void run(() => collabSession.leave())));
    }
    const close = button(uiText("Close", "閉じる"), () => dialog?.close());
    dialog.replaceChildren(title, content, error, close);
  };

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    errorText = "";
    renderDialog();
    try {
      await action();
      pendingLink = "";
    } catch (reason) {
      errorText = reason instanceof Error ? reason.message : String(reason);
    } finally {
      busy = false;
      renderDialog();
    }
  }

  const openDialog = async (link = "") => {
    if (!collabSession.available) return;
    if (link) pendingLink = link;
    if (!dialog) {
      dialog = el("dialog", "history-confirm collab-dialog");
      dialog.addEventListener("close", () => {
        dialog?.remove();
        dialog = null;
      });
      document.body.append(dialog);
      try {
        const status = await collabSession.status();
        defaultName = String(status.defaultName || "");
      } catch {}
      if (!dialog) return;
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
  dots?.addEventListener("click", () => void openDialog());
  renderDots(collabSession.getState());

  return { openDialog };
};
