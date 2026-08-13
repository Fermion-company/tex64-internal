import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { sendChat } from '../lib/api';
import { GearIcon, PlusIcon, SigmaLogo } from './icons';
import type { ChatMessage } from '../types';

function AssistantHeader() {
  return (
    <div className="ai-header">
      <SigmaLogo size={22} radius={6} fontSize={12} />
      <span className="ai-name">TeX64</span>
    </div>
  );
}

function Message({ msg, onSuggest }: { msg: ChatMessage; onSuggest: (text: string) => void }) {
  switch (msg.kind) {
    case 'user':
      return (
        <div className="user-bubble">
          <div className="user-bubble-text">{msg.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="ai-msg">
          <AssistantHeader />
          <div className="ai-body" dangerouslySetInnerHTML={{ __html: msg.html }} />
          {msg.time && <div className="msg-time">{msg.time}</div>}
        </div>
      );
    case 'status':
      return (
        <div className={`status-row${msg.done ? ' done' : ''}`}>
          {!msg.done && <span className="spinner-sm" />}
          <span className="status-label">{msg.label}</span>
          <span className="status-file">{msg.file}</span>
        </div>
      );
    case 'suggestions':
      return (
        <div className="suggest-card">
          <div className="suggest-title">{msg.title}</div>
          {msg.items.map((it) => (
            <button
              key={it.title}
              type="button"
              className="suggest-row"
              onClick={() => onSuggest(it.title)}
            >
              <span className="suggest-row-title">{it.title}</span>
              <span className="suggest-row-desc">{it.desc}</span>
            </button>
          ))}
        </div>
      );
  }
}

export function ChatPanel() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const busy = state.busy;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.chat, busy]);

  const send = (text: string, forceEdit = false) => {
    const t = text.trim();
    if (!t || busy) return;
    void sendChat(dispatch, state, t, forceEdit);
    setDraft('');
    const ta = taRef.current;
    if (ta) ta.style.height = 'auto';
  };

  return (
    <aside className="chat-panel">
      <div className="chat-scroll" ref={scrollRef}>
        {state.chat.map((m) => (
          <Message key={m.id} msg={m} onSuggest={(t) => send(t, true)} />
        ))}
        {busy && (
          <div className="editing-indicator">
            <span className="spinner-ring" />
            <span>{state.mode === 'edit' ? 'コードを編集中…' : '考えています…'}</span>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-input-box">
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            placeholder="何を執筆しますか?"
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(draft);
              }
            }}
          />
        </div>
        <div className="chat-actions">
          <button className="icon-btn" title="設定" type="button">
            <GearIcon />
          </button>
          <button
            className="icon-btn"
            title="数式を追加"
            type="button"
            onClick={() => dispatch({ type: 'eqModal/open', state: { targetId: null, initialLatex: '' } })}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className={`mode-pill${state.mode === 'edit' ? ' active' : ''}`}
            onClick={() => dispatch({ type: 'mode/set', mode: 'edit' })}
          >
            編集
          </button>
          <button
            type="button"
            className={`mode-pill${state.mode === 'discuss' ? ' active' : ''}`}
            onClick={() => dispatch({ type: 'mode/set', mode: 'discuss' })}
          >
            ディスカス
          </button>
          <span className="spacer" />
          <button
            type="button"
            className={`send-btn${busy || !draft.trim() ? ' disabled' : ''}`}
            title="送信"
            onClick={() => send(draft)}
          >
            &#8594;
          </button>
        </div>
      </div>
    </aside>
  );
}
