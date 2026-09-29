export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Parse a Server-Sent Events stream from fetch(). EventSource would do this for us, but it only
 * supports GET (no request body, no custom headers), and our chat is a POST with a CSRF header.
 *
 * Network chunks don't align with SSE messages: one read can hold half a message or three.
 * So we buffer and only emit complete messages, which are separated by a blank line.
 */
export async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader();
  // stream: true keeps a multi-byte UTF-8 character that's split across two chunks intact.
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const message = parseMessage(raw);
      if (message) yield message;
    }
    if (done) break;
  }
  const last = parseMessage(buffer);
  if (last) yield last;
}

function parseMessage(raw: string): SSEMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // blank or comment (keep-alive)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value); // multi-line data is joined with \n
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
