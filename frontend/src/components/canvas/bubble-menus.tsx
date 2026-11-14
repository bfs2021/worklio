"use client";

import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  Code,
  Highlighter,
  Italic,
  Link2,
  MessageSquarePlus,
  PanelTop,
  Strikethrough,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { LinkForm, ToolButton } from "./toolbar";

const SURFACE =
  "flex items-center gap-0.5 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/5";

function Sep() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

/** Floating formatting bar over a text selection: marks, link, highlight and "Comment". */
export function TextBubbleMenu({
  editor,
  onComment,
  canComment,
}: {
  editor: Editor;
  onComment: () => void;
  canComment: boolean;
}) {
  const [linkMode, setLinkMode] = useState(false);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      link: e.isActive("link"),
      editable: e.isEditable,
    }),
  });

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="canvasTextBubble"
      updateDelay={120}
      options={{ placement: "top", offset: 8, flip: true, shift: { padding: 8 }, onHide: () => setLinkMode(false) }}
      shouldShow={({ editor: e, state, from, to }) => {
        if (from === to || !e.isEditable) return false;
        if (state.selection instanceof NodeSelection) return false;
        if (e.isActive("codeBlock") || e.isActive("image")) return false;
        // Whitespace-only selections (e.g. a triple-click on an empty line) don't need a menu.
        return state.doc.textBetween(from, to, " ").trim().length > 0;
      }}
      className="z-40"
    >
      {linkMode ? (
        <div className={cn(SURFACE, "w-[min(20rem,calc(100vw-1.5rem))] p-3")}>
          <div className="w-full">
            <LinkForm editor={editor} idPrefix="canvas-bubble-link" onDone={() => setLinkMode(false)} />
          </div>
        </div>
      ) : (
        <div role="toolbar" aria-label="Selection formatting" className={SURFACE}>
          {s?.editable && (
            <>
              <ToolButton label="Bold" keys="Mod+B" icon={Bold} active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
              <ToolButton label="Italic" keys="Mod+I" icon={Italic} active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
              <ToolButton
                label="Strikethrough"
                keys="Mod+Shift+S"
                icon={Strikethrough}
                active={s.strike}
                onClick={() => editor.chain().focus().toggleStrike().run()}
              />
              <ToolButton label="Inline code" keys="Mod+E" icon={Code} active={s.code} onClick={() => editor.chain().focus().toggleCode().run()} />
              <ToolButton label="Link" keys="Mod+K" icon={Link2} active={s.link} onClick={() => setLinkMode(true)} />
              <ToolButton
                label="Highlight"
                keys="Mod+Shift+H"
                icon={Highlighter}
                active={s.highlight}
                onClick={() => editor.chain().focus().toggleHighlight().run()}
              />
            </>
          )}
          {canComment && (
            <>
              {s?.editable && <Sep />}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onComment}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <MessageSquarePlus className="size-4" aria-hidden /> Comment
              </button>
            </>
          )}
        </div>
      )}
    </BubbleMenu>
  );
}

/** Small custom glyphs: a row / column with a minus, clearer than generic trash icons. */
function RowMinus({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="8" width="18" height="8" rx="1.5" />
      <path d="M9 12h6" />
    </svg>
  );
}

function ColMinus({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="8" y="3" width="8" height="18" rx="1.5" />
      <path d="M10 12h4" />
    </svg>
  );
}

function tableElement(editor: Editor): HTMLElement | null {
  const { state, view } = editor;
  const $pos = state.selection.$from;
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name !== "table") continue;
    const dom = view.nodeDOM($pos.before(d));
    if (!(dom instanceof HTMLElement)) return null;
    return dom.tagName === "TABLE" ? dom : (dom.querySelector("table") ?? dom);
  }
  return null;
}

/** Row/column controls shown above a table while the cursor is inside it. */
export function TableBubbleMenu({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canAddRow: e.can().addRowAfter(),
      canDeleteRow: e.can().deleteRow(),
      canAddCol: e.can().addColumnAfter(),
      canDeleteCol: e.can().deleteColumn(),
      canHeader: e.can().toggleHeaderRow(),
    }),
  });
  const run = () => editor.chain().focus();

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="canvasTableBubble"
      updateDelay={60}
      options={{ placement: "top-start", offset: 6, flip: true, shift: { padding: 8 } }}
      getReferencedVirtualElement={() => {
        const el = tableElement(editor);
        if (!el) return null;
        return { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects() };
      }}
      shouldShow={({ editor: e, from, to }) => e.isEditable && from === to && e.isActive("table")}
      className="z-30"
    >
      <div role="toolbar" aria-label="Table" className={cn(SURFACE, "flex-wrap")}>
        <ToolButton label="Insert row above" icon={BetweenHorizontalStart} disabled={!s?.canAddRow} onClick={() => run().addRowBefore().run()} />
        <ToolButton label="Insert row below" icon={BetweenHorizontalEnd} disabled={!s?.canAddRow} onClick={() => run().addRowAfter().run()} />
        <ToolButton
          label="Delete row"
          icon={RowMinus}
          disabled={!s?.canDeleteRow}
          onClick={() => run().deleteRow().run()}
        />
        <Sep />
        <ToolButton label="Insert column left" icon={BetweenVerticalStart} disabled={!s?.canAddCol} onClick={() => run().addColumnBefore().run()} />
        <ToolButton label="Insert column right" icon={BetweenVerticalEnd} disabled={!s?.canAddCol} onClick={() => run().addColumnAfter().run()} />
        <ToolButton
          label="Delete column"
          icon={ColMinus}
          disabled={!s?.canDeleteCol}
          onClick={() => run().deleteColumn().run()}
        />
        <Sep />
        <ToolButton label="Toggle header row" icon={PanelTop} disabled={!s?.canHeader} onClick={() => run().toggleHeaderRow().run()} />
        <ToolButton label="Delete table" icon={Trash2} onClick={() => run().deleteTable().run()} />
      </div>
    </BubbleMenu>
  );
}
