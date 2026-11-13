/**
 * A tiny Markdown renderer for the few things answers use:
 *   **bold**, *italic* / _italic_, `inline code`, ```code blocks```,
 *   "- " bullets, "1. " numbered steps, and [links](https://...).
 *
 * Safety: all text is HTML-escaped FIRST, so nothing in an answer can inject
 * HTML or scripts into the window. Only the tags this file creates are real.
 *
 * It's a plain global function (no import/export) so the overlay page can load
 * it with a <script> tag, and the tests can load it too (see test/).
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Formats one line of text (no block structure). */
function renderInline(text: string): string {
  let s = escapeHtml(text);

  // 1. Take inline code out first and put a placeholder in its place, so the
  //    bold/italic rules below can't touch what's inside `like*this*`.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 2. Links: only http(s) URLs, opened in the normal browser by the app.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );

  // 3. Bold, then italics. "(?=\S)" and "(?<=\S)" mean "no space just inside
  //    the markers", so maths like "2 * 3 * 4" is left alone, and "[^\w]"
  //    before the marker stops "a*b*c" from being italicised.
  s = s.replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1<em>$2</em>");

  // 4. Put the inline code back.
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Formats a whole answer (paragraphs, lists, code blocks). */
function renderMarkdown(md: string): string {
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let list: "ul" | "ol" | null = null;

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (type: "ul" | "ol") => {
    if (list === type) return;
    closeList();
    out.push(`<${type}>`);
    list = type;
  };

  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      openList("ul");
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      openList("ol");
      out.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${renderInline(line.replace(/^#+\s*/, ""))}</p>`);
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); // still streaming in
  closeList();
  return out.join("");
}
