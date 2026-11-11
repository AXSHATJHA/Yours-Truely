/**
 * Talks to the AI model and streams the answer back piece by piece.
 *
 * Two providers:
 *  - "anthropic": Claude via the official Anthropic SDK.
 *  - "openai-compatible": any server that speaks the OpenAI chat API format,
 *    e.g. Ollama on your own PC, OpenRouter, LM Studio, vLLM. This is how you
 *    run open-source vision models such as Qwen2.5-VL or Llama 3.2 Vision.
 *
 * Both are wrapped behind one function, `streamAnswer`, so the rest of the app
 * doesn't care which one is in use.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Settings } from "./store";

/** One past exchange in this session, kept so follow-ups ("make it faster?") make sense. */
export interface Turn {
  question: string; // the typed note, or "(screenshot)"
  answer: string;
}

export interface AskInput {
  settings: Settings;
  keys: { anthropicKey: string; openaiKey: string };
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
  return streamOpenAICompatible(input);
}

// ---------------------------------------------------------------- Anthropic

async function streamAnthropic(input: AskInput): Promise<void> {
  const { settings, keys } = input;
  if (!keys.anthropicKey) throw new Error("No Anthropic API key set. Open Settings and paste your key.");

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

async function streamOpenAICompatible(input: AskInput): Promise<void> {
  const { settings, keys } = input;
  if (!settings.openaiBaseUrl) throw new Error("No base URL set for the open-source provider. Open Settings.");

  const client = new OpenAI({
    baseURL: settings.openaiBaseUrl,
    // Ollama ignores the key but the library requires a non-empty value.
    apiKey: keys.openaiKey || "not-needed",
  });

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

  const stream = await client.chat.completions.create(
    { model: settings.openaiModel, messages, stream: true },
    { signal: input.signal }
  );
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) input.onText(text);
  }
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
