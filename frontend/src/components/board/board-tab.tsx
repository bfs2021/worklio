"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { KanbanSquare, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  boardLabels,
  cardMatches,
  facetCounts,
  filtersActive,
  listsApi,
  newId,
  useListPrefs,
  writeListPrefs,
  type ListView,
} from "@/lib/lists";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { CardView } from "./board-card";
import { BoardColumnView, COLUMN_SORT_PREFIX, ColumnGhost, columnSortId } from "./board-column";
import { CardDialog } from "./card-dialog";
import { FieldsDialog } from "./fields-dialog";
import { TableView } from "./table-view";
import { BoardToolbar } from "./toolbar";
import {
  EMPTY_FILTERS,
  MAX_SUBTASKS,
  type Board,
  type BoardActions,
  type BoardCard,
  type BoardColumn,
  type BoardFilters,
  type BoardUpdatedEvent,
  type CardPatch,
  type ColumnPatch,
  type FieldDef,
  type NewCard,
  type NewCardExtra,
  type Subtask,
} from "./types";
import { byPosition, columnCards, normalizeBoard, normalizeCard, positionBetween, useToday } from "./utils";

const COLUMN_PREFIX = "column:";
const isTemp = (id: string) => id.startsWith("tmp-");
const tempId = () => `tmp-${newId()}`;
const isColumnSortId = (id: UniqueIdentifier) => String(id).startsWith(COLUMN_SORT_PREFIX);

type Order = Record<string, string[]>; // columnId -> card ids, in display order

/** Merge a card patch locally (field values merge by key; null clears). */
function applyCardPatch(c: BoardCard, patch: CardPatch): BoardCard {
  const { fields, ...rest } = patch;
  const next: BoardCard = { ...c, ...rest };
  if (fields) {
    const merged = { ...c.fields };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    next.fields = merged;
  }
  return next;
}

/** Collision detection that keeps column reordering and card moving apart. */
const collisionDetection: CollisionDetection = (args) => {
  const columnDrag = isColumnSortId(args.active.id);
  const droppableContainers = args.droppableContainers.filter((c) => isColumnSortId(c.id) === columnDrag);
  return columnDrag ? closestCenter({ ...args, droppableContainers }) : closestCorners({ ...args, droppableContainers });
};

/** Keyboard dragging, scoped the same way (cards never target columns' sortable nodes, and vice versa). */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const columnDrag = isColumnSortId(args.active);
  const all = args.context.droppableContainers;
  const keep = (c: DroppableContainer | undefined) => !!c && isColumnSortId(c.id) === columnDrag;
  const scoped = {
    getEnabled: () => all.getEnabled().filter(keep),
    get: (id: UniqueIdentifier | null | undefined) => all.get(id),
    toArray: () => all.toArray().filter(keep),
    getNodeFor: (id: UniqueIdentifier | null | undefined) => all.getNodeFor(id),
  } as unknown as typeof all;
  return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: scoped } });
};

/**
 * Lists for a channel (GET /channels/{id}/board): a Kanban board and a spreadsheet-like table
 * over the same data, with custom fields, subtasks, comments and live updates.
 * Mount inside <WorkspaceProvider>; pass `readOnly` for archived channels.
 */
export function BoardTab({
  channelId,
  readOnly = false,
  initialCardId = null,
}: {
  channelId: string;
  readOnly?: boolean;
  /** Open this card's detail dialog once the board has loaded (deep link). */
  initialCardId?: string | null;
}) {
  // Keyed so every piece of local state (drag, filters, open card) resets when switching channels.
  return <BoardInner key={channelId} channelId={channelId} readOnly={readOnly} initialCardId={initialCardId} />;
}

function BoardInner({
  channelId,
  readOnly,
  initialCardId,
}: {
  channelId: string;
  readOnly: boolean;
  initialCardId: string | null;
}) {
  const { me, members, memberById } = useWorkspace();
  const today = useToday();
  const prefs = useListPrefs(channelId);
  const view: ListView = prefs.view;

  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [openCardId, setOpenCardId] = useState<string | null>(initialCardId);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<Order | null>(null);

  // Concurrency bookkeeping (only touched from handlers/effects, never during render).
  const boardRef = useRef<Board | null>(null);
  const openCardRef = useRef<string | null>(null);
  const inflight = useRef(0);
  const dragging = useRef(false);
  const stale = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    boardRef.current = board;
    openCardRef.current = openCardId;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Initial load (and retries).
  useEffect(() => {
    let live = true;
    api<Board>(`/channels/${channelId}/board`)
      .then((b) => {
        if (!live) return;
        setBoard(normalizeBoard(b));
        setError("");
      })
      .catch((err) => live && setError(errorMessage(err, "Couldn't load the board")));
    return () => {
      live = false;
    };
  }, [channelId, attempt]);

  /** Apply a server board unless the user is mid-drag or has writes in flight; then defer to a refetch. */
  const applyServer = useCallback((b: Board) => {
    if (dragging.current || inflight.current > 0) {
      stale.current = true;
      return;
    }
    setBoard(normalizeBoard(b));
  }, []);

  const refresh = useCallback(() => {
    api<Board>(`/channels/${channelId}/board`)
      .then((b) => mounted.current && applyServer(b))
      .catch(() => {});
  }, [channelId, applyServer]);

  /** Called whenever the board becomes idle: catch up on anything we deferred. */
  const settle = useCallback(() => {
    if (inflight.current === 0 && !dragging.current && stale.current) {
      stale.current = false;
      refresh();
    }
  }, [refresh]);

  useWorkspaceEvents((e) => {
    const ev = e as unknown as { type: string };
    if (ev.type === "resync") {
      stale.current = true;
      settle();
      return;
    }
    if (ev.type !== "board.updated") return;
    const { channel_id, board: next } = ev as BoardUpdatedEvent;
    if (channel_id !== channelId) return;
    const open = openCardRef.current;
    if (open && !isTemp(open) && !next.cards.some((c) => c.id === open)) {
      setOpenCardId(null);
      toast.info("The card you were viewing was deleted.");
    }
    applyServer(next);
  });

  /** Optimistic write: apply locally, send, roll back + toast on failure. */
  const run = useCallback(
    async <T,>(optimistic: (b: Board) => Board, request: () => Promise<T>, failure: string, onOk?: (res: T) => void) => {
      const snapshot = boardRef.current;
      setBoard((b) => b && optimistic(b));
      inflight.current++;
      try {
        const res = await request();
        if (mounted.current) onOk?.(res);
      } catch (err) {
        if (mounted.current) {
          if (snapshot) setBoard(snapshot);
          toast.error(`${failure}: ${errorMessage(err)}`);
        }
        stale.current = true; // re-sync with the server once idle
      } finally {
        inflight.current--;
        if (mounted.current) settle();
      }
    },
    [settle],
  );

  // --- Card mutations ---------------------------------------------------------

  const mapCard = (id: string, fn: (c: BoardCard) => BoardCard) => (b: Board) => ({
    ...b,
    cards: b.cards.map((c) => (c.id === id ? fn(c) : c)).sort(byPosition),
  });

  function endPosition(b: Board, columnId: string, excludeId?: string) {
    const last = columnCards(b, columnId)
      .filter((c) => c.id !== excludeId)
      .at(-1);
    return positionBetween(last?.position, undefined);
  }

  function updateCard(card: BoardCard, patch: CardPatch, failure = "Couldn't update card") {
    if (isTemp(card.id) || readOnly) return;
    const b = boardRef.current;
    const full: CardPatch = { ...patch };
    // Moving to another column without an explicit position lands at its end.
    if (patch.column_id && patch.column_id !== card.column_id && patch.position === undefined && b) {
      full.position = endPosition(b, patch.column_id, card.id);
    }
    run(
      mapCard(card.id, (c) => applyCardPatch(c, full)),
      () => api<BoardCard>(`/board/cards/${card.id}`, { method: "PATCH", body: JSON.stringify(full) }),
      failure,
      (server) => server && setBoard((bd) => bd && mapCard(card.id, () => normalizeCard(server))(bd)),
    );
  }

  function deleteCard(card: BoardCard) {
    setOpenCardId(null);
    run(
      (b) => ({ ...b, cards: b.cards.filter((c) => c.id !== card.id) }),
      () => api<void>(`/board/cards/${card.id}`, { method: "DELETE" }),
      "Couldn't delete card",
    );
  }

  function addCard(columnId: string, title: string, extra: NewCardExtra = {}) {
    const b = boardRef.current;
    if (!b || readOnly) return;
    const id = tempId();
    const now = new Date().toISOString();
    const temp: BoardCard = normalizeCard({
      id,
      column_id: columnId,
      title,
      description: null,
      assignee_id: extra.assignee_id ?? null,
      due_date: null,
      labels: extra.labels ?? [],
      position: endPosition(b, columnId),
      completed: false,
      created_by: me?.id ?? "",
      created_at: now,
      updated_at: now,
      priority: extra.priority ?? "none",
      subtasks: [],
      fields: {},
      comment_count: 0,
      cover_color: null,
    });
    const body: NewCard = { column_id: columnId, title };
    if (extra.assignee_id) body.assignee_id = extra.assignee_id;
    if (extra.labels?.length) body.labels = extra.labels;
    run(
      (bd) => ({ ...bd, cards: [...bd.cards, temp].sort(byPosition) }),
      () => api<BoardCard>(`/channels/${channelId}/board/cards`, { method: "POST", body: JSON.stringify(body) }),
      "Couldn't add card",
      (server) => {
        const saved = normalizeCard(server);
        setBoard(
          (bd) =>
            bd && {
              ...bd,
              cards: bd.cards
                .filter((c) => c.id !== saved.id)
                .map((c) => (c.id === id ? { ...saved, priority: extra.priority ?? saved.priority } : c))
                .sort(byPosition),
            },
        );
        if (openCardRef.current === id) setOpenCardId(saved.id);
        // Priority isn't part of the create payload: set it right after.
        if (extra.priority && extra.priority !== saved.priority) updateCard(saved, { priority: extra.priority });
      },
    );
  }

  // --- Field values -------------------------------------------------------------

  const setField: BoardActions["setField"] = (card, field, value) =>
    updateCard(card, { fields: { [field.id]: value } }, `Couldn't update ${field.name}`);

  // --- Subtasks -----------------------------------------------------------------

  const mapSubtasks = (cardId: string, fn: (s: Subtask[]) => Subtask[]) =>
    mapCard(cardId, (c) => ({ ...c, subtasks: fn(c.subtasks).sort(byPosition) }));

  function addSubtask(card: BoardCard, title: string, assigneeId: string | null = null) {
    if (isTemp(card.id) || readOnly) return;
    if (card.subtasks.length >= MAX_SUBTASKS) return toast.info(`A card can have up to ${MAX_SUBTASKS} subtasks.`);
    const id = tempId();
    const temp: Subtask = { id, title, done: false, assignee_id: assigneeId, position: positionBetween(card.subtasks.at(-1)?.position, undefined) };
    run(
      mapSubtasks(card.id, (s) => [...s, temp]),
      () => listsApi.addSubtask(card.id, { title, ...(assigneeId ? { assignee_id: assigneeId } : {}) }),
      "Couldn't add subtask",
      (saved) => saved && setBoard((b) => b && mapSubtasks(card.id, (s) => s.filter((x) => x.id !== saved.id).map((x) => (x.id === id ? saved : x)))(b)),
    );
  }

  function updateSubtask(card: BoardCard, subtask: Subtask, patch: Partial<Subtask>) {
    if (isTemp(subtask.id) || readOnly) return;
    run(
      mapSubtasks(card.id, (s) => s.map((x) => (x.id === subtask.id ? { ...x, ...patch } : x))),
      () => listsApi.updateSubtask(subtask.id, patch),
      "Couldn't update subtask",
      (saved) => saved && setBoard((b) => b && mapSubtasks(card.id, (s) => s.map((x) => (x.id === saved.id ? saved : x)))(b)),
    );
  }

  function deleteSubtask(card: BoardCard, subtask: Subtask) {
    if (isTemp(subtask.id) || readOnly) return;
    run(
      mapSubtasks(card.id, (s) => s.filter((x) => x.id !== subtask.id)),
      () => listsApi.deleteSubtask(subtask.id),
      "Couldn't delete subtask",
    );
  }

  function moveSubtask(card: BoardCard, subtaskId: string, toIndex: number) {
    const list = card.subtasks;
    const from = list.findIndex((s) => s.id === subtaskId);
    if (from < 0 || from === toIndex) return;
    const reordered = arrayMove(list, from, toIndex);
    const i = reordered.findIndex((s) => s.id === subtaskId);
    const position = positionBetween(reordered[i - 1]?.position, reordered[i + 1]?.position);
    updateSubtask(card, list[from], { position });
  }

  // --- Fields -------------------------------------------------------------------

  const mapFields = (fn: (f: FieldDef[]) => FieldDef[]) => (b: Board) => ({ ...b, fields: fn(b.fields).sort(byPosition) });

  const createField: BoardActions["createField"] = (body) => {
    const b = boardRef.current;
    if (!b || readOnly) return;
    const id = tempId();
    const temp: FieldDef = { id, name: body.name, type: body.type, options: body.options ?? [], position: positionBetween(b.fields.at(-1)?.position, undefined) };
    run(
      mapFields((f) => [...f, temp]),
      () => listsApi.createField(channelId, body),
      "Couldn't create field",
      (saved) => {
        if (saved) setBoard((bd) => bd && mapFields((f) => f.filter((x) => x.id !== saved.id).map((x) => (x.id === id ? { ...saved, options: saved.options ?? [] } : x)))(bd));
        toast.success(`Field “${body.name}” added.`);
      },
    );
  };

  const updateField: BoardActions["updateField"] = (field, patch) => {
    if (isTemp(field.id) || readOnly) return;
    run(
      mapFields((f) => f.map((x) => (x.id === field.id ? { ...x, ...patch } : x))),
      () => listsApi.updateField(field.id, patch),
      `Couldn't update ${field.name}`,
      (saved) => saved && setBoard((b) => b && mapFields((f) => f.map((x) => (x.id === saved.id ? { ...saved, options: saved.options ?? [] } : x)))(b)),
    );
  };

  const deleteField: BoardActions["deleteField"] = (field) => {
    if (isTemp(field.id) || readOnly) return;
    run(
      (b) => ({
        ...b,
        fields: b.fields.filter((x) => x.id !== field.id),
        cards: b.cards.map((c) => {
          if (!(field.id in c.fields)) return c;
          const fields = { ...c.fields };
          delete fields[field.id];
          return { ...c, fields };
        }),
      }),
      () => listsApi.deleteField(field.id),
      `Couldn't delete ${field.name}`,
    );
  };

  const moveField: BoardActions["moveField"] = (field, dir) => {
    const list = boardRef.current?.fields ?? [];
    const i = list.findIndex((f) => f.id === field.id);
    if (i < 0 || !list[i + dir]) return;
    const position =
      dir === -1 ? positionBetween(list[i - 2]?.position, list[i - 1]?.position) : positionBetween(list[i + 1]?.position, list[i + 2]?.position);
    updateField(field, { position });
  };

  // --- Column mutations -------------------------------------------------------

  function updateColumn(col: BoardColumn, patch: ColumnPatch, failure = "Couldn't update column") {
    if (isTemp(col.id)) return;
    run(
      (b) => ({ ...b, columns: b.columns.map((c) => (c.id === col.id ? { ...c, ...patch } : c)).sort(byPosition) }),
      () => api<BoardColumn>(`/board/columns/${col.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
      failure,
      (server) => setBoard((b) => b && { ...b, columns: b.columns.map((c) => (c.id === col.id ? server : c)).sort(byPosition) }),
    );
  }

  /** Persist a full column order (POST /board/columns/reorder). */
  function reorderColumns(ids: string[]) {
    if (readOnly || ids.some(isTemp)) return;
    run(
      (b) => {
        const byId = new Map(b.columns.map((c) => [c.id, c]));
        const ordered = ids.map((id) => byId.get(id)).filter((c): c is BoardColumn => !!c);
        return { ...b, columns: ordered.map((c, i) => ({ ...c, position: i + 1 })) };
      },
      () => listsApi.reorderColumns(ids),
      "Couldn't reorder columns",
    );
  }

  function moveColumn(col: BoardColumn, dir: -1 | 1) {
    const ids = (boardRef.current?.columns ?? []).map((c) => c.id);
    const i = ids.indexOf(col.id);
    if (i < 0 || i + dir < 0 || i + dir >= ids.length) return;
    reorderColumns(arrayMove(ids, i, i + dir));
  }

  function deleteColumn(col: BoardColumn) {
    run(
      (b) => ({ ...b, columns: b.columns.filter((c) => c.id !== col.id), cards: b.cards.filter((c) => c.column_id !== col.id) }),
      () => api<void>(`/board/columns/${col.id}`, { method: "DELETE" }),
      "Couldn't delete column",
    );
  }

  function addColumn(name: string) {
    const b = boardRef.current;
    if (!b) return;
    const id = tempId();
    const temp: BoardColumn = { id, name, color: null, position: positionBetween(b.columns.at(-1)?.position, undefined) };
    run(
      (bd) => ({ ...bd, columns: [...bd.columns, temp] }),
      () => api<BoardColumn>(`/channels/${channelId}/board/columns`, { method: "POST", body: JSON.stringify({ name }) }),
      "Couldn't add column",
      (server) =>
        setBoard((bd) => bd && { ...bd, columns: bd.columns.filter((c) => c.id !== server.id).map((c) => (c.id === id ? server : c)).sort(byPosition) }),
    );
  }

  const actions: BoardActions = {
    updateCard,
    setField,
    addCard,
    deleteCard,
    toggleComplete: (card) => updateCard(card, { completed: !card.completed }),
    openCard: (id) => !isTemp(id) && setOpenCardId(id),
    addSubtask,
    updateSubtask,
    deleteSubtask,
    moveSubtask,
    createField,
    updateField,
    deleteField,
    moveField,
    bumpCommentCount: (cardId, delta) =>
      setBoard((b) => b && mapCard(cardId, (c) => ({ ...c, comment_count: Math.max(0, c.comment_count + delta) }))(b)),
  };

  // --- Drag and drop ----------------------------------------------------------

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      // Enter is reserved for opening a card.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  if (error && !board) {
    return (
      <div className="m-auto max-w-xs p-8 text-center">
        <KanbanSquare className="mx-auto mb-3 size-10 text-muted-foreground" />
        <p className="font-bold">Couldn&apos;t load the board</p>
        <p className="mb-3 text-sm text-muted-foreground">{error}</p>
        <Button
          variant="outline"
          onClick={() => {
            setError("");
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!board) return <BoardSkeleton />;

  const cardById = new Map(board.cards.map((c) => [c.id, c]));
  const columnById = new Map(board.columns.map((c) => [c.id, c]));
  const filtered = filtersActive(filters);
  const matching = board.cards.filter((c) => cardMatches(c, filters, today));
  const matchingIds = new Set(matching.map((c) => c.id));
  const counts = facetCounts(board.cards, filters, today);
  const labels = boardLabels(board);
  const visibleOrder: Order = {};
  const totals: Record<string, number> = {};
  for (const col of board.columns) {
    const all = columnCards(board, col.id);
    totals[col.id] = all.length;
    visibleOrder[col.id] = all.filter((c) => matchingIds.has(c.id)).map((c) => c.id);
  }
  const order = dragOrder ?? visibleOrder;
  const activeIsColumn = !!activeId && isColumnSortId(activeId);
  const activeCard = activeId && !activeIsColumn ? cardById.get(activeId) : undefined;
  const activeColumn = activeIsColumn ? columnById.get(activeId.slice(COLUMN_SORT_PREFIX.length)) : undefined;
  const openCard = openCardId ? (cardById.get(openCardId) ?? null) : null;

  const containerOf = (o: Order, id: UniqueIdentifier): string | undefined => {
    const s = String(id);
    if (s.startsWith(COLUMN_PREFIX)) return s.slice(COLUMN_PREFIX.length);
    return Object.keys(o).find((col) => o[col].includes(s));
  };

  function onDragStart({ active }: DragStartEvent) {
    dragging.current = true;
    setActiveId(String(active.id));
    if (!isColumnSortId(active.id)) setDragOrder(visibleOrder);
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || isColumnSortId(active.id)) return;
    setDragOrder((prev) => {
      if (!prev) return prev;
      const from = containerOf(prev, active.id);
      const to = containerOf(prev, over.id);
      if (!from || !to || from === to) return prev;
      const id = String(active.id);
      const target = prev[to];
      const overIndex = target.indexOf(String(over.id));
      const translated = active.rect.current.translated;
      const below = translated && translated.top > over.rect.top + over.rect.height / 2;
      const index = overIndex < 0 ? target.length : overIndex + (below ? 1 : 0);
      return {
        ...prev,
        [from]: prev[from].filter((x) => x !== id),
        [to]: [...target.slice(0, index), id, ...target.slice(index)],
      };
    });
  }

  function endDrag() {
    dragging.current = false;
    setActiveId(null);
    setDragOrder(null);
  }

  function onColumnDragEnd(activeKey: UniqueIdentifier, overKey: UniqueIdentifier | undefined) {
    if (!board || overKey === undefined || !isColumnSortId(overKey) || activeKey === overKey) return settle();
    const ids = board.columns.map((c) => c.id);
    const from = ids.indexOf(String(activeKey).slice(COLUMN_SORT_PREFIX.length));
    const to = ids.indexOf(String(overKey).slice(COLUMN_SORT_PREFIX.length));
    if (from < 0 || to < 0) return settle();
    reorderColumns(arrayMove(ids, from, to));
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const current = dragOrder;
    endDrag();
    if (isColumnSortId(active.id)) return onColumnDragEnd(active.id, over?.id);
    const card = cardById.get(String(active.id));
    const to = over && current ? containerOf(current, over.id) : undefined;
    if (!card || !current || !over || !to || isTemp(card.id) || isTemp(to)) return settle();

    let ids = current[to];
    const oldIndex = ids.indexOf(card.id);
    const overIndex = String(over.id).startsWith(COLUMN_PREFIX) ? ids.length - 1 : ids.indexOf(String(over.id));
    if (oldIndex >= 0 && overIndex >= 0 && oldIndex !== overIndex) ids = arrayMove(ids, oldIndex, overIndex);
    const index = ids.indexOf(card.id);
    const unchanged = to === card.column_id && visibleOrder[to].indexOf(card.id) === index;
    if (index < 0 || unchanged) return settle();

    const before = cardById.get(ids[index - 1] ?? "")?.position;
    const after = cardById.get(ids[index + 1] ?? "")?.position;
    const patch: CardPatch = { position: positionBetween(before, after) };
    if (to !== card.column_id) patch.column_id = to;
    updateCard(card, patch, "Couldn't move card");
  }

  function onDragCancel() {
    endDrag();
    settle();
  }

  const titleOf = (id: UniqueIdentifier) =>
    isColumnSortId(id)
      ? `column ${columnById.get(String(id).slice(COLUMN_SORT_PREFIX.length))?.name ?? ""}`
      : `card ${cardById.get(String(id))?.title ?? ""}`;
  const placeOf = (id: UniqueIdentifier | undefined) => {
    if (id === undefined) return "";
    if (isColumnSortId(id)) {
      const i = board.columns.findIndex((c) => columnSortId(c.id) === String(id));
      return i >= 0 ? `position ${i + 1} of ${board.columns.length}` : "";
    }
    const col = dragOrder ? containerOf(dragOrder, id) : undefined;
    return (col && columnById.get(col)?.name) ?? "a column";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${titleOf(active.id)} is over ${placeOf(over.id)}.` : `${titleOf(active.id)} is no longer over a drop target.`),
    onDragEnd: ({ active, over }) => (over ? `${titleOf(active.id)} was dropped at ${placeOf(over.id)}.` : `${titleOf(active.id)} was dropped.`),
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  };

  const setView = (v: ListView) => writeListPrefs(channelId, { view: v });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardToolbar
        view={view}
        onViewChange={setView}
        filters={filters}
        setFilters={setFilters}
        counts={counts}
        members={members}
        memberById={memberById}
        me={me}
        labels={labels}
        visible={matching.length}
        total={board.cards.length}
        canManageFields={!readOnly}
        onManageFields={() => setFieldsOpen(true)}
        fieldCount={board.fields.length}
      />

      {view === "table" ? (
        <TableView
          channelId={channelId}
          board={board}
          cards={matching}
          prefs={prefs}
          members={members}
          memberById={memberById}
          meId={me?.id}
          today={today}
          readOnly={readOnly}
          labels={labels}
          filtered={filtered}
          actions={actions}
          onClearFilters={() => setFilters(EMPTY_FILTERS)}
          onManageFields={() => setFieldsOpen(true)}
        />
      ) : (
        <>
          {board.cards.length === 0 && !readOnly && (
            <p className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[13px] text-muted-foreground sm:mx-5">
              <KanbanSquare className="size-4 shrink-0" />
              Track this channel&apos;s work here. Add a card to any column, then drag it along as it moves forward.
            </p>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
            accessibility={{
              announcements,
              screenReaderInstructions: {
                draggable:
                  "To move a card or column, press Space to pick it up, use the arrow keys to move it, then press Space again to drop it. Press Escape to cancel. Press Enter to open a card.",
              },
            }}
          >
            <div
              className={cn(
                "flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-3 items-start gap-3 overflow-x-auto overscroll-x-contain px-3 py-3 sm:snap-none sm:gap-4 sm:px-5",
                activeId && "snap-none",
              )}
              role="region"
              aria-label="Board columns"
            >
              <SortableContext items={board.columns.map((c) => columnSortId(c.id))} strategy={horizontalListSortingStrategy}>
                {board.columns.map((col, i) => (
                  <BoardColumnView
                    key={col.id}
                    column={col}
                    cards={(order[col.id] ?? []).map((id) => cardById.get(id)).filter((c): c is BoardCard => !!c)}
                    totalCount={totals[col.id] ?? 0}
                    memberById={memberById}
                    fields={board.fields}
                    today={today}
                    readOnly={readOnly || isTemp(col.id)}
                    canReorder={!readOnly && !isTemp(col.id) && board.columns.length > 1}
                    filtered={filtered}
                    isFirst={i === 0}
                    isLast={i === board.columns.length - 1}
                    onRename={(name) => updateColumn(col, { name }, "Couldn't rename column")}
                    onRecolor={(color) => updateColumn(col, { color })}
                    onDelete={() => deleteColumn(col)}
                    onMove={(dir) => moveColumn(col, dir)}
                    onAddCard={(title) => addCard(col.id, title)}
                    onOpenCard={(c) => actions.openCard(c.id)}
                    onToggleComplete={actions.toggleComplete}
                  />
                ))}
              </SortableContext>
              {!readOnly && <AddColumn onAdd={addColumn} />}
              <div className="w-px shrink-0" aria-hidden />
            </div>

            <DragOverlay>
              {activeCard ? (
                <CardView
                  card={activeCard}
                  assignee={activeCard.assignee_id ? memberById[activeCard.assignee_id] : undefined}
                  fields={board.fields}
                  memberById={memberById}
                  today={today}
                  overlay
                />
              ) : activeColumn ? (
                <ColumnGhost column={activeColumn} count={totals[activeColumn.id] ?? 0} />
              ) : null}
            </DragOverlay>
          </DndContext>
        </>
      )}

      <CardDialog
        card={openCard}
        columns={board.columns}
        fields={board.fields}
        labels={labels}
        members={members}
        memberById={memberById}
        meId={me?.id}
        readOnly={readOnly}
        actions={actions}
        onClose={() => setOpenCardId(null)}
        onManageFields={readOnly ? undefined : () => setFieldsOpen(true)}
      />
      {!readOnly && (
        <FieldsDialog open={fieldsOpen} onOpenChange={setFieldsOpen} fields={board.fields} cards={board.cards} actions={actions} />
      )}
    </div>
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 w-[min(280px,calc(100vw-3.5rem))] shrink-0 snap-start items-center gap-1.5 rounded-xl border border-dashed px-3 text-[13px] font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Plus className="size-4" /> Add column
      </button>
    );
  }

  function submit() {
    const n = name.trim();
    if (n) onAdd(n.slice(0, 60));
    setName("");
    if (!n) setOpen(false);
  }

  return (
    <form
      className="w-[min(280px,calc(100vw-3.5rem))] shrink-0 snap-start rounded-xl bg-muted/60 p-2 dark:bg-muted/30"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        value={name}
        maxLength={60}
        placeholder="Column name"
        aria-label="New column name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
            setName("");
          }
        }}
        className="h-8 bg-background"
      />
      <div className="mt-2 flex gap-1.5">
        <Button type="submit" size="sm" className="bg-send text-white hover:bg-send/90" disabled={!name.trim()}>
          Add column
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setName("");
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" aria-label="Loading board">
      <div className="flex items-center gap-2 border-b px-3 py-2 sm:px-5">
        <div className="h-8 w-32 animate-pulse rounded-lg bg-muted" />
        <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="h-8 w-24 animate-pulse rounded-lg bg-muted max-sm:hidden" />
      </div>
      <div className="flex gap-3 overflow-hidden px-3 py-3 sm:gap-4 sm:px-5">
        {[3, 2, 1].map((n, i) => (
          <div key={i} className="w-[min(280px,calc(100vw-3.5rem))] shrink-0 space-y-2 rounded-xl bg-muted/60 p-2 dark:bg-muted/30">
            <div className="h-5 w-24 animate-pulse rounded bg-muted-foreground/15" />
            {Array.from({ length: n }, (_, j) => (
              <div key={j} className="h-16 animate-pulse rounded-lg bg-background/80" />
            ))}
          </div>
        ))}
      </div>
      <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}
