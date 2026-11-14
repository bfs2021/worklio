import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Extension, Mark, mergeAttributes, type AnyExtension, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Suggestion from "@tiptap/suggestion";

import type { SlashContext, SlashItem } from "./slash-items";
import { filterSlashItems } from "./slash-items";
import type { SuggestionStore } from "./suggestion-store";
import type { AwarenessUser } from "./types";
import type { CanvasSyncProvider } from "./yjs-provider";

// ---- comment anchors ----------------------------------------------------------------------------

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    comment: {
      /** Wrap the selection in a comment anchor with this id. */
      setComment: (commentId: string) => ReturnType;
    };
  }
}

/** Anchors a comment thread to a text range: `<span data-comment-id="…">`. Overlapping anchors are allowed. */
export const CommentMark = Mark.create({
  name: "comment",
  // Several threads can cover the same text.
  excludes: "",
  inclusive: false,
  spanning: true,
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs) => (attrs.commentId ? { "data-comment-id": attrs.commentId } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "canvas-comment" }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setComment:
        (commentId) =>
        ({ commands }) =>
          commands.setMark(this.name, { commentId }),
    };
  },
});

/** Remove every anchor of one comment thread from the document. */
export function removeCommentAnchor(editor: Editor, commentId: string) {
  const { state } = editor;
  const type = state.schema.marks.comment;
  if (!type) return;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type === type && m.attrs.commentId === commentId) tr.removeMark(pos, pos + node.nodeSize, m);
    }
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** Document position of a comment anchor's first character, or null if it's gone. */
export function findCommentAnchor(editor: Editor, commentId: string): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    if (node.marks.some((m) => m.type.name === "comment" && m.attrs.commentId === commentId)) {
      if (from < 0) from = pos;
      to = pos + node.nodeSize;
    }
  });
  return from < 0 ? null : { from, to };
}

// ---- callout (blockquote variant) ---------------------------------------------------------------

/** `variant: "callout"` turns a blockquote into a tinted callout box. */
const CalloutAttribute = Extension.create({
  name: "calloutAttribute",
  addGlobalAttributes() {
    return [
      {
        types: ["blockquote"],
        attributes: {
          variant: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-variant"),
            renderHTML: (attrs) => (attrs.variant ? { "data-variant": attrs.variant } : {}),
          },
        },
      },
    ];
  },
});

// ---- images -------------------------------------------------------------------------------------

/** Images remember the attachment they came from, so their (expiring) URL can be re-signed later. */
const CanvasImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs) => (attrs.attachmentId ? { "data-attachment-id": attrs.attachmentId } : {}),
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: { loading: "lazy", draggable: "true" },
});

/** Uploads images pasted or dropped into the editor (instead of embedding base64). */
const ImageDropPaste = Extension.create<{ onFiles: (files: File[], pos: number | null) => void }>({
  name: "imageDropPaste",
  addOptions() {
    return { onFiles: () => {} };
  },
  addProseMirrorPlugins() {
    const onFiles = (files: File[], pos: number | null) => this.options.onFiles(files, pos);
    const images = (list: FileList | null | undefined) =>
      Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    return [
      new Plugin({
        key: new PluginKey("canvasImageDropPaste"),
        props: {
          handlePaste: (view, event) => {
            if (!view.editable) return false;
            const files = images(event.clipboardData?.files);
            if (!files.length) return false;
            event.preventDefault();
            onFiles(files, null);
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved || !view.editable) return false;
            const files = images(event.dataTransfer?.files);
            if (!files.length) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            onFiles(files, at?.pos ?? null);
            return true;
          },
        },
      }),
    ];
  },
});

// ---- slash commands -----------------------------------------------------------------------------

const SlashCommand = Extension.create<{
  store: SuggestionStore<SlashItem> | null;
  getContext: () => SlashContext;
}>({
  name: "slashCommand",
  addOptions() {
    return { store: null, getContext: () => ({ pickImage: () => {} }) };
  },
  addProseMirrorPlugins() {
    const { store, getContext } = this.options;
    if (!store) return [];
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("canvasSlash"),
        char: "/",
        allowSpaces: false,
        startOfLine: false,
        // Not inside code, where "/" is just a character.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return !$from.parent.type.spec.code;
        },
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => props.run(editor, range, getContext()),
        render: store.renderer,
      }),
    ];
  },
});

// ---- mentions -----------------------------------------------------------------------------------

export type MentionCandidate = { id: string; label: string; detail: string };

// ---- carets -------------------------------------------------------------------------------------

function renderCaret(user: Record<string, unknown>): HTMLElement {
  const color = typeof user.color === "string" ? user.color : "#64748b";
  const caret = document.createElement("span");
  caret.className = "canvas-caret";
  caret.setAttribute(
    "style",
    `position:relative;margin-left:-1px;margin-right:-1px;border-left:2px solid ${color};word-break:normal;pointer-events:none;`,
  );
  const label = document.createElement("span");
  label.setAttribute(
    "style",
    `position:absolute;bottom:100%;left:-2px;margin-bottom:1px;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;color:#fff;background:${color};padding:3px 5px;border-radius:4px 4px 4px 0;user-select:none;pointer-events:none;`,
  );
  label.textContent = typeof user.name === "string" && user.name ? user.name : "Someone";
  caret.append(document.createTextNode("⁠"), label, document.createTextNode("⁠"));
  return caret;
}

// ---- assembly -----------------------------------------------------------------------------------

export type ExtensionOptions = {
  placeholder?: string;
  slashStore?: SuggestionStore<SlashItem>;
  mentionStore?: SuggestionStore<MentionCandidate>;
  getMentionCandidates?: (query: string) => MentionCandidate[];
  getSlashContext?: () => SlashContext;
  onFiles?: (files: File[], pos: number | null) => void;
  collab?: { provider: CanvasSyncProvider; user: AwarenessUser };
};

/** The schema-defining extensions (no collaboration); also used to build the schema for seeding. */
export function baseExtensions(o: ExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      link: false,
      // Yjs owns undo/redo (Collaboration provides the commands and shortcuts).
      undoRedo: false,
      heading: { levels: [1, 2, 3] },
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
    }),
    Highlight.configure({ multicolor: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 80 } }),
    CanvasImage,
    CalloutAttribute,
    CommentMark,
    Mention.configure({
      HTMLAttributes: { class: "canvas-mention" },
      deleteTriggerWithBackspace: true,
      renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id ?? "someone"}`,
      renderHTML: ({ options, node }) => [
        "span",
        mergeAttributes({ "data-type": "mention" }, options.HTMLAttributes, {
          "data-id": node.attrs.id,
          "data-label": node.attrs.label,
        }),
        `@${node.attrs.label ?? "someone"}`,
      ],
      suggestion: {
        char: "@",
        pluginKey: new PluginKey("canvasMention"),
        allowSpaces: true,
        items: ({ query }) => o.getMentionCandidates?.(query) ?? [],
        command: ({ editor, range, props }) => {
          // Swallow a trailing space the user may already have typed.
          const after = editor.view.state.selection.$to.nodeAfter;
          if (after?.text?.startsWith(" ")) range.to += 1;
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "mention", attrs: { id: props.id, label: props.label } },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: o.mentionStore ? o.mentionStore.renderer : undefined,
      },
    }),
  ];
}

export function buildExtensions(o: ExtensionOptions): AnyExtension[] {
  const list = [
    ...baseExtensions(o),
    Placeholder.configure({
      placeholder: ({ node, pos }) =>
        node.type.name === "heading"
          ? `Heading ${node.attrs.level}`
          : pos === 0
            ? o.placeholder ?? "Type '/' for commands, '@' to mention someone…"
            : "Type '/' for commands",
      showOnlyCurrent: true,
      includeChildren: false,
    }),
    SlashCommand.configure({
      store: o.slashStore ?? null,
      getContext: o.getSlashContext ?? (() => ({ pickImage: () => {} })),
    }),
    ImageDropPaste.configure({ onFiles: o.onFiles ?? (() => {}) }),
  ];
  if (o.collab) {
    list.push(
      Collaboration.configure({ document: o.collab.provider.doc, field: "default" }),
      CollaborationCaret.configure({
        provider: o.collab.provider,
        user: o.collab.user,
        render: renderCaret,
      }),
    );
  }
  return list;
}
