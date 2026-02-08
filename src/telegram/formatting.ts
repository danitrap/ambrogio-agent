export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function withPlaceholders(text: string): {
  text: string;
  restore: (value: string) => string;
} {
  const placeholders: string[] = [];
  const token = (value: string): string => {
    const id = placeholders.push(value) - 1;
    return `@@TGPH${id}@@`;
  };

  const withCodeBlocks = text.replaceAll(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_match, language: string | undefined, code: string) => {
    const className = language ? ` class="language-${escapeHtml(language)}"` : "";
    return token(`<pre><code${className}>${escapeHtml(code)}</code></pre>`);
  });

  const withInlineCode = withCodeBlocks.replaceAll(/`([^`]+)`/g, (_match, code: string) => {
    return token(`<code>${escapeHtml(code)}</code>`);
  });

  return {
    text: withInlineCode,
    restore: (value: string) => value.replaceAll(/@@TGPH(\d+)@@/g, (_match, id: string) => placeholders[Number(id)] ?? ""),
  };
}

export function formatTelegramHtml(text: string): string {
  const normalized = text.replaceAll(/\r\n/g, "\n");
  const placeholderState = withPlaceholders(normalized);

  let output = escapeHtml(placeholderState.text);
  output = output.replaceAll(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  output = output.replaceAll(/_([^_\n]+)_/g, "<i>$1</i>");
  output = output.replaceAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
    return `<a href="${escapeHtml(url)}">${label}</a>`;
  });

  return placeholderState.restore(output);
}

export function stripMarkdown(text: string): string {
  return text
    .replaceAll(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, "$2")
    .replaceAll(/`([^`]+)`/g, "$1")
    .replaceAll(/\*\*([^*\n]+)\*\*/g, "$1")
    .replaceAll(/_([^_\n]+)_/g, "$1")
    .replaceAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replaceAll(/\s+/g, " ")
    .trim();
}
