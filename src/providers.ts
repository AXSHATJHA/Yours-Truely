/**
 * Talks to the AI model and streams the answer back piece by piece.
 *
 * Three providers:
 *  - "anthropic": Claude via the official Anthropic SDK.
 *  - "groq": Groq's hosted models (default: Qwen 3.8 27B, which can read
 *    screenshots). Groq speaks the OpenAI chat API format, so it reuses the
 *    same code path as the next provider, plus a few Groq-only settings.
 *  - "openai-compatible": any server that speaks the OpenAI chat API format,
 *    e.g. Ollama on your own PC, OpenRouter, LM Studio, vLLM. This is how you
 *    run open-source vision models such as Qwen2.5-VL or Llama 3.2 Vision.
 *
 * All are wrapped behind one function, `streamAnswer`, so the rest of the app
 * doesn't care which one is in use.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Settings } from "./store";
import { ThinkFilter } from "./think";

/** Groq's OpenAI-compatible endpoint. The SDK adds "/chat/completions" itself. */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** One past exchange in this session, kept so follow-ups ("make it faster?") make sense. */
export interface Turn {
  question: string; // the typed note, or "(screenshot)"
  answer: string;
}

export interface AskInput {
  settings: Settings;
  keys: { anthropicKey: string; openaiKey: string; groqKey: string };
  systemPrompt: string;
  history: Turn[];
  imageJpegBase64?: string; // screenshot of the screen, if taken
  note?: string; // what the candidate typed, if anything
  signal: AbortSignal; // lets the user cancel a running answer
  onText: (chunk: string) => void; // called for each new piece of text
}

/** How many earlier exchanges to send along. Older ones are dropped to stay fast. */
const MAX_HISTORY = 6;

function userText(note?: string, hasImage?: boolean): string {
  if (note && hasImage) return `Question / note from me: ${note}\n\n(Screenshot of my screen attached for context.)`;
  if (note) return `Question / note from me: ${note}`;
  return "Here is my screen right now. Answer the interview question shown on it.";
}

export async function streamAnswer(input: AskInput): Promise<void> {
  if (input.settings.provider === "anthropic") return streamAnthropic(input);
  if (input.settings.provider === "groq") return streamGroq(input);
  return streamOpenAICompatible(input);
}

// ---------------------------------------------------------------- Anthropic

async function streamAnthropic(input: AskInput): Promise<void> {
  const { settings, keys } = input;
  if (!keys.anthropicKey) throw new Error("No Anthropic API key set. Open Settings and paste your key.");

  // The SDK already retries failed requests twice (rate limits, server errors,
  // dropped connections) with growing waits before giving up. That covers
  // failures before the answer starts; the overlay's Retry button covers the rest.
  const client = new Anthropic({ apiKey: keys.anthropicKey });

  // Earlier exchanges are sent as plain text only. Re-sending old screenshots
  // would make every request slower and more expensive for little benefit.
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of input.history.slice(-MAX_HISTORY)) {
    messages.push({ role: "user", content: t.question });
    messages.push({ role: "assistant", content: t.answer || "(no answer)" });
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.imageJpegBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: input.imageJpegBase64 },
    });
  }
  content.push({ type: "text", text: userText(input.note, !!input.imageJpegBase64) });
  messages.push({ role: "user", content });

  // Sonnet 5.5 and Opus 5.5 support server-side fallbacks: if the model
  // declines a request, the API retries it on a suitable model in the same
  // call, instead of returning nothing. Haiku has no server-side fallback.
  const supportsFallback = /^claude-(sonnet|opus)-5-5/.test(settings.anthropicModel);

  const stream = client.beta.messages.stream(
    {
      model: settings.anthropicModel,
      max_tokens: 8000,
      // The system prompt is the same for every question in an interview, so
      // we mark it cacheable: repeat requests reuse it and start answering sooner.
      system: [{ type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
      // "effort" controls how long the model thinks before answering.
      // Low = fastest, which is what you want mid-interview.
      output_config: { effort: settings.effort },
      ...(supportsFallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    },
    { signal: input.signal }
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      input.onText(event.delta.text);
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    input.onText("\n\n_(The model declined to answer this one. Try rephrasing in the note box.)_");
  } else if (final.stop_reason === "max_tokens") {
    input.onText("\n\n_(Answer cut off: it hit the length limit.)_");
  }
}

// -------------------------------------------------------- OpenAI-compatible

/**
 * Builds the message list in the OpenAI chat format, which Groq, Ollama,
 * OpenRouter etc. all accept:
 *   1. a "system" message: the voice rules + your profile + this interview.
 *      This is what makes the model follow our prompt; it is sent first, on
 *      every request, exactly as it is for Claude.
 *   2. earlier exchanges as plain user/assistant text (no old screenshots).
 *   3. the new question: screenshot (as a base64 "data URL") + text.
 */
function buildOpenAIMessages(input: AskInput): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: input.systemPrompt },
  ];
  for (const t of input.history.slice(-MAX_HISTORY)) {
    messages.push({ role: "user", content: t.question });
    messages.push({ role: "assistant", content: t.answer || "(no answer)" });
  }
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
  if (input.imageJpegBase64) {
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${input.imageJpegBase64}` } });
  }
  parts.push({ type: "text", text: userText(input.note, !!input.imageJpegBase64) });
  messages.push({ role: "user", content: parts });
  return messages;
}

/**
 * Sends the request and streams the reply. Shared by Groq and the generic
 * OpenAI-compatible provider; `extra` carries provider-specific parameters.
 */
async function streamChat(
  client: OpenAI,
  input: AskInput,
  model: string,
  extra: Record<string, unknown>,
  lengthHint: string
): Promise<void> {
  const params = {
    model,
    messages: buildOpenAIMessages(input),
    stream: true as const,
    ...extra,
  } as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  const stream = await client.chat.completions.create(params, { signal: input.signal });

  // Hides any <think>...</think> reasoning a model writes into its answer.
  const think = new ThinkFilter();
  // finish_reason tells us why the model stopped. "length" means it ran out of
  // room mid-answer; without this check a cut-off answer would look complete.
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const text = choice?.delta?.content;
    if (text) {
      const visible = think.push(text);
      if (visible) input.onText(visible);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  const rest = think.flush();
  if (rest) input.onText(rest);

  if (finishReason === "length") {
    input.onText(`\n\n_(Answer cut off: it hit the length limit. ${lengthHint})_`);
  } else if (finishReason === "content_filter") {
    input.onText("\n\n_(The model's server filtered this answer.)_");
  }
}

async function streamOpenAICompatible(input: AskInput): Promise<void> {
  const { settings, keys } = input;
  if (!settings.openaiBaseUrl) throw new Error("No base URL set for the open-source provider. Open Settings.");

  const client = new OpenAI({
    baseURL: settings.openaiBaseUrl,
    // Ollama ignores the key but the library requires a non-empty value.
    apiKey: keys.openaiKey || "not-needed",
  });
  await streamChat(
    client,
    input,
    settings.openaiModel,
    {},
    "Raise the model's max output in your server settings, or ask for a shorter answer."
  );
}

// --------------------------------------------------------------------- Groq

/** Groq's output cap for Qwen 3.8 27B. Larger requests are rejected. */
const GROQ_MAX_OUTPUT = 16384;

/** Turns the saved max-tokens setting into a safe whole number. */
export function groqMaxTokens(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1000;
  return Math.min(n, GROQ_MAX_OUTPUT);
}

async function streamGroq(input: AskInput): Promise<void> {
  const { settings, keys } = input;
  if (!keys.groqKey) throw new Error("No Groq API key set. Open Settings and paste your key (it starts with gsk_).");

  const client = new OpenAI({ baseURL: GROQ_BASE_URL, apiKey: keys.groqKey });
  try {
    await streamChat(
      client,
      input,
      settings.groqModel,
      {
        // The sampling values Groq's docs give for this model.
        // temperature: how random word choice is (0 = always the likeliest word).
        // top_p: only pick from the most likely words that together make up 95%.
        temperature: 0.6,
        top_p: 0.95,
        // Hard cap on reply length, in tokens (a token is roughly 3/4 of a word).
        // On Groq's free tier this must stay at or below your per-minute
        // output limit, or Groq rejects the request before answering.
        max_completion_tokens: groqMaxTokens(settings.groqMaxTokens),
        // How much the model thinks before answering ("none" = not at all).
        reasoning_effort: settings.groqReasoningEffort,
        // Keep the thinking out of the answer text: we only want the answer.
        // ("none" mode doesn't think, so the setting isn't needed there.)
        ...(settings.groqReasoningEffort !== "none" ? { reasoning_format: "hidden" } : {}),
      },
      "Raise \"Max answer length\" in Settings, or ask for a shorter answer."
    );
  } catch (err) {
    throw groqError(err);
  }
}

/**
 * Groq returns the same error classes as any OpenAI-compatible server, so we
 * translate the common ones here, where we know it was Groq, into advice.
 */
function groqError(err: unknown): unknown {
  if (!(err instanceof OpenAI.APIError)) return err;
  if (err instanceof OpenAI.APIUserAbortError) return err; // you pressed cancel: not an error
  if (err instanceof OpenAI.APIConnectionError) return new Error("Couldn't reach Groq. Check your internet connection.");
  const msg = err.message || "";
  if (err.status === 401) return new Error("Groq rejected the API key. Check it in Settings.");
  if (err.status === 404) return new Error("Groq doesn't know that model name. Check it in Settings.");
  if (/tokens per minute|\b(O)?TPM\b/i.test(msg)) {
    return new Error(
      "Groq's per-minute token limit for your account is lower than this request needs. " +
        "Lower \"Max answer length\" in Settings (the free tier allows about 1000), or wait a minute and retry."
    );
  }
  if (err.status === 429) return new Error("Rate limited by Groq. Wait a few seconds and try again.");
  if (err.status === 413) return new Error("The screenshot was too large for Groq. Try again, or type the question instead.");
  return new Error(`Groq error ${err.status ?? ""}: ${msg}`);
}

/** Turn library errors into one readable sentence for the answer window. */
export function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Wait a few seconds and try again.";
  if (err instanceof Anthropic.NotFoundError) return "Model not found. Check the model name in Settings.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  if (err instanceof OpenAI.APIConnectionError) return "Couldn't reach the open-source model server. Is Ollama (or your server) running at the base URL in Settings?";
  if (err instanceof OpenAI.APIError) return `Model server error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
