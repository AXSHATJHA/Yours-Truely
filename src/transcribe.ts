/**
 * Speech to text with Groq Whisper.
 *
 * Groq hosts OpenAI's open "Whisper" speech-recognition models behind an
 * OpenAI-compatible endpoint (/openai/v1/audio/transcriptions), so the same
 * `openai` library the app already uses for Groq answers can upload audio.
 *
 * This runs in the main process only. The API key never reaches a window.
 */
import OpenAI, { toFile } from "openai";
import { GROQ_BASE_URL } from "./providers";

export interface TranscribeInput {
  wav: Buffer;
  apiKey: string;
  model: string; // "whisper-large-v3-turbo" (fast, cheap) or "whisper-large-v3"
  language?: string; // ISO-639-1 code, e.g. "en". Helps accuracy and speed on short clips.
  /**
   * A short text hint (Groq caps it at 224 tokens). Whisper uses it to spell
   * names and jargon the way they appear here, e.g. the company's name.
   */
  prompt?: string;
  signal?: AbortSignal;
}

/** Turns one WAV file into text. Throws an Error with a readable message on failure. */
export async function transcribeWav(input: TranscribeInput): Promise<string> {
  if (!input.apiKey) throw new Error("Voice needs a Groq API key. Add one in Settings → AI model → Groq.");
  // maxRetries: the library retries rate limits (429) and server errors itself,
  // waiting as long as Groq's "retry-after" header asks.
  const client = new OpenAI({ baseURL: GROQ_BASE_URL, apiKey: input.apiKey, maxRetries: 3, timeout: 30_000 });
  try {
    const res = await client.audio.transcriptions.create(
      {
        file: await toFile(input.wav, "speech.wav", { type: "audio/wav" }),
        model: input.model || "whisper-large-v3-turbo",
        response_format: "json",
        temperature: 0, // no creativity: write what was said
        ...(input.language ? { language: input.language } : {}),
        ...(input.prompt ? { prompt: limitPrompt(input.prompt) } : {}),
      },
      { signal: input.signal }
    );
    return res.text ?? "";
  } catch (err) {
    throw transcribeError(err);
  }
}

/**
 * Keeps the hint well under Groq's 224-token limit. A token is roughly
 * 4 characters of English, so ~600 characters is about 150 tokens.
 * We keep the END of the text, because the most recent words matter most.
 */
export function limitPrompt(text: string, maxChars = 600): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= maxChars ? t : t.slice(t.length - maxChars);
}

/** True for errors worth retrying later (rate limit, network blip, Groq busy). */
export function isRetryable(err: unknown): boolean {
  return err instanceof Error && (err as Error & { retryable?: boolean }).retryable === true;
}

function transcribeError(err: unknown): Error {
  const make = (msg: string, retryable = false) => Object.assign(new Error(msg), { retryable });
  if (err instanceof OpenAI.APIUserAbortError) return make("Cancelled.");
  if (err instanceof OpenAI.APIConnectionError) return make("Couldn't reach Groq to transcribe. Check your internet connection.", true);
  if (!(err instanceof OpenAI.APIError)) return err instanceof Error ? err : make(String(err));
  if (err.status === 401) return make("Groq rejected the API key, so voice can't be transcribed. Check it in Settings.");
  if (err.status === 404) return make("Groq doesn't know that speech model. Check Settings → Voice.");
  if (err.status === 429) return make("Groq's rate limit was reached while transcribing. Waiting, then trying again.", true);
  if (err.status === 413) return make("That piece of audio was too large for Groq.");
  if (err.status && err.status >= 500) return make("Groq had a server error while transcribing. Trying again.", true);
  return make(`Groq transcription error ${err.status ?? ""}: ${err.message}`);
}
