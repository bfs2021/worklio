"use client";

import { ArrowDown, ArrowUp, Check, ChevronRight, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  FIELD_TYPES,
  MAX_FIELD_NAME,
  MAX_OPTION_LABEL,
  OPTION_COLORS,
  colorMeta,
  fieldTypeMeta,
  hasOptions,
  isEmptyValue,
  newId,
  nextOptionColor,
} from "@/lib/lists";
import { cn } from "@/lib/utils";

import { MAX_FIELDS, MAX_OPTIONS, type BoardActions, type BoardCard, type FieldDef, type FieldOption, type FieldType } from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: FieldDef[];
  cards: BoardCard[];
  actions: BoardActions;
};

/** "Manage fields": create, rename, reorder and delete custom fields; edit select options and their colours. */
export function FieldsDialog({ open, onOpenChange, fields, cards, actions }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "gap-0 p-0 sm:max-w-lg",
          "max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0",
        )}
      >
        <DialogHeader className="border-b px-4 pt-4 pb-3 pr-12">
          <DialogTitle>Fields</DialogTitle>
          <DialogDescription>Custom properties every card in this list can have. Changes apply for everyone.</DialogDescription>
        </DialogHeader>
        {open && <FieldsManager fields={fields} cards={cards} actions={actions} />}
      </DialogContent>
    </Dialog>
  );
}

function FieldsManager({ fields, cards, actions }: Omit<Props, "open" | "onOpenChange">) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(fields.length === 0);
  const full = fields.length >= MAX_FIELDS;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:max-h-[70dvh]">
      {fields.length === 0 && !creating && (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No custom fields yet.</p>
      )}
      {fields.length > 0 && (
        <ul className="divide-y" aria-label="Fields">
          {fields.map((f, i) => (
            <FieldRow
              key={f.id}
              field={f}
              usedBy={cards.filter((c) => !isEmptyValue(c.fields[f.id])).length}
              isFirst={i === 0}
              isLast={i === fields.length - 1}
              expanded={expanded === f.id}
              onToggle={() => setExpanded((x) => (x === f.id ? null : f.id))}
              actions={actions}
            />
          ))}
        </ul>
      )}
      <div className="border-t p-3">
        {creating ? (
          <NewFieldForm
            onCancel={fields.length ? () => setCreating(false) : undefined}
            onCreate={(body) => {
              actions.createField(body);
              setCreating(false);
            }}
            existing={fields}
          />
        ) : (
          <Button variant="outline" size="sm" disabled={full} onClick={() => setCreating(true)}>
            <Plus /> {full ? `Limit of ${MAX_FIELDS} fields reached` : "New field"}
          </Button>
        )}
      </div>
    </div>
  );
}

function FieldRow({
  field,
  usedBy,
  isFirst,
  isLast,
  expanded,
  onToggle,
  actions,
}: {
  field: FieldDef;
  usedBy: number;
  isFirst: boolean;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  actions: BoardActions;
}) {
  const [confirming, setConfirming] = useState(false);
  const meta = fieldTypeMeta(field.type);
  const Icon = meta.icon;
  const temp = field.id.startsWith("tmp-");
  const withOptions = hasOptions(field.type);

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" title={meta.label}>
          <Icon className="size-4" aria-hidden />
        </span>
        <NameInput
          value={field.name}
          disabled={temp}
          ariaLabel={`${meta.label} field name`}
          onCommit={(name) => actions.updateField(field, { name })}
        />
        {withOptions && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={onToggle}
            className="shrink-0 text-muted-foreground"
          >
            {field.options.length} option{field.options.length === 1 ? "" : "s"}
            <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} />
          </Button>
        )}
        {!withOptions && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{meta.label}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${field.name} field options`} disabled={temp} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem disabled={isFirst} onClick={() => actions.moveField(field, -1)}>
              <ArrowUp /> Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isLast} onClick={() => actions.moveField(field, 1)}>
              <ArrowDown /> Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
              <Trash2 /> Delete field
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {confirming && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1">
            Delete “{field.name}”?{" "}
            {usedBy > 0 ? `Its value on ${usedBy} card${usedBy === 1 ? "" : "s"} will be removed.` : "No cards use it yet."}
          </span>
          <Button size="sm" variant="destructive" onClick={() => actions.deleteField(field)}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}

      {withOptions && expanded && (
        <div className="mt-2 ml-9">
          <OptionsEditor options={field.options} onChange={(options) => actions.updateField(field, { options })} />
        </div>
      )}
    </li>
  );
}

/** Text input that commits on blur / Enter and reverts on Escape. Remounts when the server value changes. */
function NameInput({
  value,
  onCommit,
  ariaLabel,
  disabled,
  maxLength = MAX_FIELD_NAME,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
}) {
  return (
    <input
      key={value}
      defaultValue={value}
      disabled={disabled}
      maxLength={maxLength}
      aria-label={ariaLabel}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if (!v) e.currentTarget.value = value;
        else if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold outline-none hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
        className,
      )}
    />
  );
}

function ColorMenu({ color, onChange, label }: { color: string; onChange: (c: string) => void; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        }
      >
        <span className={cn("size-3.5 rounded-full", colorMeta(color).dot)} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40">
        {OPTION_COLORS.map((c) => (
          <DropdownMenuItem key={c.key} onClick={() => onChange(c.key)}>
            <span className={cn("size-3 rounded-full", c.dot)} aria-hidden />
            {c.label}
            {color === c.key && <Check className="ml-auto" aria-label="Current" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Edit select options: label, colour, delete, add. Calls `onChange` with the whole new list. */
export function OptionsEditor({ options, onChange }: { options: FieldOption[]; onChange: (o: FieldOption[]) => void }) {
  const [text, setText] = useState("");
  const full = options.length >= MAX_OPTIONS;
  const ids = useId();

  function add() {
    const label = text.trim().slice(0, MAX_OPTION_LABEL);
    if (!label || full) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
      setText("");
      return;
    }
    onChange([...options, { id: newId(), label, color: nextOptionColor(options) }]);
    setText("");
  }

  return (
    <div className="grid gap-1">
      {options.length > 0 && (
        <ul className="grid gap-0.5" aria-label="Options">
          {options.map((o) => (
            <li key={o.id} className="flex items-center gap-1">
              <ColorMenu
                color={o.color}
                label={`Colour for ${o.label}`}
                onChange={(color) => onChange(options.map((x) => (x.id === o.id ? { ...x, color } : x)))}
              />
              <NameInput
                value={o.label}
                maxLength={MAX_OPTION_LABEL}
                ariaLabel="Option label"
                className="font-normal"
                onCommit={(label) => onChange(options.map((x) => (x.id === o.id ? { ...x, label } : x)))}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete option ${o.label}`}
                onClick={() => onChange(options.filter((x) => x.id !== o.id))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!full ? (
        <div className="flex items-center gap-1">
          <span className={cn("ml-2 size-3.5 shrink-0 rounded-full opacity-50", colorMeta(nextOptionColor(options)).dot)} aria-hidden />
          <label htmlFor={`${ids}-new`} className="sr-only">
            New option
          </label>
          <input
            id={`${ids}-new`}
            value={text}
            maxLength={MAX_OPTION_LABEL}
            placeholder="Add an option, press Enter"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                add();
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <Button variant="ghost" size="sm" disabled={!text.trim()} onClick={add}>
            Add
          </Button>
        </div>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">Limit of {MAX_OPTIONS} options reached.</p>
      )}
    </div>
  );
}

function NewFieldForm({
  onCreate,
  onCancel,
  existing,
}: {
  onCreate: (body: { name: string; type: FieldType; options?: FieldOption[] }) => void;
  onCancel?: () => void;
  existing: FieldDef[];
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("select");
  const [options, setOptions] = useState<FieldOption[]>([]);
  const ids = useId();
  const trimmed = name.trim();
  const duplicate = existing.some((f) => f.name.toLowerCase() === trimmed.toLowerCase());
  const ok = !!trimmed && !duplicate;

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onCreate({ name: trimmed.slice(0, MAX_FIELD_NAME), type, ...(hasOptions(type) ? { options } : {}) });
      }}
    >
      <div className="grid gap-1.5">
        <label htmlFor={`${ids}-name`} className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          Field name
        </label>
        <Input
          id={`${ids}-name`}
          autoFocus
          value={name}
          maxLength={MAX_FIELD_NAME}
          placeholder="e.g. Estimate, Team, Sprint"
          aria-invalid={duplicate || undefined}
          onChange={(e) => setName(e.target.value)}
          className="h-9"
        />
        {duplicate && <p className="text-xs text-destructive">A field with this name already exists.</p>}
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">Type</legend>
        <div role="group" aria-label="Field type" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {FIELD_TYPES.map((t) => {
            const Icon = t.icon;
            const on = t.type === type;
            return (
              <button
                key={t.type}
                type="button"
                aria-pressed={on}
                title={t.hint}
                onClick={() => setType(t.type)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[13px] font-semibold transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  on ? "border-send/50 bg-send/10" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{t.label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      {hasOptions(type) && (
        <div className="grid gap-1.5">
          <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Options</span>
          <OptionsEditor options={options} onChange={setOptions} />
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!ok} className="bg-send text-white hover:bg-send/90">
          Create field
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
