import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import type {
  AiChatCatalog,
  AiChatProviderId,
} from "../types";
import { LinearIcon } from "./LinearIcon";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationRuntime = "local" | "codex-host";

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: number;
  provider?: AiChatProviderId;
  model: string;
  reasoningEffort: string;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key" | "local";
  };
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  runtimeNote?: string | null;
  runtime?: AutomationRuntime | null;
  catalog?: AiChatCatalog | null;
  workspacePathHint?: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
  onSaveWorkspace?: (workspacePath: string) => Promise<void> | void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  provider: "codex",
  model: "gpt-5.5",
  reasoningEffort: "high",
};

const INTERVAL_PRESETS = [1, 5, 10, 15, 30, 60, 120];
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 180;

const PROVIDER_LABELS: Record<AiChatProviderId, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  volcengine: "火山引擎",
  aliyun: "阿里云百炼",
  tencent: "腾讯云混元",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高 (xhigh)",
  max: "最高",
  ultra: "极高 (ultra)",
  default: "默认",
};

function clampInterval(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_OPTIONS.intervalMinutes;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(value)));
}

function effortLabel(effort: string) {
  return EFFORT_LABELS[effort] ?? effort;
}

export function ProjectAutomationMenu({
  automation,
  pending,
  error,
  unavailableReason,
  runtimeNote = null,
  runtime = null,
  catalog = null,
  workspacePathHint = null,
  onOpen,
  onChange,
  onSaveWorkspace,
}: ProjectAutomationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const [intervalDraft, setIntervalDraft] = useState(String(DEFAULT_OPTIONS.intervalMinutes));
  const [workspaceDraft, setWorkspaceDraft] = useState(workspacePathHint ?? "");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const needsWorkspace = Boolean(
    unavailableReason
    && unavailableReason.includes("工作区")
    && onSaveWorkspace,
  );
  const isLocalRuntime = runtime === "local";
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;
  const stateLabel = !automation?.enabledByUser
    ? "已暂停"
    : automation.quotaAware && quota?.state === "blocked"
      ? "额度暂停"
      : automation.quotaAware && quota?.state === "unavailable"
        ? "额度不可用"
        : automation.quotaAware && (!quota || quota.state === "unknown")
          ? "额度未知"
          : status === "ACTIVE"
            ? "运行中"
            : "已暂停";
  const disabled = pending || Boolean(unavailableReason);

  const availableProviders = useMemo(() => (
    (catalog?.providers ?? []).filter((entry) => entry.available)
  ), [catalog]);

  const selectedProvider = useMemo(() => {
    if (!isLocalRuntime) return null;
    return availableProviders.find((entry) => entry.id === draft.provider)
      ?? availableProviders[0]
      ?? null;
  }, [availableProviders, draft.provider, isLocalRuntime]);

  const providerModels = useMemo(() => {
    if (!isLocalRuntime || !selectedProvider) return [];
    return (catalog?.models ?? []).filter((model) => model.provider === selectedProvider.id);
  }, [catalog?.models, isLocalRuntime, selectedProvider]);

  const selectedModel = useMemo(() => (
    providerModels.find((model) => model.slug === draft.model) ?? providerModels[0] ?? null
  ), [draft.model, providerModels]);

  const hostEfforts = useMemo(() => (
    getAutomationModel(draft.model as AutomationModel)?.efforts
    ?? (["medium"] as const)
  ), [draft.model]);

  const effortOptions: string[] = isLocalRuntime
    ? (selectedModel?.supportedReasoningEfforts?.length
      ? selectedModel.supportedReasoningEfforts
      : ["medium"])
    : [...hostEfforts];

  function normalizeLocalOptions(base: AutomationOptions): AutomationOptions {
    if (!isLocalRuntime || availableProviders.length === 0) {
      return { ...base, intervalMinutes: clampInterval(base.intervalMinutes) };
    }
    const provider = availableProviders.find((entry) => entry.id === base.provider)
      ?? availableProviders[0];
    const models = (catalog?.models ?? []).filter((model) => model.provider === provider.id);
    const preferred = catalog?.defaults?.[provider.id]?.model;
    const model = models.find((entry) => entry.slug === base.model)
      ?? models.find((entry) => entry.slug === preferred)
      ?? models[0];
    const effort = model
      ? (
        model.supportedReasoningEfforts.includes(base.reasoningEffort)
          ? base.reasoningEffort
          : (model.defaultReasoningEffort || model.supportedReasoningEfforts[0] || "medium")
      )
      : base.reasoningEffort;
    return {
      ...base,
      intervalMinutes: clampInterval(base.intervalMinutes),
      provider: provider.id,
      model: model?.slug ?? base.model,
      reasoningEffort: effort,
    };
  }

  useEffect(() => {
    if (!open) return;
    const next = normalizeLocalOptions({ ...DEFAULT_OPTIONS, ...automation });
    setDraft(next);
    setIntervalDraft(String(next.intervalMinutes));
    setWorkspaceDraft(workspacePathHint ?? "");
  }, [open, workspacePathHint, catalog, availableProviders.length]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      const next = normalizeLocalOptions({ ...DEFAULT_OPTIONS, ...automation });
      setDraft(next);
      setIntervalDraft(String(next.intervalMinutes));
    }
    wasPendingRef.current = pending;
  }, [automation, pending, catalog, availableProviders.length]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open, draft.provider, providerModels.length]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    const normalized = {
      ...next,
      intervalMinutes: clampInterval(next.intervalMinutes),
    };
    setDraft(normalized);
    setIntervalDraft(String(normalized.intervalMinutes));
    onChange(normalized);
  };

  const chooseProvider = (providerId: AiChatProviderId) => {
    const models = (catalog?.models ?? []).filter((model) => model.provider === providerId);
    const preferred = catalog?.defaults?.[providerId]?.model;
    const model = models.find((entry) => entry.slug === preferred) ?? models[0];
    const effort = model
      ? (
        model.supportedReasoningEfforts.includes(
          catalog?.defaults?.[providerId]?.reasoningEffort ?? "",
        )
          ? (catalog?.defaults?.[providerId]?.reasoningEffort as string)
          : (model.defaultReasoningEffort || model.supportedReasoningEfforts[0] || "medium")
      )
      : draft.reasoningEffort;
    submitChange({
      ...draft,
      provider: providerId,
      model: model?.slug ?? draft.model,
      reasoningEffort: effort,
    });
  };

  const chooseModel = (modelSlug: string) => {
    if (!isLocalRuntime) {
      submitChange(withAutomationModel(
        {
          ...draft,
          model: draft.model as AutomationModel,
          reasoningEffort: draft.reasoningEffort as AutomationReasoningEffort,
        },
        modelSlug as AutomationModel,
      ));
      return;
    }
    const model = providerModels.find((entry) => entry.slug === modelSlug);
    const effort = model?.supportedReasoningEfforts.includes(draft.reasoningEffort)
      ? draft.reasoningEffort
      : (model?.defaultReasoningEffort || model?.supportedReasoningEfforts[0] || "medium");
    submitChange({
      ...draft,
      model: modelSlug,
      reasoningEffort: effort,
    });
  };

  const commitInterval = (raw: string) => {
    const parsed = Number(raw);
    const next = clampInterval(parsed);
    setIntervalDraft(String(next));
    if (next !== draft.intervalMinutes) {
      submitChange({ ...draft, intervalMinutes: next });
    }
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label="自动认领待办设置"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>自动认领待办</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>自动认领开关</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {!isLocalRuntime && (
        <div className="project-automation-switch">
          <span>根据额度启用/关闭</span>
          <button
            type="button"
            className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
            role="switch"
            aria-checked={draft.quotaAware}
            disabled={disabled}
            onClick={() => submitChange({
              ...draft,
              quotaAware: !draft.quotaAware,
            })}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      )}
      {draft.quotaAware && !isLocalRuntime && (
        <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && "当前额度可用"}
          {quota?.state === "blocked" && (
            quota.resetsAt
              ? `额度已用尽，预计 ${formatResetTime(quota.resetsAt)} 恢复`
              : "额度已用尽，自动认领已暂停"
          )}
          {quota?.state === "unavailable" && (
            quota.reason === "api-key"
              ? "API Key 模式不支持读取 Codex App 额度"
              : "当前账户无法读取额度"
          )}
          {(!quota || quota.state === "unknown") && "额度状态未知，自动认领已暂停"}
        </div>
      )}
      <label className="project-automation-field project-automation-interval-field">
        <span>间隔（分钟）</span>
        <div className="project-automation-interval-controls">
          <input
            type="number"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            step={1}
            value={intervalDraft}
            disabled={disabled}
            onChange={(event) => setIntervalDraft(event.target.value)}
            onBlur={() => commitInterval(intervalDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitInterval(intervalDraft);
              }
            }}
          />
          <select
            value={INTERVAL_PRESETS.includes(draft.intervalMinutes) ? draft.intervalMinutes : ""}
            disabled={disabled}
            aria-label="常用间隔"
            onChange={(event) => {
              if (!event.target.value) return;
              commitInterval(event.target.value);
            }}
          >
            <option value="" disabled>快捷</option>
            {INTERVAL_PRESETS.map((minutes) => (
              <option key={minutes} value={minutes}>{minutes} 分钟</option>
            ))}
          </select>
        </div>
      </label>
      {isLocalRuntime ? (
        <>
          <label className="project-automation-field">
            <span>AI Provider</span>
            <select
              value={selectedProvider?.id ?? ""}
              disabled={disabled || availableProviders.length === 0}
              onChange={(event) => chooseProvider(event.target.value as AiChatProviderId)}
            >
              {availableProviders.length === 0 && <option value="">暂无可用 Provider</option>}
              {availableProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {PROVIDER_LABELS[provider.id] ?? provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="project-automation-field">
            <span>模型</span>
            <select
              value={selectedModel?.slug ?? ""}
              disabled={disabled || providerModels.length === 0}
              onChange={(event) => chooseModel(event.target.value)}
            >
              {providerModels.length === 0 && <option value="">暂无模型</option>}
              {providerModels.map((model) => (
                <option key={model.slug} value={model.slug}>{model.displayName}</option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <label className="project-automation-field">
          <span>模型</span>
          <select
            value={draft.model}
            disabled={disabled}
            onChange={(event) => chooseModel(event.target.value)}
          >
            {AUTOMATION_MODELS.map((model) => (
              <option key={model.slug} value={model.slug}>{model.label}</option>
            ))}
          </select>
        </label>
      )}
      <label className="project-automation-field">
        <span>推理强度</span>
        <select
          value={
            effortOptions.includes(draft.reasoningEffort)
              ? draft.reasoningEffort
              : (effortOptions[0] ?? "")
          }
          disabled={disabled || effortOptions.length === 0}
          onChange={(event) => submitChange({
            ...draft,
            reasoningEffort: event.target.value,
          })}
        >
          {effortOptions.map((effort) => (
            <option key={effort} value={effort}>{effortLabel(effort)}</option>
          ))}
        </select>
      </label>
      {!unavailableReason && runtimeNote && (
        <p className="project-automation-note">{runtimeNote}</p>
      )}
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {needsWorkspace && (
        <label className="project-automation-field">
          <span>本机工作区目录</span>
          <input
            type="text"
            value={workspaceDraft}
            placeholder="/absolute/path/to/repo"
            disabled={workspaceSaving || pending}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
          />
          <button
            type="button"
            className="project-automation-workspace-save"
            disabled={workspaceSaving || pending || !workspaceDraft.trim()}
            onClick={() => {
              if (!onSaveWorkspace) return;
              setWorkspaceSaving(true);
              void Promise.resolve(onSaveWorkspace(workspaceDraft.trim()))
                .catch(() => {})
                .finally(() => setWorkspaceSaving(false));
            }}
          >
            {workspaceSaving ? "保存中…" : "保存工作区"}
          </button>
        </label>
      )}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE" ? "自动认领" : "无自动化"}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE" ? "自动认领" : "无自动化"}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name={status === "ACTIVE" ? "play" : "pause"} />
        <span>{status === "ACTIVE" ? "自动认领" : "无自动化"}</span>
      </button>
      {menu}
    </>
  );
}

function formatResetTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
