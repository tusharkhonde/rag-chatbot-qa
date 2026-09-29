import { describe, expect, it } from 'vitest';
import { readSSE } from '../../client/src/lib/sse';

/** A stream that delivers the given chunks separately, like a network would. */
const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const m of readSSE(stream)) out.push(m);
  return out;
}

describe('readSSE', () => {
  it('parses events even when messages are split across network chunks', async () => {
    const messages = await collect(streamOf('event: sources\nda', 'ta: {"sources":[]}\n\nevent: del', 'ta\ndata: {"text":"Hi"}\n\n'));
    expect(messages).toEqual([
      { event: 'sources', data: '{"sources":[]}' },
      { event: 'delta', data: '{"text":"Hi"}' },
    ]);
  });

  it('handles several messages in one chunk, multi-line data, comments and CRLF', async () => {
    const messages = await collect(streamOf(': keep-alive\r\n\r\nevent: a\r\ndata: 1\r\n\r\ndata: line1\ndata: line2\n\n'));
    expect(messages).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: 'line1\nline2' },
    ]);
  });

  it('keeps a multi-byte character split between chunks intact', async () => {
    const bytes = new TextEncoder().encode('data: café\n\n');
    const split = bytes.indexOf(0xc3) + 1; // cut inside the two-byte "é"
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, split));
        c.enqueue(bytes.slice(split));
        c.close();
      },
    });
    expect(await collect(stream)).toEqual([{ event: 'message', data: 'café' }]);
  });
});
