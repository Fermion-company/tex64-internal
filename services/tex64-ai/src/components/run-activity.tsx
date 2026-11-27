"use client";

import { useEffect, useState } from "react";
import { getNativeHost, hostMessageBody } from "@/lib/client/native-host";
import { DEFAULT_TOOL_ACTIVITY_LABEL, TOOL_ACTIVITY_LABELS } from "@/lib/client/types";
import styles from "./run-activity.module.css";

type Operation = { name: string; target: string; at: number };
function duration(seconds: number) {
  return seconds < 60 ? seconds + "秒" : Math.floor(seconds / 60) + "分" + (seconds % 60) + "秒";
}

export function RunActivity({ conversationId, stopping, writing, activity }: {
  conversationId: string; stopping: boolean; writing: boolean; activity: string | null;
}) {
  const [started] = useState(Date.now);
  const [seconds, setSeconds] = useState(0);
  const [events, setEvents] = useState<Operation[]>([]);
  useEffect(() => {
    const clock = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    const unsubscribe = getNativeHost()?.onMessage(message => {
      if (message.type !== "agent:tool") return;
      const data = hostMessageBody(message);
      if (data.conversationId !== conversationId || data.summary !== "running" || typeof data.name !== "string") return;
      const event = { name: data.name, target: typeof data.detail === "string" ? data.detail : "", at: Math.max(0, Math.floor((Date.now() - started) / 1000)) };
      setEvents(history => [...history.slice(-29), event]);
    });
    return () => { window.clearInterval(clock); unsubscribe?.(); };
  }, [conversationId, started]);

  const label = stopping ? "停止しています" : activity ? TOOL_ACTIVITY_LABELS[activity] ?? DEFAULT_TOOL_ACTIVITY_LABEL :
    writing ? "回答を書いています" : "応答を待っています";
  const elapsed = <span className={styles.time}>{duration(seconds)}</span>;
  const status = <span role="status">{label}</span>;
  if (!events.length) return <div className={styles.line}>{status}{elapsed}</div>;
  return <details className={styles.activity}>
    <summary aria-label="作業状況"><span>{status}</span>{elapsed}</summary>
    <ol aria-label="この依頼の作業履歴">
      {events.map((event, index) => <li key={index}><span className={styles.time}>{duration(event.at)}</span>
        <span>{TOOL_ACTIVITY_LABELS[event.name] ?? DEFAULT_TOOL_ACTIVITY_LABEL}{event.target && <small>{event.target}</small>}</span>
      </li>)}
    </ol>
  </details>;
}
