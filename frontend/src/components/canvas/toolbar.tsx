"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImageIcon,
  Lightbulb,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table2,
  Undo2,
  Unlink,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function shortcut(keys: string) {
  return isMac() ? keys.replace(/Mod/g, "⌘").replace(/Shift/g, "⇧").replace(/Alt/g, "⌥").replace(/\+/g, "") : keys.replace(/Mod/g, "Ctrl");
}

export const BTN =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-mention aria-pressed:text-mention-foreground";

export function ToolButton({
  label,
  keys,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  keys?: string;
  icon: ComponentType<{ className?: string }>;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const hint = keys ? `${label} (${shortcut(keys)})` : label;
  return (
    <button
      type="button"
      className={BTN}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-keyshortcuts={keys?.replace(/Mod/g, isMac() ? "Meta" : "Control")}
      title={hint}
      disabled={disabled}
      // Keep the editor's selection while clicking toolbar buttons.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon className="size-4" />
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

function Group({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {children}
    </div>
  );
}

/** Ensure links have a scheme; reject javascript: and friends. */
export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  if (v.startsWith("/") || v.startsWith("#")) return v;
  return `https://${v}`;
}

/** URL form shared by the toolbar popover and the selection bubble. */
export function LinkForm({ editor, onDone, idPrefix }: { editor: Editor; onDone: () => void; idPrefix: string }) {
  const [url, setUrl] = useState(() => (editor.getAttributes("link").href as string | undefined) ?? "");
  const [error, setError] = useState("");
  const active = editor.isActive("link");

  function apply() {
    const href = normalizeUrl(url);
    if (!href) {
      setError("Enter a valid web address");
      return;
    }
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "text", text: url.trim(), marks: [{ type: "link", attrs: { href } }] })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onDone();
  }

  function remove() {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    onDone();
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          editor.commands.focus();
          onDone();
        }
      }}
    >
      <label htmlFor={`${idPrefix}-url`} className="text-xs font-bold">
        Link address
      </label>
      <input
        id={`${idPrefix}-url`}
        autoFocus
        type="text"
        inputMode="url"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setError("");
        }}
        placeholder="https://example.com"
        aria-invalid={!!error}
        aria-describedby={error ? `${idPrefix}-error` : undefined}
        className="h-8 rounded-md border bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive sm:text-sm"
      />
      {error && (
        <p id={`${idPrefix}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        {active ? (
          <button
            type="button"
            onClick={remove}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Unlink className="size-3.5" /> Remove link
          </button>
        ) : (
          <span />
        )}
        <button
          type="submit"
          className="rounded-md bg-send px-3 py-1 text-xs font-bold text-white hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:outline-none"
        >
          {active ? "Update" : "Add link"}
        </button>
      </div>
    </form>
  );
}

export function LinkPopover({
  editor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const active = useEditorState({ editor, selector: ({ editor: e }) => e.isActive("link") });
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={BTN}
            aria-label="Link"
            aria-pressed={active ?? false}
            title={`Link (${shortcut("Mod+K")})`}
            onMouseDown={(e) => e.preventDefault()}
          />
        }
      >
        <Link2 className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))]">
        {open && <LinkForm editor={editor} idPrefix="canvas-toolbar-link" onDone={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  );
}

export function CanvasToolbar({
  editor,
  linkOpen,
  onLinkOpenChange,
  onImage,
  className,
}: {
  editor: Editor;
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
  /** Open the image picker (uploads, then inserts at the cursor). Hides the Image button when omitted. */
  onImage?: () => void;
  className?: string;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      editable: e.isEditable,
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      callout: e.isActive("blockquote", { variant: "callout" }),
      table: e.isActive("table"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  if (!s) return null;
  const off = !s.editable;
  // The toolbar is shared with simpler editors (call notes): only offer what the schema supports.
  const hasTable = !!editor.schema.nodes.table;
  const hasCallout = !!editor.schema.nodes.blockquote?.spec.attrs && "variant" in (editor.schema.nodes.blockquote.spec.attrs ?? {});
  const run = () => editor.chain().focus();

  return (
    <div role="toolbar" aria-label="Formatting" className={cn("flex flex-wrap items-center gap-x-0.5 gap-y-1", className)}>
      <Group label="Headings">
        <ToolButton label="Heading 1" keys="Mod+Alt+1" icon={Heading1} active={s.h1} disabled={off} onClick={() => run().toggleHeading({ level: 1 }).run()} />
        <ToolButton label="Heading 2" keys="Mod+Alt+2" icon={Heading2} active={s.h2} disabled={off} onClick={() => run().toggleHeading({ level: 2 }).run()} />
        <ToolButton label="Heading 3" keys="Mod+Alt+3" icon={Heading3} active={s.h3} disabled={off} onClick={() => run().toggleHeading({ level: 3 }).run()} />
      </Group>
      <Divider />
      <Group label="Text style">
        <ToolButton label="Bold" keys="Mod+B" icon={Bold} active={s.bold} disabled={off} onClick={() => run().toggleBold().run()} />
        <ToolButton label="Italic" keys="Mod+I" icon={Italic} active={s.italic} disabled={off} onClick={() => run().toggleItalic().run()} />
        <ToolButton label="Strikethrough" keys="Mod+Shift+S" icon={Strikethrough} active={s.strike} disabled={off} onClick={() => run().toggleStrike().run()} />
        <ToolButton label="Inline code" keys="Mod+E" icon={Code} active={s.code} disabled={off} onClick={() => run().toggleCode().run()} />
        <ToolButton label="Highlight" keys="Mod+Shift+H" icon={Highlighter} active={s.highlight} disabled={off} onClick={() => run().toggleHighlight().run()} />
        {off ? (
          <ToolButton label="Link" icon={Link2} disabled onClick={() => {}} />
        ) : (
          <LinkPopover editor={editor} open={linkOpen} onOpenChange={onLinkOpenChange} />
        )}
      </Group>
      <Divider />
      <Group label="Lists">
        <ToolButton label="Bulleted list" keys="Mod+Shift+8" icon={List} active={s.bullet} disabled={off} onClick={() => run().toggleBulletList().run()} />
        <ToolButton label="Numbered list" keys="Mod+Shift+7" icon={ListOrdered} active={s.ordered} disabled={off} onClick={() => run().toggleOrderedList().run()} />
        <ToolButton label="Checklist" keys="Mod+Shift+9" icon={ListTodo} active={s.task} disabled={off} onClick={() => run().toggleTaskList().run()} />
      </Group>
      <Divider />
      <Group label="Blocks">
        <ToolButton
          label="Quote"
          keys="Mod+Shift+B"
          icon={Quote}
          active={s.quote && !s.callout}
          disabled={off}
          onClick={() =>
            !hasCallout
              ? run().toggleBlockquote().run()
              : s.quote && s.callout
                ? run().updateAttributes("blockquote", { variant: null }).run()
                : run().toggleBlockquote().updateAttributes("blockquote", { variant: null }).run()
          }
        />
        {hasCallout && (
        <ToolButton
          label="Callout"
          icon={Lightbulb}
          active={s.callout}
          disabled={off}
          onClick={() =>
            s.callout
              ? run().toggleBlockquote().run()
              : s.quote
                ? run().updateAttributes("blockquote", { variant: "callout" }).run()
                : run().toggleBlockquote().updateAttributes("blockquote", { variant: "callout" }).run()
          }
        />
        )}
        <ToolButton label="Code block" keys="Mod+Alt+C" icon={SquareCode} active={s.codeBlock} disabled={off} onClick={() => run().toggleCodeBlock().run()} />
        <ToolButton label="Divider" icon={Minus} disabled={off} onClick={() => run().setHorizontalRule().run()} />
      </Group>
      {(hasTable || onImage) && (
        <>
          <Divider />
          <Group label="Insert">
            {hasTable && (
              <ToolButton
                label="Table"
                icon={Table2}
                active={s.table}
                disabled={off || s.table}
                onClick={() => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
              />
            )}
            {onImage && <ToolButton label="Image" icon={ImageIcon} disabled={off} onClick={onImage} />}
          </Group>
        </>
      )}
      <Divider />
      <Group label="History">
        <ToolButton label="Undo" keys="Mod+Z" icon={Undo2} disabled={off || !s.canUndo} onClick={() => run().undo().run()} />
        <ToolButton label="Redo" keys="Mod+Shift+Z" icon={Redo2} disabled={off || !s.canRedo} onClick={() => run().redo().run()} />
      </Group>
    </div>
  );
}
