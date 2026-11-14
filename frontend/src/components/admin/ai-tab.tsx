"use client";

import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  PlugZap,
  RotateCcw,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AISparkle } from "@/components/ai/brand";
import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBlock } from "@/components/views/view-shell";
import { useWorkspace } from "@/components/workspace/provider";
import {
  adminApi,
  adminErrorMessage,
  AI_FEATURE_META,
  AI_PROVIDERS,
  cleanModelId,
  compactNumber,
  fullDate,
  notifyAIChanged,
  pickDefaultModel,
  relativeTime,
  type AIFeatures,
  type AIProvider,
  type AIUsageReport,
  type WorkspaceAISettings,
  type WorkspaceAISettingsUpdate,
} from "@/lib/admin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { FieldRow, NativeSelect, Section, Segmented, SkeletonBlock, Spinner, Switch } from "./controls";
import { fillDays, TopList, UsageChart } from "./usage-chart";

export function AITab() {
  const ws = useWorkspace();
  const [settings, setSettings] = useState<WorkspaceAISettings | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    adminApi
      .getAISettings(ws.workspaceId)
      .then((s) => {
        if (!live) return;
        setSettings(s);
        setError("");
      })
      .catch((err) => live && setError(adminErrorMessage(err, "Couldn't load AI settings")));
    return () => {
      live = false;
    };
  }, [ws.workspaceId, attempt]);

  const onSaved = (next: WorkspaceAISettings) => {
    setSettings(next);
    notifyAIChanged(ws.workspaceId);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {error && !settings ? (
        <ErrorBlock message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !settings ? (
        <SkeletonBlock rows={6} />
      ) : (
        <AIConfigForm
          key={`${settings.updated_at ?? ""}|${settings.provider ?? ""}|${settings.key_set}|${settings.model ?? ""}`}
          settings={settings}
          onSaved={onSaved}
        />
      )}
      <UsagePanel />
    </div>
  );
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; latency: number; count: number }
  | { kind: "error"; message: string };

function sameFeatures(a: AIFeatures, b: AIFeatures) {
  return AI_FEATURE_META.every((f) => !!a[f.key] === !!b[f.key]);
}

function AIConfigForm({ settings, onSaved }: { settings: WorkspaceAISettings; onSaved: (s: WorkspaceAISettings) => void }) {
  const ws = useWorkspace();
  const initialFeatures = Object.fromEntries(AI_FEATURE_META.map((f) => [f.key, settings.features?.[f.key] ?? true])) as AIFeatures;
  const [provider, setProvider] = useState<AIProvider>(settings.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [model, setModel] = useState(settings.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [features, setFeatures] = useState<AIFeatures>(initialFeatures);
  const [limit, setLimit] = useState(String(settings.per_user_limit ?? 30));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const meta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const savedProvider = settings.provider;
  const keyApplies = settings.key_set && provider === savedProvider;
  const envFallback = settings.source === "env" && !settings.key_set;
  const canUseEnv = provider === "anthropic" && envFallback;
  const showKeyInput = !keyApplies || replacing;
  const limitNum = Number(limit);
  const limitValid = Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 1000;

  const dirty =
    provider !== (savedProvider ?? "anthropic") ||
    apiKey.trim() !== "" ||
    model.trim() !== (settings.model ?? "") ||
    !sameFeatures(features, initialFeatures) ||
    limitNum !== settings.per_user_limit;

  const needsKey = !keyApplies && !apiKey.trim() && !canUseEnv;
  const needsModel = provider === "gemini" && !model.trim();

  const chooseProvider = (p: AIProvider) => {
    if (p === provider) return;
    setProvider(p);
    setModels([]);
    setTest({ kind: "idle" });
    setReplacing(false);
    setApiKey("");
    setFormError("");
    setModel(p === savedProvider ? (settings.model ?? "") : (AI_PROVIDERS.find((x) => x.id === p)?.defaultModel ?? ""));
  };

  const runTest = async () => {
    if (needsKey) {
      setTest({ kind: "error", message: `Enter your ${meta.vendor} API key first.` });
      return;
    }
    setTest({ kind: "running" });
    try {
      const res = await adminApi.testAI(ws.workspaceId, {
        provider,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      if (!res.ok) {
        setTest({ kind: "error", message: res.error || "The provider rejected the request. Check the key and try again." });
        return;
      }
      const list = Array.from(new Set((res.models ?? []).map(cleanModelId))).sort((a, b) => a.localeCompare(b));
      setModels(list);
      setTest({ kind: "ok", latency: Math.round(res.latency_ms), count: list.length });
      if (!model.trim() || (list.length && !list.includes(model.trim()))) {
        const suggested = res.suggested_model ? cleanModelId(res.suggested_model) : null;
        const pick = suggested && (!list.length || list.includes(suggested)) ? suggested : pickDefaultModel(provider, list);
        if (pick) setModel(pick);
      }
    } catch (err) {
      setTest({ kind: "error", message: adminErrorMessage(err, "Couldn't reach the provider") });
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !dirty) return;
    if (needsKey) return setFormError(`Add a ${meta.vendor} API key to use ${meta.name}.`);
    if (needsModel) return setFormError("Test the connection and pick a Gemini model.");
    if (!limitValid) return setFormError("The per-person limit must be between 1 and 1000.");
    setSaving(true);
    setFormError("");
    const body: WorkspaceAISettingsUpdate = {};
    if (provider !== savedProvider) body.provider = provider;
    if (apiKey.trim()) body.api_key = apiKey.trim();
    if (model.trim() !== (settings.model ?? "") || provider !== savedProvider) body.model = model.trim() || null;
    if (!sameFeatures(features, initialFeatures)) body.features = features;
    if (limitNum !== settings.per_user_limit) body.per_user_limit = limitNum;
    try {
      const next = await adminApi.putAISettings(ws.workspaceId, body);
      toast.success("AI settings saved");
      onSaved(next);
    } catch (err) {
      const msg = adminErrorMessage(err, "Couldn't save AI settings");
      setFormError(msg);
      toast.error(msg);
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      const next = await adminApi.putAISettings(ws.workspaceId, { api_key: "" });
      toast.success("API key removed");
      onSaved(next);
    } catch (err) {
      throw new Error(adminErrorMessage(err, "Couldn't remove the key"));
    }
  };

  const reset = () => {
    setProvider(settings.provider ?? "anthropic");
    setApiKey("");
    setReplacing(false);
    setModel(settings.model ?? "");
    setModels([]);
    setTest({ kind: "idle" });
    setFeatures(initialFeatures);
    setLimit(String(settings.per_user_limit ?? 30));
    setFormError("");
  };

  const updatedBy = settings.updated_by ? ws.memberById[settings.updated_by]?.full_name : null;
  const active = settings.source !== null && (settings.key_set || envFallback);
  const activeMeta = AI_PROVIDERS.find((p) => p.id === (settings.provider ?? (envFallback ? "anthropic" : null)));

  return (
    <form onSubmit={save} className="space-y-4 sm:space-y-6">
      {/* Status */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 sm:px-5",
          active ? "border-emerald-500/30 bg-emerald-500/5" : "bg-background",
        )}
      >
        <span className={cn("flex size-9 items-center justify-center rounded-lg", active ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
          <AISparkle className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">
            {active ? `Worklio AI is on · ${activeMeta?.vendor ?? ""} ${activeMeta?.name ?? ""}` : "Worklio AI isn't set up yet"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {active
              ? settings.source === "env"
                ? `Using the server's ANTHROPIC_API_KEY${settings.model ? ` · ${settings.model}` : ""}. Add a workspace key to use your own account or another provider.`
                : `Model ${settings.model ?? activeMeta?.defaultModel ?? "default"}${settings.updated_at ? ` · updated ${relativeTime(settings.updated_at)}${updatedBy ? ` by ${updatedBy}` : ""}` : ""}`
              : "Pick a provider, add an API key and test the connection."}
          </p>
        </div>
        {settings.source === "env" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
            <Server className="size-3" /> Server key
          </span>
        )}
      </div>

      {/* Provider */}
      <Section title="Provider" description="Worklio sends prompts to the provider you choose, using your workspace's API key.">
        <div role="radiogroup" aria-label="AI provider" className="grid gap-3 sm:grid-cols-3">
          {AI_PROVIDERS.map((p) => {
            const selected = p.id === provider;
            const current = p.id === savedProvider && settings.key_set;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => chooseProvider(p.id)}
                className={cn(
                  "relative flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected ? "border-send bg-send/5 ring-1 ring-send" : "hover:bg-muted/60",
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <ProviderMark id={p.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-tight font-black">{p.name}</span>
                    <span className="block text-[11px] text-muted-foreground">{p.vendor}</span>
                  </span>
                  {current && (
                    <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] leading-4 font-bold text-emerald-700 dark:text-emerald-300">
                      In use
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{p.description}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* Key + model */}
      <Section
        title={`${meta.vendor} API key`}
        description={
          <>
            Create a key in your{" "}
            <a href={meta.keyUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-link hover:underline">
              {meta.vendor} console <ExternalLink className="size-3" />
            </a>
            , then test it here.
          </>
        }
      >
        <div className="divide-y">
          <FieldRow label="API key" htmlFor="ai-key" hint={canUseEnv ? "Optional while the server key is configured." : undefined}>
            {!showKeyInput ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-8 items-center gap-2 rounded-lg border bg-muted/50 px-2.5 text-sm">
                  <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
                  Key set <code className="font-mono text-xs">{settings.key_hint ?? "…"}</code>
                </span>
                <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
                  <RotateCcw /> Replace
                </Button>
                <Button type="button" variant="destructive" onClick={() => setConfirmRemove(true)}>
                  <Trash2 /> Remove
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      if (test.kind !== "idle") setTest({ kind: "idle" });
                    }}
                    placeholder={meta.keyPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={replacing}
                    className="pr-9 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                    aria-pressed={showKey}
                    className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {replacing && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setReplacing(false);
                      setApiKey("");
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
              Keys are encrypted and never shown again. Only the last 4 characters are kept so you can tell keys apart.
            </p>
          </FieldRow>

          <FieldRow label="Connection" hint="Checks the key and loads the models it can use.">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={runTest} disabled={test.kind === "running"}>
                {test.kind === "running" ? <Spinner /> : <PlugZap />}
                Test connection
              </Button>
              <span aria-live="polite" className="text-sm">
                {test.kind === "ok" && (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-4" /> Connected · {test.latency} ms
                    {test.count > 0 && <span className="font-normal text-muted-foreground">· {test.count} models</span>}
                  </span>
                )}
                {test.kind === "error" && (
                  <span className="inline-flex items-start gap-1.5 text-destructive">
                    <XCircle className="mt-0.5 size-4 shrink-0" /> {test.message}
                  </span>
                )}
              </span>
            </div>
          </FieldRow>

          <FieldRow
            label="Model"
            htmlFor="ai-model"
            hint={
              provider === "gemini"
                ? "Test the connection to choose from your available Gemini models."
                : `Default: ${meta.defaultModel}`
            }
          >
            {models.length > 0 ? (
              <NativeSelect id="ai-model" value={model} onChange={(e) => setModel(e.target.value)}>
                {model && !models.includes(model) && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value.trim())}
                placeholder={meta.defaultModel ?? "Test the connection to load models"}
                spellCheck={false}
                className="font-mono"
              />
            )}
          </FieldRow>
        </div>
      </Section>

      {/* Features */}
      <Section title="Features" description="Turn individual Worklio AI features on or off for everyone in the workspace.">
        <ul className="-mx-4 -my-4 divide-y sm:-mx-5">
          {AI_FEATURE_META.map((f) => (
            <li key={f.key} className="flex items-center gap-4 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <label htmlFor={`ai-f-${f.key}`} className="text-sm font-bold">
                  {f.label}
                </label>
                <p className="text-xs text-muted-foreground">{f.description}</p>
              </div>
              <Switch id={`ai-f-${f.key}`} checked={!!features[f.key]} onCheckedChange={(v) => setFeatures((x) => ({ ...x, [f.key]: v }))} />
            </li>
          ))}
        </ul>
      </Section>

      {/* Limits */}
      <Section title="Limits" description="Keep costs predictable by capping how often each person can use AI.">
        <FieldRow label="Requests per person" htmlFor="ai-limit" hint="Per 10 minutes. The @worklio agent counts each reply.">
          <div className="flex items-center gap-2">
            <Input
              id="ai-limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              aria-invalid={!limitValid}
              className="w-28 tabular-nums"
            />
            <span className="text-sm text-muted-foreground">every 10 minutes</span>
          </div>
        </FieldRow>
      </Section>

      {/* Save bar */}
      <div className="sticky bottom-0 z-10 -mx-3 border-t bg-background/95 px-3 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {formError && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {formError}
            </p>
          )}
          {!formError && dirty && <p className="mr-auto text-xs text-muted-foreground">You have unsaved changes.</p>}
          {!formError && !dirty && settings.updated_at && (
            <p className="mr-auto text-xs text-muted-foreground" title={fullDate(settings.updated_at)}>
              Saved {relativeTime(settings.updated_at)}
            </p>
          )}
          {dirty && (
            <Button type="button" variant="ghost" onClick={reset} disabled={saving}>
              Discard
            </Button>
          )}
          <Button type="submit" className="bg-send text-white hover:bg-send/90" disabled={!dirty || saving}>
            {saving && <Spinner />}
            Save AI settings
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove the ${AI_PROVIDERS.find((p) => p.id === savedProvider)?.vendor ?? ""} API key?`}
        description={
          settings.source === "workspace" && !envFallback
            ? "Worklio AI stops working in this workspace until a new key is added (or the server key is used, if one is configured)."
            : "The stored key is deleted permanently."
        }
        confirmLabel="Remove key"
        destructive
        onConfirm={removeKey}
      />
    </form>
  );
}

function ProviderMark({ id }: { id: AIProvider }) {
  const styles: Record<AIProvider, string> = {
    anthropic: "bg-[#d97757]/15 text-[#c4623f] dark:text-[#e8916f]",
    gemini: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
    deepseek: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  };
  const letter: Record<AIProvider, string> = { anthropic: "A", gemini: "G", deepseek: "D" };
  return (
    <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-black", styles[id])}>
      {letter[id]}
    </span>
  );
}

const DAY_OPTIONS = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
] as const;

function UsagePanel() {
  const ws = useWorkspace();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [metric, setMetric] = useState<"requests" | "tokens">("requests");
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<{ key: string; report: AIUsageReport; filled: ReturnType<typeof fillDays> } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = `${days}|${attempt}`;

  useEffect(() => {
    let live = true;
    adminApi
      .aiUsage(ws.workspaceId, Number(days))
      .then((report) => live && setData({ key, report, filled: fillDays(report, Number(days)) }))
      .catch((err) => live && setFailure({ key, message: adminErrorMessage(err, "Couldn't load usage") }));
    return () => {
      live = false;
    };
  }, [ws.workspaceId, days, key]);

  const current = data?.key === key ? data : null;
  const error = failure?.key === key ? failure.message : "";
  const shown = current ?? (error ? null : data);
  const totals = (shown?.filled ?? []).reduce(
    (t, d) => ({ requests: t.requests + d.requests, input: t.input + d.input_tokens, output: t.output + d.output_tokens }),
    { requests: 0, input: 0, output: 0 },
  );
  const featureLabel = Object.fromEntries(AI_FEATURE_META.map((f) => [f.key, f.label])) as Record<string, string>;

  return (
    <Section
      title="Usage"
      description="Requests and tokens across the workspace. Use this to keep an eye on provider costs."
      actions={<Segmented label="Time range" size="sm" value={days} onChange={setDays} options={DAY_OPTIONS} />}
    >
      {error && !shown ? (
        <ErrorBlock compact message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !shown ? (
        <SkeletonBlock rows={4} />
      ) : (
        <div className={cn("space-y-5", !current && "opacity-60 transition-opacity")}>
          <dl className="grid grid-cols-3 gap-2 sm:gap-3">
            {[
              { label: "Requests", value: totals.requests },
              { label: "Input tokens", value: totals.input },
              { label: "Output tokens", value: totals.output },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                <dt className="truncate text-[11px] font-semibold text-muted-foreground">{s.label}</dt>
                <dd className="text-lg font-black tabular-nums sm:text-xl" title={s.value.toLocaleString()}>
                  {compactNumber(s.value)}
                </dd>
              </div>
            ))}
          </dl>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold">Per day</h3>
              <Segmented
                label="Metric"
                size="sm"
                value={metric}
                onChange={setMetric}
                options={[
                  { value: "requests", label: "Requests" },
                  { value: "tokens", label: "Tokens" },
                ]}
              />
            </div>
            <UsageChart data={shown.filled} metric={metric} />
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="mb-2.5 text-sm font-bold">Top people</h3>
              <TopList
                empty="No one has used Worklio AI in this period."
                rows={[...shown.report.by_user]
                  .sort((a, b) => b.requests - a.requests)
                  .slice(0, 6)
                  .map((u, i) => {
                    const name = (u.user_id && ws.memberById[u.user_id]?.full_name) || u.full_name || "Former member";
                    return {
                      key: u.user_id ?? `unknown-${i}`,
                      value: u.requests,
                      sub: `${(u.input_tokens + u.output_tokens).toLocaleString()} tokens`,
                      label: (
                        <>
                          <UserAvatar id={u.user_id ?? `unknown-${i}`} name={name} size="sm" />
                          <span className="truncate">{name}</span>
                        </>
                      ),
                    };
                  })}
              />
            </div>
            <div>
              <h3 className="mb-2.5 text-sm font-bold">Top features</h3>
              <TopList
                empty="No AI requests in this period."
                rows={[...shown.report.by_feature]
                  .sort((a, b) => b.requests - a.requests)
                  .slice(0, 7)
                  .map((f) => ({
                    key: f.feature,
                    value: f.requests,
                    sub: `${(f.input_tokens + f.output_tokens).toLocaleString()} tokens`,
                    label: <span className="truncate">{featureLabel[f.feature] ?? f.feature}</span>,
                  }))}
              />
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
