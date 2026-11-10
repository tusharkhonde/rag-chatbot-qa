import { describe, expect, it } from 'vitest';
import { chatHistory, type Turn } from '../../client/src/lib/history';

const q = (text: string): Turn => ({ role: 'user', text });
const a = (text: string, status = 'done'): Turn => ({ role: 'assistant', text, status });

describe('chatHistory', () => {
  it('turns completed question/answer pairs into history messages', () => {
    expect(chatHistory([q('What is Nimbus?'), a('A message broker [1].')])).toEqual([
      { role: 'user', content: 'What is Nimbus?' },
      { role: 'assistant', content: 'A message broker [1].' },
    ]);
  });

  it('drops turns whose answer failed or was stopped, with their question', () => {
    const history = chatHistory([q('one'), a('Request failed', 'error'), q('two'), a('partial', 'stopped'), q('three'), a('ok')]);
    expect(history.map((m) => m.content)).toEqual(['three', 'ok']);
  });

  it('keeps only the most recent messages', () => {
    const turns = Array.from({ length: 5 }, (_, i) => [q(`q${i}`), a(`a${i}`)]).flat();
    expect(chatHistory(turns, 4).map((m) => m.content)).toEqual(['q3', 'a3', 'q4', 'a4']);
  });

  it('ignores the in-flight turn', () => {
    expect(chatHistory([q('done'), a('yes'), q('pending'), a('', 'searching')])).toHaveLength(2);
  });
});
