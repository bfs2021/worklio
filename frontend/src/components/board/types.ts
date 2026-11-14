/** Board / Lists v2 types — mirror the shared API contract. */

export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export type FieldType = "text" | "number" | "select" | "multi_select" | "person" | "date" | "checkbox" | "url";

export type FieldOption = { id: string; label: string; color: string };

export type FieldDef = {
  id: string;
  name: string;
  type: FieldType;
  /** Only meaningful for select / multi_select. */
  options: FieldOption[];
  position: number;
};

/**
 * A custom field value, by field type:
 * text/url → string · number → number · select/person → id string · multi_select → id[] ·
 * date → "YYYY-MM-DD" · checkbox → boolean.
 */
export type FieldValue = string | number | boolean | string[] | null;

export type Subtask = {
  id: string;
  title: string;
  done: boolean;
  assignee_id: string | null;
  position: number;
};

export type BoardCard = {
  id: string;
  column_id: string;
  title: string;
  description: string | null;
  assignee_id: string | null;
  /** "YYYY-MM-DD" */
  due_date: string | null;
  labels: string[];
  position: number;
  completed: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  priority: Priority;
  subtasks: Subtask[];
  /** field_id → value; absent/null = empty. */
  fields: Record<string, FieldValue>;
  comment_count: number;
  cover_color: string | null;
};

export type BoardColumn = {
  id: string;
  name: string;
  position: number;
  color: string | null;
};

export type Board = {
  id: string;
  channel_id: string;
  columns: BoardColumn[];
  cards: BoardCard[];
  fields: FieldDef[];
};

export type BoardUpdatedEvent = { type: "board.updated"; channel_id: string; board: Board };
export type BoardCommentsUpdatedEvent = { type: "board.comments.updated"; card_id: string; channel_id?: string };

export type CardComment = {
  id: string;
  card_id: string;
  author_id: string | null;
  /** Mentions are stored as `<@user_id>`. */
  body: string;
  created_at: string;
  updated_at?: string | null;
  /** Set by the server when the body was edited. */
  edited_at?: string | null;
};

export type CardPatch = Partial<
  Pick<
    BoardCard,
    "title" | "description" | "assignee_id" | "due_date" | "labels" | "column_id" | "position" | "completed" | "priority" | "cover_color"
  >
> & {
  /** Partial map merge on the server; `null` clears a value. */
  fields?: Record<string, FieldValue>;
};

export type ColumnPatch = Partial<Pick<BoardColumn, "name" | "color" | "position">>;

export type NewCard = { column_id: string; title: string } & Partial<
  Pick<BoardCard, "description" | "assignee_id" | "due_date" | "labels">
>;

export type FieldPatch = Partial<Pick<FieldDef, "name" | "options" | "position">>;
export type SubtaskPatch = Partial<Pick<Subtask, "title" | "done" | "assignee_id" | "position">>;

export type DueFilter = "overdue" | "week";

/** Shared by the board and table views. `assignees` may contain "none" for unassigned cards. */
export type BoardFilters = {
  query: string;
  assignees: string[];
  priorities: Priority[];
  labels: string[];
  due: DueFilter | null;
  hideCompleted: boolean;
};

export const EMPTY_FILTERS: BoardFilters = { query: "", assignees: [], priorities: [], labels: [], due: null, hideCompleted: false };

/** Column colour palette; stored as the key string in `BoardColumn.color`. */
export const COLUMN_COLORS = [
  { key: "slate", label: "Gray", dot: "bg-slate-400" },
  { key: "sky", label: "Blue", dot: "bg-sky-500" },
  { key: "violet", label: "Purple", dot: "bg-violet-500" },
  { key: "emerald", label: "Green", dot: "bg-emerald-500" },
  { key: "amber", label: "Yellow", dot: "bg-amber-500" },
  { key: "orange", label: "Orange", dot: "bg-orange-500" },
  { key: "rose", label: "Red", dot: "bg-rose-500" },
  { key: "pink", label: "Pink", dot: "bg-pink-500" },
] as const;

export const MAX_LABELS = 10;
export const MAX_LABEL_LENGTH = 24;
export const MAX_SUBTASKS = 100;
export const MAX_FIELDS = 30;
export const MAX_OPTIONS = 50;
export const MAX_COMMENT_LENGTH = 4000;

/** Extra values a new card can start with (table "add row" inside a group). */
export type NewCardExtra = { assignee_id?: string | null; labels?: string[]; priority?: Priority };

/** Mutations exposed by the board container to its views and the card dialog (all optimistic + rollback). */
export type BoardActions = {
  updateCard: (card: BoardCard, patch: CardPatch, failure?: string) => void;
  setField: (card: BoardCard, field: FieldDef, value: FieldValue) => void;
  addCard: (columnId: string, title: string, extra?: NewCardExtra) => void;
  deleteCard: (card: BoardCard) => void;
  toggleComplete: (card: BoardCard) => void;
  openCard: (cardId: string) => void;
  addSubtask: (card: BoardCard, title: string, assigneeId?: string | null) => void;
  updateSubtask: (card: BoardCard, subtask: Subtask, patch: SubtaskPatch) => void;
  deleteSubtask: (card: BoardCard, subtask: Subtask) => void;
  moveSubtask: (card: BoardCard, subtaskId: string, toIndex: number) => void;
  createField: (body: { name: string; type: FieldType; options?: FieldOption[] }) => void;
  updateField: (field: FieldDef, patch: FieldPatch) => void;
  deleteField: (field: FieldDef) => void;
  moveField: (field: FieldDef, dir: -1 | 1) => void;
  bumpCommentCount: (cardId: string, delta: number) => void;
};
