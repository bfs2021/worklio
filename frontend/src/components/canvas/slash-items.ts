import type { Editor, Range } from "@tiptap/react";
import {
  AtSign,
  CalendarDays,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Lightbulb,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  SquareCode,
  Table2,
  type LucideIcon,
} from "lucide-react";

export type SlashContext = {
  /** Open the file picker and insert the uploaded image at `pos`. */
  pickImage: (pos: number) => void;
};

export type SlashItem = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  icon: LucideIcon;
  group: "Basic blocks" | "Lists" | "Insert";
  /** Markdown-ish hint shown on the right. */
  hint?: string;
  run: (editor: Editor, range: Range, ctx: SlashContext) => void;
};

function setQuote(editor: Editor, range: Range, variant: "callout" | null) {
  const chain = editor.chain().focus().deleteRange(range);
  if (!editor.isActive("blockquote")) chain.toggleBlockquote();
  chain.updateAttributes("blockquote", { variant }).run();
}

export function formatToday(d = new Date()) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: "text",
    title: "Text",
    description: "Plain paragraph",
    keywords: ["paragraph", "plain", "p"],
    icon: Pilcrow,
    group: "Basic blocks",
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    id: "h1",
    title: "Heading 1",
    description: "Big section heading",
    keywords: ["title", "h1", "#"],
    icon: Heading1,
    group: "Basic blocks",
    hint: "#",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    description: "Medium section heading",
    keywords: ["subtitle", "h2", "##"],
    icon: Heading2,
    group: "Basic blocks",
    hint: "##",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    description: "Small section heading",
    keywords: ["h3", "###"],
    icon: Heading3,
    group: "Basic blocks",
    hint: "###",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bullet",
    title: "Bulleted list",
    description: "A simple bulleted list",
    keywords: ["ul", "unordered", "bullets", "-"],
    icon: List,
    group: "Lists",
    hint: "-",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: "numbered",
    title: "Numbered list",
    description: "A list with numbering",
    keywords: ["ol", "ordered", "1."],
    icon: ListOrdered,
    group: "Lists",
    hint: "1.",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: "checklist",
    title: "Checklist",
    description: "Track tasks with checkboxes",
    keywords: ["todo", "task", "checkbox", "[]"],
    icon: ListTodo,
    group: "Lists",
    hint: "[]",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: "table",
    title: "Table",
    description: "Rows and columns",
    keywords: ["grid", "spreadsheet", "columns"],
    icon: Table2,
    group: "Insert",
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "image",
    title: "Image",
    description: "Upload a picture",
    keywords: ["photo", "picture", "upload", "img"],
    icon: ImageIcon,
    group: "Insert",
    run: (e, r, ctx) => {
      e.chain().focus().deleteRange(r).run();
      ctx.pickImage(r.from);
    },
  },
  {
    id: "code",
    title: "Code block",
    description: "Monospaced code snippet",
    keywords: ["snippet", "pre", "```"],
    icon: SquareCode,
    group: "Basic blocks",
    hint: "```",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: "quote",
    title: "Quote",
    description: "Capture a quotation",
    keywords: ["blockquote", "citation", ">"],
    icon: Quote,
    group: "Basic blocks",
    hint: ">",
    run: (e, r) => setQuote(e, r, null),
  },
  {
    id: "callout",
    title: "Callout",
    description: "Make a note stand out",
    keywords: ["note", "info", "tip", "warning", "highlight"],
    icon: Lightbulb,
    group: "Basic blocks",
    run: (e, r) => setQuote(e, r, "callout"),
  },
  {
    id: "divider",
    title: "Divider",
    description: "Separate sections",
    keywords: ["hr", "rule", "line", "separator", "---"],
    icon: Minus,
    group: "Insert",
    hint: "---",
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    id: "mention",
    title: "Mention person",
    description: "Tag someone in this workspace",
    keywords: ["@", "user", "people", "tag", "member"],
    icon: AtSign,
    group: "Insert",
    hint: "@",
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent("@").run(),
  },
  {
    id: "date",
    title: "Today's date",
    description: formatToday(),
    keywords: ["today", "date", "now", "day"],
    icon: CalendarDays,
    group: "Insert",
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent(`${formatToday()} `).run(),
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  const scored: { item: SlashItem; score: number }[] = [];
  for (const item of SLASH_ITEMS) {
    const title = item.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 3;
    else if (title.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
    else if (item.keywords.some((k) => k.startsWith(q))) score = 1;
    else if (title.includes(q)) score = 0;
    if (score >= 0) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}
