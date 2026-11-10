import OpenAI from 'openai';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type LlmEvent = { type: 'delta'; text: string } | { type: 'usage'; usage: Usage };

/** Per-call overrides of the client's defaults (e.g. temperature 0 for query condensation). */
export interface CallOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LlmClient {
  readonly model: string;
  stream(messages: ChatMessage[], signal?: AbortSignal, options?: CallOptions): AsyncIterable<LlmEvent>;
}

export interface LlmOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Any OpenAI-compatible chat endpoint: Ollama (/v1), OpenAI, Mistral, vLLM, LM Studio...
 * Switching provider is config (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY), not code.
 */
export function createLlmClient(opts: LlmOptions): LlmClient {
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, timeout: 300_000, maxRetries: 1 });
  return {
    model: opts.model,
    async *stream(messages, signal, options) {
      const stream = await client.chat.completions.create(
        {
          model: opts.model,
          messages,
          stream: true,
          // Low temperature: we want faithful extraction from sources, not creativity.
          temperature: options?.temperature ?? opts.temperature,
          max_tokens: options?.maxTokens ?? opts.maxTokens,
          // Ask for a final chunk with token counts (supported by OpenAI and Ollama).
          stream_options: { include_usage: true },
        },
        { signal },
      );
      for await (const part of stream) {
        const text = part.choices[0]?.delta?.content;
        if (text) yield { type: 'delta', text };
        if (part.usage) {
          yield {
            type: 'usage',
            usage: { promptTokens: part.usage.prompt_tokens, completionTokens: part.usage.completion_tokens },
          };
        }
      }
    },
  };
}
