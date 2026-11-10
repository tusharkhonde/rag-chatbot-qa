export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  status?: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** How many earlier messages go to the server (it keeps fewer if configured to). */
export const MAX_HISTORY_MESSAGES = 6;

/**
 * The context sent with a follow-up: completed question/answer pairs only. A turn whose answer
 * failed or was stopped is dropped together with its question, so the server never sees a
 * question without the answer the user actually got.
 */
export function chatHistory(messages: Turn[], max = MAX_HISTORY_MESSAGES): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const [question, answer] = [messages[i]!, messages[i + 1]!];
    if (question.role !== 'user' || answer.role !== 'assistant' || answer.status !== 'done' || !answer.text.trim()) continue;
    history.push({ role: 'user', content: question.text }, { role: 'assistant', content: answer.text.slice(0, 4000) });
  }
  return history.slice(-max);
}
