import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../lib/api';
import { renderAnswer } from '../lib/renderAnswer';
import { readSSE } from '../lib/sse';
import type { AnswerResult, Citation, Collection } from '../lib/types';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  status?: 'searching' | 'generating' | 'done' | 'error' | 'stopped';
  sourceCount?: number;
  result?: AnswerResult;
}

const EXAMPLES = [
  'How do I roll back a bad deploy?',
  'How long does the message broker keep messages?',
  'What happens when two passes in a row fail?',
];

let nextId = 1;

export function Chat() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = messages.some((m) => m.status === 'searching' || m.status === 'generating');

  useEffect(() => {
    api.collections()
      .then((c) => {
        setCollections(c);
        if (c[0]) setCollectionId(c[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Block body on purpose: an effect may only return a cleanup function. Modern browsers make
  // scrollIntoView return a Promise, and an expression-bodied arrow would hand React that Promise
  // as the "cleanup", which crashes the tree on the next render.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const update = (id: number, patch: Partial<Message> | ((m: Message) => Partial<Message>)) =>
    setMessages((all) => all.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)));

  async function ask(question: string) {
    if (!question.trim() || !collectionId || busy) return;
    const answerId = nextId + 1;
    setMessages((all) => [...all, { id: nextId, role: 'user', text: question }, { id: answerId, role: 'assistant', text: '', status: 'searching' }]);
    nextId += 2;
    setInput('');

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await api.chat(collectionId, question, abort.signal);
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
      }
      // Events arrive as: sources → delta … delta → done (or error).
      for await (const { event, data } of readSSE(res.body)) {
        const payload = JSON.parse(data);
        if (event === 'sources') update(answerId, { status: 'generating', sourceCount: payload.sources.length });
        else if (event === 'delta') update(answerId, (m) => ({ text: m.text + payload.text }));
        else if (event === 'done') update(answerId, { status: 'done', text: payload.answer, result: payload as AnswerResult });
        else if (event === 'error') throw new Error(payload.error);
      }
    } catch (err) {
      if (abort.signal.aborted) update(answerId, { status: 'stopped' });
      else update(answerId, { status: 'error', text: (err as Error).message });
    } finally {
      abortRef.current = null;
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(input);
    }
  };

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <label>
          Collection
          <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} disabled={busy}>
            {collections.length === 0 && <option value="">No collections yet</option>}
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {messages.length > 0 && (
          <button className="link" onClick={() => setMessages([])} disabled={busy}>
            New chat
          </button>
        )}
      </div>

      <div className="messages">
        {error && <div className="error">{error}</div>}
        {messages.length === 0 && (
          <div className="empty">
            <h2>Ask about your documents</h2>
            <p className="muted">Answers come only from the documents in the selected collection, with sources you can check.</p>
            <div className="examples">
              {EXAMPLES.map((q) => (
                <button key={q} className="example" onClick={() => void ask(q)} disabled={!collectionId}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (m.role === 'user' ? <div key={m.id} className="bubble user">{m.text}</div> : <AssistantMessage key={m.id} message={m} />))}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={collectionId ? 'Ask a question… (Enter to send, Shift+Enter for a new line)' : 'An admin needs to create a collection first'}
          rows={2}
          maxLength={1000}
          disabled={!collectionId}
        />
        {busy ? (
          <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!input.trim() || !collectionId}>
            Send
          </button>
        )}
      </form>
      <p className="hint">Each question is answered on its own from the documents; earlier messages aren't used as context.</p>
    </div>
  );
}

function AssistantMessage({ message: m }: { message: Message }) {
  const [open, setOpen] = useState<number | null>(null);
  const citations = m.result?.citations ?? [];
  const cite = (n: number) => setOpen((cur) => (cur === n ? null : n));

  return (
    <div className={`bubble assistant ${m.result?.refused ? 'refused' : ''} ${m.status === 'error' ? 'failed' : ''}`}>
      {m.status === 'searching' && <div className="status">Searching the documents…</div>}
      {m.status === 'generating' && !m.text && (
        <div className="status">
          Found {m.sourceCount} relevant sources. Writing the answer (the local model can take up to a minute)…
        </div>
      )}
      {m.text && <div className="answer">{renderAnswer(m.text, cite)}</div>}
      {m.status === 'generating' && m.text && <span className="cursor" />}
      {m.status === 'stopped' && <div className="status">Stopped.</div>}

      {citations.length > 0 && (
        <div className="sources">
          {citations.map((c: Citation) => (
            <div key={c.index} className={`source ${open === c.index ? 'open' : ''}`}>
              <button className="source-label" onClick={() => cite(c.index)}>
                <span className="cite static">{c.index}</span> {c.label}
              </button>
              {open === c.index && <blockquote>{c.snippet}…</blockquote>}
            </div>
          ))}
        </div>
      )}
      {m.result && (
        <div className="meta">
          {m.result.cached ? 'from cache' : `answered in ${((m.result.timings.total ?? 0) / 1000).toFixed(1)} s`}
          {m.result.refused && ' · not found in the documents'}
        </div>
      )}
    </div>
  );
}
