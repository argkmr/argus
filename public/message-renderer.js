import { parseSourceReferenceTarget } from "./source-reference.js";

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

function safeExternalUrl(value = "") {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function externalLink(href, label, renderLabel = escapeHtml) {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) return escapeHtml(label);
  return `<a class="chat-link" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${renderLabel(label)}</a>`;
}

function trimUrlPunctuation(value) {
  let url = String(value);
  let suffix = "";
  while (/[.,!?;:]$/.test(url)) {
    suffix = url.slice(-1) + suffix;
    url = url.slice(0, -1);
  }
  while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    suffix = ")" + suffix;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function unescapeMarkdown(value) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
}

// Source citations can contain spaces, escaped brackets and balanced parentheses.
// Scan the small inline link grammar instead of ending the destination at its
// first `)`. Unclosed/invalid links are left as escaped text while streaming.
function replaceMarkdownLinks(source, replace) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      result += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (source[index] !== "[" || source[index - 1] === "!") { result += source[index++]; continue; }
    const start = index;
    let cursor = index + 1;
    let depth = 1;
    while (cursor < source.length && source[cursor] !== "\n" && depth) {
      if (source[cursor] === "\\") { cursor += 2; continue; }
      if (source[cursor] === "[") depth += 1;
      if (source[cursor] === "]") depth -= 1;
      if (depth) cursor += 1;
    }
    if (depth) { result += source.slice(index); break; }
    if (source[cursor + 1] !== "(" || cursor === start + 1) { result += source[index++]; continue; }
    const label = source.slice(start + 1, cursor);
    const destinationStart = cursor + 2;
    cursor = destinationStart;
    depth = 1;
    let angle = source[cursor] === "<";
    let angleClosed = !angle;
    if (angle) cursor += 1;
    while (cursor < source.length && source[cursor] !== "\n" && depth) {
      if (source[cursor] === "\\") { cursor += 2; continue; }
      if (angle) {
        if (source[cursor] === ">") { angle = false; angleClosed = true; }
      } else {
        if (source[cursor] === "(") depth += 1;
        if (source[cursor] === ")") depth -= 1;
      }
      if (depth) cursor += 1;
    }
    if (depth || !angleClosed) { result += source.slice(index); break; }
    const target = source.slice(destinationStart, cursor).trim();
    const replacement = replace(target, unescapeMarkdown(label));
    result += replacement ?? source.slice(start, cursor + 1);
    index = cursor + 1;
  }
  return result;
}

function inlineMarkdown(value = "") {
  const source = String(value);
  const tokens = [];
  // Pick a namespace absent from this input. Literal user-supplied placeholders
  // must never resolve to renderer-generated HTML, including inside link labels.
  let tokenPrefix = "\uE000ARGUS";
  while (source.includes(tokenPrefix)) tokenPrefix += "X";
  const tokenPattern = new RegExp(`${tokenPrefix}(\\d+)\uE001`, "g");
  const token = (html, kind = "markup") => {
    const index = tokens.push({ html, kind }) - 1;
    return `${tokenPrefix}${index}\uE001`;
  };
  const renderLabel = (label) => escapeHtml(label).replace(tokenPattern, (match, index) => {
    const entry = tokens[Number(index)];
    return entry?.kind === "code" ? entry.html : match;
  });
  const protectedInlineCode = source.replace(/(`+)([^\n]*?)\1/g, (_match, _marker, content) => token(`<code class="chat-inline-code">${escapeHtml(content)}</code>`, "code"));
  const withMarkdownLinks = replaceMarkdownLinks(protectedInlineCode, (target, label) => {
    // Code spans can be a label, but not a file path or an external destination.
    if (target.includes(tokenPrefix)) return null;
    const destination = unescapeMarkdown(target.replace(/^<([\s\S]*)>$/, "$1"));
    if (safeExternalUrl(destination)) return token(externalLink(destination, label, renderLabel));
    const reference = parseSourceReferenceTarget(target);
    if (!reference) return null;
    const location = `${reference.path}${reference.line ? `:${reference.line}` : ""}${reference.column ? `:${reference.column}` : ""}`;
    return token(`<button type="button" class="chat-file-reference" data-source-reference="${escapeHtml(target)}" title="Open source: ${escapeHtml(location)}">${renderLabel(label)}</button>`);
  });
  const withPlainLinks = withMarkdownLinks.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    if (match.includes(tokenPrefix)) return match;
    const { url, suffix } = trimUrlPunctuation(match);
    return `${token(externalLink(url, url))}${escapeHtml(suffix)}`;
  });
  return escapeHtml(withPlainLinks)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(tokenPattern, (match, index) => tokens[Number(index)]?.html ?? match);
}

function textBlock(lines) {
  if (!lines.length) return "";
  return `<p class="chat-paragraph">${lines.map((line) => inlineMarkdown(line)).join("<br />")}</p>`;
}

function tableCells(line = "") {
  let source = String(line).trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);
  const cells = [];
  let cell = "";
  let escaped = false;
  let inCode = false;
  for (const character of source) {
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === "\\") { cell += character; escaped = true; continue; }
    if (character === "`") { inCode = !inCode; cell += character; continue; }
    if (character === "|" && !inCode) { cells.push(cell.trim()); cell = ""; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function tableDelimiter(line = "") {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function tableAlignment(delimiter = "") {
  const value = delimiter.replace(/\s+/g, "");
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function markdownTable(lines, start) {
  if (start + 1 >= lines.length || !lines[start].includes("|") || !tableDelimiter(lines[start + 1])) return null;
  const headers = tableCells(lines[start]);
  const delimiters = tableCells(lines[start + 1]);
  if (headers.length < 2 || headers.length !== delimiters.length) return null;
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
    const cells = tableCells(lines[index]);
    if (cells.length !== headers.length) break;
    rows.push(cells);
    index += 1;
  }
  const columns = headers.map((header, column) => ({ header, align: tableAlignment(delimiters[column]) }));
  const head = `<thead><tr>${columns.map(({ header, align }) => `<th style="text-align:${align}">${inlineMarkdown(header)}</th>`).join("")}</tr></thead>`;
  const body = rows.length ? `<tbody>${rows.map((cells) => `<tr>${cells.map((cell, column) => `<td style="text-align:${columns[column].align}">${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>` : "";
  return { html: `<div class="chat-table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table class="chat-table">${head}${body}</table></div>`, next: index };
}

const MAX_QUOTE_DEPTH = 24;
const MAX_LIST_DEPTH = 24;

function listItem(line) {
  const match = line.match(/^( {0,3})(?:(\d{1,9})([.)])|([-*+]))([ \t]+)(.+)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    contentIndent: match[0].length - match[6].length,
    ordered: Boolean(match[2]),
    marker: match[3] || match[4],
    start: match[2] ? Number(match[2]) : null,
    content: match[6],
  };
}

function markdownList(lines, start, quoteDepth, listDepth) {
  const first = listItem(lines[start]);
  if (!first || listDepth >= MAX_LIST_DEPTH) return null;
  const sameList = item => item && item.indent === first.indent
    && item.ordered === first.ordered && item.marker === first.marker;
  const items = [];
  let index = start;
  while (index < lines.length) {
    const item = listItem(lines[index]);
    if (!sameList(item)) break;
    const content = [item.content];
    index++;
    while (index < lines.length) {
      if (!lines[index].trim()) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        // A blank line between sibling items makes a loose list, not a new
        // list starting at one. Prose and headings outside an item still end it.
        if (sameList(listItem(lines[next] || ""))) { index = next; break; }
        if (next >= lines.length || !lines[next].startsWith(" ".repeat(item.contentIndent))) break;
        content.push("");
        index = next;
      }
      if (!lines[index].startsWith(" ".repeat(item.contentIndent))) break;
      content.push(lines[index].slice(item.contentIndent));
      index++;
    }
    const html = content.length === 1 ? inlineMarkdown(content[0]) : renderText(content, quoteDepth, listDepth + 1);
    items.push(`<li>${html}</li>`);
  }
  const tag = first.ordered ? "ol" : "ul";
  const startAttribute = first.ordered && first.start !== 1 ? ` start="${first.start}"` : "";
  return { html: `<${tag} class="chat-list"${startAttribute}>${items.join("")}</${tag}>`, next: index };
}

function renderText(lines, quoteDepth, listDepth = 0) {
  const result = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) { result.push(textBlock(paragraph)); paragraph = []; } };
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { flush(); index += 1; continue; }
    const table = markdownTable(lines, index);
    if (table) { flush(); result.push(table.html); index = table.next; continue; }
    const heading = lines[index].match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      result.push(`<h${level} class="chat-heading">${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    const list = markdownList(lines, index, quoteDepth, listDepth);
    if (list) {
      flush();
      result.push(list.html);
      index = list.next;
      continue;
    }
    const quote = lines[index].match(/^\s{0,3}>\s?(.*)$/);
    if (quote && quoteDepth < MAX_QUOTE_DEPTH) {
      flush();
      const quoted = [];
      while (index < lines.length) {
        const line = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!line) break;
        quoted.push(line[1]);
        index += 1;
      }
      // A `>` blank line separates paragraphs within one quote; it is not a
      // shaded, empty quote of its own. Reuse the safe block renderer so lists,
      // citations and fenced code keep their meaning inside the same container.
      const content = renderMessage(quoted.join("\n"), quoteDepth + 1);
      if (content) result.push(`<blockquote class="chat-quote">${content}</blockquote>`);
      continue;
    }
    paragraph.push(lines[index]);
    index += 1;
  }
  flush();
  return result.join("");
}

export function renderChatMessage(value = "") {
  return renderMessage(value, 0);
}

function renderMessage(value, quoteDepth) {
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const result = [];
  let text = [];
  for (let index = 0; index < lines.length;) {
    const opening = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
    if (!opening) { text.push(lines[index]); index += 1; continue; }
    if (text.length) { result.push(renderText(text, quoteDepth)); text = []; }
    const marker = opening[1];
    const language = String(opening[2] || "").trim();
    index += 1;
    const code = [];
    const closing = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
    while (index < lines.length && !closing.test(lines[index])) { code.push(lines[index]); index += 1; }
    const complete = index < lines.length;
    if (complete) index += 1;
    const diagram = language.toLowerCase() === "mermaid";
    result.push(`<section class="chat-code-block${diagram ? " chat-mermaid-block" : ""}"${diagram ? ` data-mermaid-complete="${complete}"` : ""}><header><span>${escapeHtml(language || "Code")}</span><div class="chat-code-actions">${diagram && complete ? '<button type="button" data-toggle-mermaid-source aria-pressed="false" hidden>Code</button>' : ""}<button type="button" data-copy-chat-code>Copy</button></div></header>${diagram ? `<p class="chat-diagram-status" role="status">${complete ? "Preparing diagram…" : "Diagram will render when complete."}</p>` : ""}<pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre></section>`);
  }
  if (text.length) result.push(renderText(text, quoteDepth));
  return result.join("");
}
