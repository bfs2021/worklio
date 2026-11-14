import type { JSONContent } from "@tiptap/react";

/**
 * Serialize a TipTap JSON document to GitHub-flavoured Markdown.
 * Covers every node/mark the canvas schema can produce; unknown nodes fall back to their text.
 */
export function toMarkdown(doc: JSONContent, title?: string): string {
  const out: string[] = [];
  if (title?.trim()) out.push(`# ${escapeInline(title.trim())}`, "");
  const body = blocks(doc.content ?? [], "").trimEnd();
  if (body) out.push(body);
  return out.join("\n").trimEnd() + "\n";
}

function escapeInline(s: string) {
  return s.replace(/([\\`*_[\]<>#|~])/g, "\\$1");
}

type Mark = NonNullable<JSONContent["marks"]>[number];

function wrap(text: string, marks: Mark[] | undefined): string {
  if (!marks?.length || !text) return text;
  let t = text;
  const code = marks.some((m) => m.type === "code");
  if (code) {
    const fence = t.includes("`") ? "``" : "`";
    t = `${fence}${t}${fence}`;
  }
  for (const m of marks) {
    switch (m.type) {
      case "bold":
        t = `**${t}**`;
        break;
      case "italic":
        t = `_${t}_`;
        break;
      case "strike":
        t = `~~${t}~~`;
        break;
      case "highlight":
        t = `==${t}==`;
        break;
      case "underline":
        t = `<u>${t}</u>`;
        break;
    }
  }
  const link = marks.find((m) => m.type === "link");
  if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href).replace(/\)/g, "%29")})`;
  return t;
}

function inline(nodes: JSONContent[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text": {
          const code = n.marks?.some((m) => m.type === "code");
          return wrap(code ? (n.text ?? "") : escapeInline(n.text ?? ""), n.marks);
        }
        case "hardBreak":
          return "  \n";
        case "mention":
          return `@${n.attrs?.label ?? n.attrs?.id ?? "someone"}`;
        case "image":
          return `![${n.attrs?.alt ?? ""}](${n.attrs?.src ?? ""})`;
        default:
          return inline(n.content);
      }
    })
    .join("");
}

function indent(text: string, prefix: string) {
  return text
    .split("\n")
    .map((line, i) => (i === 0 || !line ? line : prefix + line))
    .join("\n");
}

function list(node: JSONContent, prefix: string): string {
  const items = node.content ?? [];
  const start = Number(node.attrs?.start ?? 1);
  return items
    .map((item, i) => {
      let marker = "- ";
      if (node.type === "orderedList") marker = `${start + i}. `;
      if (node.type === "taskList") marker = `- [${item.attrs?.checked ? "x" : " "}] `;
      const pad = " ".repeat(marker.length);
      const body = blocks(item.content ?? [], "").trimEnd();
      return prefix + marker + indent(body, prefix + pad);
    })
    .join("\n");
}

function table(node: JSONContent): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      blocks(cell.content ?? [], "")
        .trim()
        .replace(/\n+/g, "<br>")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(cols - r.length).fill("")]);
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return [line(norm[0]), line(Array(cols).fill("---")), ...norm.slice(1).map(line)].join("\n");
}

function blocks(nodes: JSONContent[], prefix: string): string {
  const parts: string[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "paragraph":
        parts.push(inline(n.content));
        break;
      case "heading":
        parts.push(`${"#".repeat(Number(n.attrs?.level ?? 1))} ${inline(n.content)}`);
        break;
      case "bulletList":
      case "orderedList":
      case "taskList":
        parts.push(list(n, prefix));
        break;
      case "blockquote": {
        const inner = blocks(n.content ?? [], "").trimEnd();
        const lead = n.attrs?.variant === "callout" ? "> 💡 " : "> ";
        parts.push(
          inner
            .split("\n")
            .map((l, i) => (i === 0 ? lead + l : l ? `> ${l}` : ">"))
            .join("\n"),
        );
        break;
      }
      case "codeBlock": {
        const code = (n.content ?? []).map((c) => c.text ?? "").join("");
        const fence = code.includes("```") ? "~~~" : "```";
        parts.push(`${fence}${n.attrs?.language ?? ""}\n${code}\n${fence}`);
        break;
      }
      case "horizontalRule":
        parts.push("---");
        break;
      case "image":
        parts.push(`![${n.attrs?.alt ?? ""}](${n.attrs?.src ?? ""})`);
        break;
      case "table":
        parts.push(table(n));
        break;
      default:
        parts.push(n.content ? blocks(n.content, prefix) : inline([n]));
    }
  }
  return parts.join("\n\n");
}

/** Trigger a browser download of `text` as `filename`. */
export function downloadText(filename: string, text: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string) {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || "Untitled canvas"}.md`;
}
