import { createHash } from 'node:crypto';

/*
 * In-memory imitation of the Azure OpenAI v1 embeddings endpoint for tests. Vectors are
 * deterministic hashes of the input text (no meaning, test-only).
 */

export interface RecordedEmbeddingRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: {
    model?: string;
    input?: string[];
    dimensions?: number;
    encoding_format?: string;
  };
}

export interface ScriptedEmbeddingResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export function fakeVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block += 1) {
    const digest = createHash('sha256')
      .update(`${String(block)}:${text}`)
      .digest();
    for (let offset = 0; offset + 1 < digest.length && values.length < dimensions; offset += 2) {
      values.push(digest.readUInt16BE(offset) / 65535 - 0.5);
    }
  }
  return values;
}

export class FakeEmbeddingService {
  readonly requests: RecordedEmbeddingRequest[] = [];
  readonly scripted: ScriptedEmbeddingResponse[] = [];
  /** Dimensions of returned vectors (can differ from the client's to test mismatches). */
  dimensions: number;
  readonly #apiKey: string | undefined;
  readonly #bearerToken: string | undefined;
  #active = 0;
  maxObservedConcurrency = 0;
  /** Milliseconds each request takes, to observe concurrency. */
  latencyMs = 0;

  constructor(options: { apiKey?: string; bearerToken?: string; dimensions: number }) {
    this.#apiKey = options.apiKey;
    this.#bearerToken = options.bearerToken;
    this.dimensions = options.dimensions;
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = JSON.parse(
      typeof init.body === 'string' ? init.body : '{}',
    ) as RecordedEmbeddingRequest['body'];
    this.requests.push({ url, headers, body });
    this.#active += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.#active);
    try {
      if (this.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      }
      const scripted = this.scripted.shift();
      if (scripted !== undefined) {
        return new Response(scripted.body ?? '', {
          status: scripted.status,
          headers: scripted.headers ?? {},
        });
      }
      const authorized =
        (this.#apiKey !== undefined && headers['api-key'] === this.#apiKey) ||
        (this.#bearerToken !== undefined &&
          headers['authorization'] === `Bearer ${this.#bearerToken}`);
      if (!authorized) {
        return Response.json(
          { error: { code: '401', message: 'Access denied.' } },
          { status: 401 },
        );
      }
      if (!url.endsWith('/openai/v1/embeddings')) {
        return Response.json(
          { error: { code: 'NotFound', message: 'Not found.' } },
          { status: 404 },
        );
      }
      const inputs = body.input ?? [];
      if (
        inputs.length === 0 ||
        inputs.length > 2048 ||
        inputs.some((input) => input.trim() === '')
      ) {
        return Response.json(
          { error: { code: 'invalid_request', message: `Bad input '${inputs.join(' | ')}'` } },
          { status: 400 },
        );
      }
      const dimensions = body.dimensions ?? this.dimensions;
      return Response.json({
        object: 'list',
        model: body.model,
        data: inputs.map((input, index) => ({
          object: 'embedding',
          index,
          embedding: fakeVector(input, dimensions),
        })),
        usage: { prompt_tokens: inputs.join(' ').length, total_tokens: inputs.join(' ').length },
      });
    } finally {
      this.#active -= 1;
    }
  };
}
