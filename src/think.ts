/**
 * Removes a model's "thinking" text from a streamed answer.
 *
 * Some reasoning models (Qwen 3 among them) can write their private reasoning
 * into the answer itself, wrapped in tags:
 *
 *   <think>The user wants a hash map definition, so...</think>**Say:** A hash map is...
 *
 * We ask Groq to hide the reasoning (reasoning_format: "hidden"), so normally
 * no tags arrive. This filter is a safety net in case they do: the candidate
 * should only ever see the answer, never a wall of reasoning mid-interview.
 *
 * Why it's a small state machine and not a simple regex: the answer arrives in
 * small pieces ("chunks"), and a tag can be split across two of them, e.g.
 * "<th" in one chunk and "ink>" in the next. So we hold back any trailing text
 * that *might* be the start of a tag until the next chunk tells us what it is.
 */
const OPEN = "<think>";
const CLOSE = "</think>";

export class ThinkFilter {
  private inThink = false;
  private pending = ""; // text held back because it might be the start of a tag
  private atStart = true; // still before any visible answer text?

  /** Feed one streamed chunk; returns the part that is safe to show now. */
  push(chunk: string): string {
    let buf = this.pending + chunk;
    this.pending = "";
    let out = "";
    while (buf.length) {
      const tag = this.inThink ? CLOSE : OPEN;
      const i = buf.indexOf(tag);
      if (i >= 0) {
        if (!this.inThink) out += buf.slice(0, i);
        buf = buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // No full tag. Hold back the longest ending that could begin the tag.
      const keep = partialTagSuffix(buf, tag);
      if (!this.inThink) out += buf.slice(0, buf.length - keep);
      this.pending = buf.slice(buf.length - keep);
      buf = "";
    }
    return this.clean(out);
  }

  /** Call once the stream ends: releases held-back text that wasn't a tag. */
  flush(): string {
    const rest = this.inThink ? "" : this.pending;
    this.pending = "";
    return this.clean(rest);
  }

  // The model usually puts blank lines after </think>; drop them so the answer
  // doesn't start with empty space.
  private clean(text: string): string {
    if (!this.atStart) return text;
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed) this.atStart = false;
    return trimmed;
  }
}

/** Length of the longest end of `s` that is also a beginning of `tag`. */
function partialTagSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}
