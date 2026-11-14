"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "@/lib/clipboard";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type LanguageModule = { default: import("highlight.js").LanguageFn };
type HLJS = import("highlight.js").HLJSApi;

/** Languages we lazy-load, keyed by canonical highlight.js name. */
const LOADERS: Record<string, () => Promise<LanguageModule>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  python: () => import("highlight.js/lib/languages/python"),
  bash: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/shell"),
  json: () => import("highlight.js/lib/languages/json"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  xml: () => import("highlight.js/lib/languages/xml"),
  sql: () => import("highlight.js/lib/languages/sql"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  ini: () => import("highlight.js/lib/languages/ini"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  py: "python", python3: "python",
  sh: "bash", zsh: "bash", console: "shell",
  html: "xml", svg: "xml", vue: "xml",
  golang: "go", rs: "rust", kt: "kotlin", rb: "ruby",
  "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp", cs: "csharp", "c#": "csharp",
  yml: "yaml", md: "markdown", patch: "diff", docker: "dockerfile", toml: "ini", gql: "graphql",
  text: "plaintext", txt: "plaintext", plain: "plaintext",
};

const LABELS: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", python: "Python", bash: "Bash", shell: "Shell",
  json: "JSON", css: "CSS", scss: "SCSS", xml: "HTML", sql: "SQL", go: "Go", rust: "Rust", java: "Java",
  kotlin: "Kotlin", swift: "Swift", ruby: "Ruby", php: "PHP", c: "C", cpp: "C++", csharp: "C#",
  yaml: "YAML", markdown: "Markdown", diff: "Diff", dockerfile: "Dockerfile", ini: "INI", graphql: "GraphQL",
  plaintext: "Text",
};

/** Canonical language for a fence hint ("ts", "Python"…), or null when unknown. */
export function resolveLanguage(hint: string): string | null {
  const key = hint.trim().toLowerCase();
  if (!key) return null;
  const name = ALIASES[key] ?? key;
  return name in LOADERS ? name : null;
}

// --- Lazy highlighter (core + languages on demand), shared across blocks ---
let core: Promise<HLJS> | null = null;
const registered = new Map<string, Promise<void>>();
const htmlCache = new Map<string, string>();

function getCore(): Promise<HLJS> {
  core ??= import("highlight.js/lib/core").then((m) => m.default);
  return core;
}

function ensureLanguage(hljs: HLJS, lang: string): Promise<void> {
  let p = registered.get(lang);
  if (!p) {
    p = LOADERS[lang]().then((mod) => {
      if (!hljs.getLanguage(lang)) hljs.registerLanguage(lang, mod.default);
    });
    registered.set(lang, p);
  }
  return p;
}

async function highlight(code: string, lang: string): Promise<string> {
  const key = `${lang}\u0000${code}`;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  const hljs = await getCore();
  await ensureLanguage(hljs, lang);
  // highlight.js escapes the source; the result only contains its own <span class="hljs-*"> markup.
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  if (htmlCache.size > 300) htmlCache.clear();
  htmlCache.set(key, html);
  return html;
}

/** Token colours as CSS variables, light + dark, injected once (React hoists and dedupes it). */
const THEME_CSS = `
:root{--hl-keyword:#a626a4;--hl-string:#50a14f;--hl-number:#986801;--hl-comment:#8a8f98;--hl-title:#4078f2;--hl-type:#c18401;--hl-attr:#986801;--hl-built:#0184bc;--hl-meta:#4078f2;--hl-tag:#e45649;--hl-del:#b31d28;--hl-del-bg:#ffeef0;--hl-add:#22863a;--hl-add-bg:#f0fff4}
.dark{--hl-keyword:#c678dd;--hl-string:#98c379;--hl-number:#d19a66;--hl-comment:#7f848e;--hl-title:#61afef;--hl-type:#e5c07b;--hl-attr:#d19a66;--hl-built:#56b6c2;--hl-meta:#61afef;--hl-tag:#e06c75;--hl-del:#f97583;--hl-del-bg:rgba(248,81,73,.15);--hl-add:#85e89d;--hl-add-bg:rgba(46,160,67,.15)}
.wk-code .hljs-keyword,.wk-code .hljs-selector-tag,.wk-code .hljs-literal,.wk-code .hljs-doctag{color:var(--hl-keyword)}
.wk-code .hljs-string,.wk-code .hljs-regexp,.wk-code .hljs-char.escape_,.wk-code .hljs-template-tag{color:var(--hl-string)}
.wk-code .hljs-number,.wk-code .hljs-symbol,.wk-code .hljs-bullet,.wk-code .hljs-variable.constant_{color:var(--hl-number)}
.wk-code .hljs-comment,.wk-code .hljs-quote{color:var(--hl-comment);font-style:italic}
.wk-code .hljs-title,.wk-code .hljs-title.function_,.wk-code .hljs-section{color:var(--hl-title)}
.wk-code .hljs-type,.wk-code .hljs-title.class_,.wk-code .hljs-class .hljs-title{color:var(--hl-type)}
.wk-code .hljs-attr,.wk-code .hljs-attribute,.wk-code .hljs-property,.wk-code .hljs-params{color:var(--hl-attr)}
.wk-code .hljs-built_in,.wk-code .hljs-variable.language_{color:var(--hl-built)}
.wk-code .hljs-meta,.wk-code .hljs-link{color:var(--hl-meta)}
.wk-code .hljs-name,.wk-code .hljs-tag,.wk-code .hljs-selector-class,.wk-code .hljs-selector-id{color:var(--hl-tag)}
.wk-code .hljs-deletion{color:var(--hl-del);background:var(--hl-del-bg)}
.wk-code .hljs-addition{color:var(--hl-add);background:var(--hl-add-bg)}
.wk-code .hljs-emphasis{font-style:italic}.wk-code .hljs-strong{font-weight:700}
`;

export function CodeBlockStyles() {
  return (
    <style href="worklio-code-theme" precedence="medium">
      {THEME_CSS}
    </style>
  );
}

/** A fenced code block: optional syntax highlighting, language label and a Copy button. */
export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [result, setResult] = useState<{ key: string; html: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const key = language ? `${language}\u0000${code}` : "";

  useEffect(() => {
    if (!language || language === "plaintext") return;
    let live = true;
    highlight(code, language)
      .then((html) => live && setResult({ key: `${language}\u0000${code}`, html }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const html = result && result.key === key ? result.html : null;

  return (
    <div className="group/code relative my-1 overflow-hidden rounded-md border bg-muted/70 whitespace-normal">
      <CodeBlockStyles />
      <div className="flex h-7 items-center justify-between border-b border-border/60 pr-1 pl-3 text-[11px] font-semibold text-muted-foreground">
        <span className="tracking-wide uppercase">{language ? (LABELS[language] ?? language) : "Code"}</span>
        <button
          type="button"
          onClick={() => {
            copyText(code)
              .then(() => setCopied(true))
              .catch((err) => toast.error(errorMessage(err, "Couldn't copy to clipboard")));
          }}
          className="flex h-6 items-center gap-1 rounded px-1.5 opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/code:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className={cn("wk-code overflow-x-auto p-3 font-mono text-[13px] leading-5 whitespace-pre")}>
        {html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}
