import { env } from '../env.js'
import { logger } from '../lib/logger.js'

// ─── OpenRouter client ─────────────────────────────────────────────────────
//
// Thin fetch wrapper around OpenRouter's OpenAI-compatible chat-completion
// endpoint. We intentionally DO NOT use the `openai` SDK:
//   - We only need one endpoint (/chat/completions) with a handful of
//     fields — the SDK adds streaming, retries, and assistant runs we
//     don't use.
//   - The SDK's request shape is pinned to OpenAI's schema and has
//     broken in the past on OpenRouter when OpenAI added a required
//     field. A local fetch is 30 lines and it's exactly what we need.
//   - No extra npm dep to audit or update.
//
// Model routing:
//   Primary    : env.OPENROUTER_MODEL           (default moonshotai/kimi-k2)
//   Fallback   : env.OPENROUTER_FALLBACK_MODEL  (default deepseek/deepseek-chat)
//
// Primary is tried first. If it throws (timeout), returns non-OK (429,
// 5xx), or returns an empty completion, fallback runs. Both share the
// same TIMEOUT_MS budget so a stuck primary cannot cannibalize the
// fallback window.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 10_000
const MAX_TOKENS = 512
const TEMPERATURE = 0.2

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface LlmCompletion {
  text: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** true if the primary model failed and we served the answer from the fallback. */
  fromFallback: boolean
}

/**
 * Get a chat completion from OpenRouter. Tries the primary model, falls
 * back to the secondary on failure/empty/timeout. Throws if both fail —
 * the caller is expected to render a friendly "something broke" reply
 * and log the error for operators.
 */
export async function chatComplete(messages: ChatMessage[]): Promise<LlmCompletion> {
  const primary = env.OPENROUTER_MODEL
  const fallback = env.OPENROUTER_FALLBACK_MODEL

  try {
    return await callModel(primary, messages, false)
  } catch (primaryErr) {
    logger.warn(
      {
        err: primaryErr,
        primary_model: primary,
        fallback_model: fallback,
      },
      'openrouter_primary_failed_trying_fallback',
    )
    return await callModel(fallback, messages, true)
  }
}

async function callModel(
  model: string,
  messages: ChatMessage[],
  fromFallback: boolean,
): Promise<LlmCompletion> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        // Recommended by OpenRouter for request attribution — lets them
        // route traffic preferentially if we ever need elevated quota
        // and shows up in their dashboard so we can spot traffic spikes
        // during incidents.
        'HTTP-Referer': 'https://agentchat.me',
        'X-Title': 'AgentChat Chatfather',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    // Read body text so operators see what OpenRouter actually rejected.
    // 401 = bad API key, 402 = out of credits, 429 = rate limited, 5xx
    // = upstream issue. We don't retry on non-OK here — the caller's
    // fallback model path is the retry. A nested retry would double
    // our time budget.
    const errText = await response.text().catch(() => '')
    throw new OpenRouterError(
      `OpenRouter ${response.status}: ${errText.slice(0, 500)}`,
      response.status,
      model,
    )
  }

  const payload = (await response.json()) as ChatCompletionResponse
  const text = payload.choices?.[0]?.message?.content?.trim() ?? ''
  if (!text) {
    // Empty completion — treat as failure so the primary→fallback path
    // kicks in. Possible causes: content filter, zero-token completion
    // under max_tokens, upstream degradation. Either way, not usable.
    throw new OpenRouterError('Empty completion', 200, model)
  }

  const usage = payload.usage ?? {}
  return {
    text,
    model,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    fromFallback,
  }
}

export class OpenRouterError extends Error {
  readonly status: number
  readonly model: string

  constructor(message: string, status: number, model: string) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
    this.model = model
  }
}
