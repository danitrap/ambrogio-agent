import { describe, expect, test } from "bun:test";
import { formatTelegramHtml, stripMarkdown } from "../src/telegram/formatting";

describe("telegram formatting", () => {
  test("converts common markdown to telegram-safe html", () => {
    const input = [
      "**bold**",
      "_italic_",
      "`code`",
      "```ts",
      "const a = 1 < 2 && 3 > 1",
      "```",
    ].join("\n");

    const output = formatTelegramHtml(input);
    expect(output).toContain("<b>bold</b>");
    expect(output).toContain("<i>italic</i>");
    expect(output).toContain("<code>code</code>");
    expect(output).toContain("<pre><code class=\"language-ts\">const a = 1 &lt; 2 &amp;&amp; 3 &gt; 1");
  });

  test("escapes html special chars in plain text", () => {
    const output = formatTelegramHtml("5 < 7 & 9 > 3");
    expect(output).toBe("5 &lt; 7 &amp; 9 &gt; 3");
  });

  test("strips markdown for plain-text fallback", () => {
    const input = "**ciao** _mondo_ `ok`";
    expect(stripMarkdown(input)).toBe("ciao mondo ok");
  });
});
