export interface IngestResult {
  document_id: string;
  created: boolean;
  /** New uploads are `processing` until the ml worker finishes them (poll the document). */
  status: 'processing' | 'ready' | 'failed';
  chunk_count: number;
}

export interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export type EmbedKind = 'query' | 'document';

/** Error from the ml service that should be passed through to the API caller as-is (4xx). */
export class MlClientError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MlClient {
  ingest(clientId: string, collectionId: string, file: UploadedFile): Promise<IngestResult>;
  embed(texts: string[], kind: EmbedKind): Promise<{ model: string; embeddings: number[][] }>;
  info(): Promise<{ model_id: string; dim: number }>;
}

export function createMlClient(baseUrl: string, fetchImpl: typeof fetch = fetch): MlClient {
  async function call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    if (res.status >= 400 && res.status < 500) {
      throw new MlClientError(res.status, typeof body.detail === 'string' ? body.detail : 'Invalid request');
    }
    if (!res.ok) throw new Error(`ml ${path} failed with ${res.status}`);
    return body as T;
  }

  return {
    ingest(clientId, collectionId, file) {
      const form = new FormData();
      form.append('client_id', clientId);
      form.append('collection_id', collectionId);
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename);
      // Accepting only hashes and enqueues (parsing and embedding run in the ml worker), but the
      // upload itself can be up to 20 MB, so allow for a slow transfer.
      return call('/ingest', { method: 'POST', body: form }, 60_000);
    },

    embed(texts, kind) {
      return call(
        '/embed',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts, kind }) },
        30_000,
      );
    },

    info() {
      return call('/info', { method: 'GET' }, 5_000);
    },
  };
}
