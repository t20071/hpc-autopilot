import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders the kind of answer the model gives", () => {
    const out = html(
      "**Failed jobs**\n\n| Job ID | Job name | User |\n|--------|----------|------|\n| 1015 | supply-chain-gnn | lin |\n\n- The cluster is idle: **0 running**\n- Use `--time 30`",
    );
    expect(out).toContain("<strong>Failed jobs</strong>");
    expect(out).toContain("<th>Job ID</th>");
    expect(out).toContain("<td>supply-chain-gnn</td>");
    expect(out).toContain("<li>The cluster is idle: <strong>0 running</strong></li>");
    expect(out).toContain("<code>--time 30</code>");
    expect(out).not.toContain("|---");
  });

  it("never turns model output into HTML", () => {
    const out = html('<img src=x onerror="alert(1)"> **hi**');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});
