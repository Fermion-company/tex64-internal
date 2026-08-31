"use client";

import { Check, ChevronDown, LockKeyhole, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  NativeAgentModel,
  NativePlatformState,
} from "@/lib/client/use-native-platform";

const TOKEN_FORMAT = new Intl.NumberFormat("ja-JP");

export function nativeModelAction(
  model: NativeAgentModel,
  isPro: boolean,
): "select" | "plans" {
  return model === "Axiom1.0-pro" && !isPro ? "plans" : "select";
}

export function NativePlatformControls({
  platform,
}: {
  platform: NativePlatformState;
}) {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const settingsPickerRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const requestedMenuFocusRef = useRef<"selected" | "first" | "last">(
    "selected",
  );

  const focusModelOption = (target: "selected" | "first" | "last") => {
    const options = Array.from(
      modelMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? [],
    );
    if (target === "first") {
      options[0]?.focus();
      return;
    }
    if (target === "last") {
      options.at(-1)?.focus();
      return;
    }
    (
      options.find((option) => option.ariaSelected === "true") ?? options[0]
    )?.focus();
  };

  useEffect(() => {
    if (!modelMenuOpen && !settingsMenuOpen) return;
    const focusFrame = modelMenuOpen
      ? window.requestAnimationFrame(() => {
          focusModelOption(requestedMenuFocusRef.current);
        })
      : null;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !modelPickerRef.current?.contains(target) &&
        !settingsPickerRef.current?.contains(target)
      ) {
        setModelMenuOpen(false);
        setSettingsMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const settingsWasOpen = settingsMenuOpen;
        setModelMenuOpen(false);
        setSettingsMenuOpen(false);
        (settingsWasOpen
          ? settingsTriggerRef.current
          : modelTriggerRef.current
        )?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelMenuOpen, settingsMenuOpen]);

  const openModelMenu = (focus: "selected" | "first" | "last") => {
    requestedMenuFocusRef.current = focus;
    setSettingsMenuOpen(false);
    setModelMenuOpen(true);
  };

  const moveModelFocus = (direction: 1 | -1) => {
    const options = Array.from(
      modelMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? [],
    );
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current < 0 ? 0 : (current + direction + options.length) % options.length;
    options[next]?.focus();
  };

  const chooseModel = (model: NativeAgentModel) => {
    setModelMenuOpen(false);
    if (nativeModelAction(model, platform.isPro) === "plans") {
      platform.openPlans("pro");
      return;
    }
    if (model !== platform.model) platform.setModel(model);
  };

  return (
    <div className="native-platform-controls">
      <div className="native-model-picker" ref={modelPickerRef}>
        <button
          ref={modelTriggerRef}
          type="button"
          className="native-model-trigger"
          disabled={!platform.modelReady}
          aria-label="AIモデル"
          aria-haspopup="listbox"
          aria-expanded={modelMenuOpen}
          onClick={() => {
            if (modelMenuOpen) {
              setModelMenuOpen(false);
            } else {
              openModelMenu("selected");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              openModelMenu(event.key === "ArrowDown" ? "first" : "last");
            }
          }}
        >
          <span>{platform.model}</span>
          <ChevronDown aria-hidden="true" size={15} />
        </button>
        {modelMenuOpen ? (
          <div
            ref={modelMenuRef}
            className="native-model-menu"
            role="listbox"
            aria-label="AIモデル"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveModelFocus(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                focusModelOption(event.key === "Home" ? "first" : "last");
              }
            }}
          >
            <button
              type="button"
              role="option"
              aria-selected={platform.model === "Axiom1.0"}
              onClick={() => chooseModel("Axiom1.0")}
            >
              <span className="native-model-option-name">Axiom1.0</span>
              {platform.model === "Axiom1.0" ? (
                <Check aria-hidden="true" size={15} />
              ) : null}
            </button>
            <button
              type="button"
              role="option"
              aria-selected={platform.model === "Axiom1.0-pro"}
              aria-label={
                platform.isPro
                  ? "Axiom1.0-pro"
                  : "Axiom1.0-pro、Pro限定、プランを見る"
              }
              onClick={() => chooseModel("Axiom1.0-pro")}
            >
              <span className="native-model-option-name">Axiom1.0-pro</span>
              {platform.isPro && platform.model === "Axiom1.0-pro" ? (
                <Check aria-hidden="true" size={15} />
              ) : !platform.isPro ? (
                <span className="native-model-pro-label">
                  <LockKeyhole aria-hidden="true" size={12} />
                  Pro限定
                </span>
              ) : null}
            </button>
          </div>
        ) : null}
      </div>

      {platform.usage ? (
        <button
          type="button"
          className="native-usage-button"
          title={`${TOKEN_FORMAT.format(platform.usage.usedTokens)} / ${TOKEN_FORMAT.format(platform.usage.limitTokens)} tokens`}
          onClick={() => platform.openPlans()}
        >
          残り {TOKEN_FORMAT.format(platform.usage.remainingTokens)} tokens
        </button>
      ) : null}

      {!platform.authenticated ? (
        <button
          type="button"
          className="native-account-button is-primary"
          disabled={platform.authPending}
          onClick={platform.signIn}
        >
          {platform.authPending ? "ログイン中…" : "ログイン"}
        </button>
      ) : null}

      {platform.authenticated ? (
        <div className="native-settings-picker" ref={settingsPickerRef}>
          <button
            ref={settingsTriggerRef}
            type="button"
            className="native-settings-trigger"
            aria-label="設定"
            aria-haspopup="menu"
            aria-expanded={settingsMenuOpen}
            title={platform.email ? `設定・${platform.email}` : "設定"}
            onClick={() => {
              setModelMenuOpen(false);
              setSettingsMenuOpen((open) => !open);
            }}
          >
            <Settings2 aria-hidden="true" size={15} />
          </button>
          {settingsMenuOpen ? (
            <div className="native-settings-menu" role="menu" aria-label="設定">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSettingsMenuOpen(false);
                  platform.openPlans();
                }}
              >
                プランを管理
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSettingsMenuOpen(false);
                  platform.signOut();
                }}
              >
                ログアウト
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
