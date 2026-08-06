import { useEffect, useMemo, useState } from "react";

import {
  deleteAiProviderSettings,
  getAiProviderSettings,
  loginAiProvider,
  saveAiProviderSettings,
  testAiProvider,
} from "../api";
import type {
  AiChatProviderId,
  AiChatSandbox,
  AiProviderLoginResult,
  AiProviderSettingsEntry,
  AiProviderSettingsResponse,
  AiProviderTestResult,
  Project,
} from "../types";
import { LinearIcon } from "./LinearIcon";

type Scope = "global" | "project";

interface AiProviderSettingsProps {
  projects: Project[];
  initialProjectId?: string | null;
  onClose: () => void;
}

const PROVIDER_ORDER: AiChatProviderId[] = [
  "codex",
  "claude-code",
  "anthropic",
  "deepseek",
  "kimi",
  "volcengine",
  "aliyun",
  "tencent",
];

const API_KEY_PROVIDERS = new Set<AiChatProviderId>([
  "anthropic",
  "deepseek",
  "kimi",
  "volcengine",
  "aliyun",
  "tencent",
]);

function isApiKeyProvider(providerId: AiChatProviderId): boolean {
  return API_KEY_PROVIDERS.has(providerId);
}

const SANDBOX_OPTIONS: AiChatSandbox[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

const SANDBOX_LABELS: Record<AiChatSandbox, string> = {
  "read-only": "只读",
  "workspace-write": "工作区可写",
  "danger-full-access": "完全访问",
};

interface ProviderGuideLink {
  label: string;
  href: string;
}

interface ProviderGuide {
  summary: string;
  steps: string[];
  installCommand?: string;
  links: ProviderGuideLink[];
  defaultBaseUrl?: string;
  apiKeyPlaceholder?: string;
}

const PROVIDER_GUIDES: Record<AiChatProviderId, ProviderGuide> = {
  codex: {
    summary: "Codex 通过本机 CLI 接入。若检测失败，请先安装并登录 Codex，再填写可执行文件路径。",
    steps: [
      "安装 Codex CLI（推荐下方安装命令，或下载 Codex 桌面应用）。",
      "在本页点击「登录」，浏览器完成 ChatGPT 授权后点「检测连接」。",
      "将 CLI 路径填为 codex，或 Codex.app 内的绝对路径。",
    ],
    installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    links: [
      { label: "安装 Codex CLI", href: "https://github.com/openai/codex#installing-and-running-codex-cli" },
      { label: "官方文档", href: "https://developers.openai.com/codex/cli" },
      { label: "下载 Codex 桌面应用", href: "https://chatgpt.com/codex" },
    ],
  },
  "claude-code": {
    summary: "Claude Code 通过本机 CLI 接入。安装后需登录 Claude 账号，再配置可执行文件路径。",
    steps: [
      "用下方命令安装 Claude Code CLI。",
      "在本页点击「登录」，浏览器完成 Anthropic 授权后点「检测连接」。",
      "CLI 路径通常可填 claude；若找不到，填写 which claude 输出的绝对路径。",
    ],
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    links: [
      { label: "安装 Claude Code", href: "https://code.claude.com/docs/en/install" },
      { label: "使用概览", href: "https://code.claude.com/docs/en/overview" },
    ],
  },
  anthropic: {
    summary: "Anthropic 直接调用官方 API。需要在 Console 创建 API Key，并保存到本机钥匙串。",
    steps: [
      "打开 Claude Console，创建 API Key（形如 sk-ant-...）。",
      "将 Key 粘贴到下方表单；可选修改 Base URL 与默认模型。",
      "先「检测连接」，成功后再「保存」。完整 Key 只会存入系统钥匙串。",
    ],
    links: [
      { label: "获取 API Key", href: "https://platform.claude.com/settings/keys" },
      { label: "API 快速开始", href: "https://platform.claude.com/docs/en/get-started" },
    ],
    defaultBaseUrl: "https://api.anthropic.com",
    apiKeyPlaceholder: "sk-ant-...",
  },
  deepseek: {
    summary: "DeepSeek 使用 OpenAI 兼容 Chat Completions API。API Key 保存在本机钥匙串。",
    steps: [
      "打开 DeepSeek 开放平台，创建 API Key。",
      "粘贴 Key；可选修改 Base URL / 模型列表。",
      "先「检测连接」，成功后再「保存」。",
    ],
    links: [
      { label: "获取 API Key", href: "https://platform.deepseek.com/api_keys" },
      { label: "API 文档", href: "https://api-docs.deepseek.com" },
    ],
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyPlaceholder: "sk-...",
  },
  kimi: {
    summary: "Kimi（月之暗面 Moonshot）使用 OpenAI 兼容 API。API Key 保存在本机钥匙串。",
    steps: [
      "打开 Moonshot 控制台，创建 API Key。",
      "粘贴 Key；默认 Base URL 为 api.moonshot.cn/v1。",
      "先「检测连接」，成功后再「保存」。",
    ],
    links: [
      { label: "获取 API Key", href: "https://platform.moonshot.cn/console/api-keys" },
      { label: "API 文档", href: "https://platform.moonshot.cn/docs" },
    ],
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    apiKeyPlaceholder: "sk-...",
  },
  volcengine: {
    summary: "火山引擎方舟（Ark）使用 OpenAI 兼容接口。模型名通常是接入点 / Endpoint ID。",
    steps: [
      "在火山方舟创建推理接入点，并获取 API Key。",
      "将模型列表改成你的接入点 ID（或支持的 Model ID）。",
      "先「检测连接」，成功后再「保存」。",
    ],
    links: [
      { label: "火山方舟控制台", href: "https://console.volcengine.com/ark" },
      { label: "API 文档", href: "https://www.volcengine.com/docs/82379" },
    ],
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyPlaceholder: "API Key",
  },
  aliyun: {
    summary: "阿里云百炼（DashScope）兼容模式，使用 OpenAI Chat Completions 协议。",
    steps: [
      "在阿里云百炼控制台创建 API Key。",
      "默认 Base URL 为 DashScope compatible-mode；按需调整模型名。",
      "先「检测连接」，成功后再「保存」。",
    ],
    links: [
      { label: "获取 API Key", href: "https://bailian.console.aliyun.com/" },
      { label: "兼容模式文档", href: "https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope" },
    ],
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyPlaceholder: "sk-...",
  },
  tencent: {
    summary: "腾讯云混元使用 OpenAI 兼容接口。API Key 保存在本机钥匙串。",
    steps: [
      "在腾讯云混元控制台创建 API Key。",
      "粘贴 Key；可选修改 Base URL 与模型列表。",
      "先「检测连接」，成功后再「保存」。",
    ],
    links: [
      { label: "混元控制台", href: "https://console.cloud.tencent.com/hunyuan" },
      { label: "API 文档", href: "https://cloud.tencent.com/document/product/1729" },
    ],
    defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyPlaceholder: "API Key",
  },
};

function emptyDraft(): Record<string, string | boolean> {
  return {
    enabled: true,
    executable: "",
    baseUrl: "",
    models: "",
    defaultModel: "",
    reasoningEffort: "",
    sandbox: "workspace-write",
    apiKey: "",
  };
}

function draftFromEntry(
  entry: AiProviderSettingsEntry | undefined,
  effective: AiProviderSettingsEntry | undefined,
  scope: Scope,
): Record<string, string | boolean> {
  const source = scope === "project" ? entry : (entry ?? effective);
  return {
    enabled: source?.enabled ?? effective?.enabled ?? true,
    executable: source?.executable ?? "",
    baseUrl: source?.baseUrl ?? "",
    models: Array.isArray(source?.models) ? source.models.join(", ") : "",
    defaultModel: source?.defaultModel ?? "",
    reasoningEffort: source?.reasoningEffort ?? "",
    sandbox: source?.sandbox ?? "workspace-write",
    apiKey: "",
  };
}

function inheritedLabel(
  field: string,
  effective: AiProviderSettingsResponse["effective"]["providers"][AiChatProviderId],
): string {
  const source = effective?.source?.[field];
  if (source === "global") return "继承设备默认";
  if (source === "env") return "继承环境变量";
  if (source === "default") return "继承内置默认";
  return "继承设备默认";
}

export function AiProviderSettings({
  projects,
  initialProjectId = null,
  onClose,
}: AiProviderSettingsProps) {
  const [scope, setScope] = useState<Scope>("global");
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [selectedProvider, setSelectedProvider] = useState<AiChatProviderId>("codex");
  const [config, setConfig] = useState<AiProviderSettingsResponse | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null);
  const [loginResult, setLoginResult] = useState<AiProviderLoginResult | null>(null);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const supportsCliLogin = selectedProvider === "codex" || selectedProvider === "claude-code";

  async function copyInstallCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedInstall(true);
      window.setTimeout(() => setCopiedInstall(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制失败");
    }
  }

  const activeProjectId = scope === "project" ? projectId : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getAiProviderSettings(activeProjectId).then(
      (next) => {
        if (cancelled) return;
        setConfig(next);
        const entry = scope === "project"
          ? next.project?.providers[selectedProvider]
          : next.global.providers[selectedProvider];
        setDraft(draftFromEntry(entry, next.effective.providers[selectedProvider], scope));
        setLoading(false);
      },
      (nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, scope]);

  useEffect(() => {
    if (!config) return;
    const entry = scope === "project"
      ? config.project?.providers[selectedProvider]
      : config.global.providers[selectedProvider];
    setDraft(draftFromEntry(entry, config.effective.providers[selectedProvider], scope));
    setTestResult(null);
    setNotice(null);
  }, [selectedProvider, config, scope]);

  const providerMeta = useMemo(
    () => config?.providers.find((entry) => entry.id === selectedProvider) ?? null,
    [config, selectedProvider],
  );
  const effective = config?.effective.providers[selectedProvider];
  const scopedEntry = scope === "project"
    ? config?.project?.providers[selectedProvider]
    : config?.global.providers[selectedProvider];

  function updateDraft(field: string, value: string | boolean) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function buildPatch() {
    const patch: Record<string, unknown> = {
      enabled: draft.enabled === true,
    };
    if (selectedProvider === "codex" || selectedProvider === "claude-code") {
      patch.executable = String(draft.executable || "") || null;
      patch.defaultModel = String(draft.defaultModel || "") || null;
      patch.reasoningEffort = String(draft.reasoningEffort || "") || null;
      patch.sandbox = String(draft.sandbox || "") || null;
    }
    if (isApiKeyProvider(selectedProvider)) {
      patch.baseUrl = String(draft.baseUrl || "") || null;
      patch.defaultModel = String(draft.defaultModel || "") || null;
      const models = String(draft.models || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      patch.models = models.length > 0 ? models : null;
    }
    return patch;
  }

  async function refresh(nextProjectId = activeProjectId) {
    const next = await getAiProviderSettings(nextProjectId);
    setConfig(next);
    return next;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const apiKey = String(draft.apiKey || "");
      const next = await saveAiProviderSettings({
        scope,
        ...(scope === "project" ? { projectId } : {}),
        provider: selectedProvider,
        patch: buildPatch(),
        ...(apiKey ? { apiKey } : {}),
      });
      setConfig(next);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setNotice("已保存");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearApiKey() {
    setSaving(true);
    setError(null);
    try {
      const next = await saveAiProviderSettings({
        scope,
        ...(scope === "project" ? { projectId } : {}),
        provider: selectedProvider,
        patch: {},
        clearApiKey: true,
      });
      setConfig(next);
      setNotice("已清除 API Key");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setError(null);
    try {
      const next = await deleteAiProviderSettings({
        scope,
        ...(scope === "project" ? { projectId } : {}),
        provider: selectedProvider,
      });
      setConfig(next);
      setNotice(scope === "project" ? "已删除项目覆盖，恢复继承" : "已恢复默认配置");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await testAiProvider({
        provider: selectedProvider,
        projectId: activeProjectId,
        draft: {
          ...buildPatch(),
          ...(String(draft.apiKey || "") ? { apiKey: String(draft.apiKey) } : {}),
        },
      });
      setTestResult(result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setTesting(false);
    }
  }

  async function handleLogin() {
    setLoggingIn(true);
    setError(null);
    setLoginResult(null);
    setNotice(null);
    try {
      const result = await loginAiProvider({
        provider: selectedProvider,
        projectId: activeProjectId,
        draft: buildPatch(),
      });
      setLoginResult(result);
      setNotice(result.detail || (result.ok ? "已启动登录" : "启动登录失败"));
      if (!result.ok) setError(result.detail || "启动登录失败");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoggingIn(false);
    }
  }

  return (
    <section className="ai-provider-settings" aria-label="AI 配置">
      <header className="ai-provider-settings-header">
        <div>
          <span className="ai-provider-settings-kicker">本地设备</span>
          <h1>AI 配置</h1>
          <p>管理 Codex、Claude Code 与 Anthropic。敏感凭据保存在系统钥匙串中。</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭 AI 配置" onClick={onClose}>
          <LinearIcon name="close" />
        </button>
      </header>

      <div className="ai-provider-settings-toolbar">
        <div className="ai-provider-scope-tabs" role="tablist" aria-label="配置范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "global"}
            className={scope === "global" ? "is-active" : ""}
            onClick={() => setScope("global")}
          >
            设备默认
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "project"}
            className={scope === "project" ? "is-active" : ""}
            onClick={() => setScope("project")}
          >
            项目覆盖
          </button>
        </div>
        {scope === "project" && (
          <label className="ai-provider-project-select">
            <span>项目</span>
            <select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                void refresh(event.target.value);
              }}
            >
              {projects.length === 0 && <option value="">暂无项目</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        )}
        {!config?.keychainSupported && (
          <p className="ai-provider-settings-warning">
            当前系统不支持钥匙串；API Key 类 Provider 只能通过环境变量提供。
          </p>
        )}
      </div>

      {(error || notice) && (
        <div className={`ai-provider-settings-banner${error ? " is-error" : ""}`} role="status">
          {error ?? notice}
        </div>
      )}

      <div className="ai-provider-settings-body">
        <aside className="ai-provider-list" aria-label="Provider 列表">
          {PROVIDER_ORDER.map((providerId) => {
            const meta = config?.providers.find((entry) => entry.id === providerId);
            const item = config?.effective.providers[providerId];
            const overrideCount = scope === "project"
              ? (config?.project?.providers[providerId]?.overriddenFields?.length ?? 0)
              : 0;
            return (
              <button
                key={providerId}
                type="button"
                className={`ai-provider-list-item${selectedProvider === providerId ? " is-active" : ""}`}
                onClick={() => setSelectedProvider(providerId)}
              >
                <strong>{meta?.displayName ?? providerId}</strong>
                <small>
                  {item?.enabled === false ? "已禁用" : item?.hasApiKey === false && isApiKeyProvider(providerId)
                    ? "未配置 Key"
                    : "已启用"}
                  {overrideCount > 0 ? ` · ${overrideCount} 项覆盖` : ""}
                </small>
              </button>
            );
          })}
        </aside>

        <div className="ai-provider-form" aria-label={`${providerMeta?.displayName ?? selectedProvider} 配置`}>
          {loading || !config ? (
            <div className="ai-provider-form-empty">正在加载配置…</div>
          ) : (
            <>
              <div className="ai-provider-form-heading">
                <h2>{providerMeta?.displayName ?? selectedProvider}</h2>
                <p>
                  {scope === "project"
                    ? "仅填写需要覆盖的字段；留空表示继承设备默认。"
                    : "此设备上所有项目的默认配置。"}
                </p>
              </div>

              {PROVIDER_GUIDES[selectedProvider] && (
                <aside className="ai-provider-guide" aria-label="下载与集成说明">
                  <strong>还没有装好？</strong>
                  <p>{PROVIDER_GUIDES[selectedProvider].summary}</p>
                  <ol>
                    {PROVIDER_GUIDES[selectedProvider].steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  {PROVIDER_GUIDES[selectedProvider].installCommand && (
                    <div className="lark-setup-command-row">
                      <code>{PROVIDER_GUIDES[selectedProvider].installCommand}</code>
                      <button
                        type="button"
                        onClick={() => void copyInstallCommand(
                          PROVIDER_GUIDES[selectedProvider].installCommand!,
                        )}
                        aria-label="复制安装命令"
                        title="复制命令"
                      >
                        <LinearIcon name="copy" />
                        <span>{copiedInstall ? "已复制" : "复制"}</span>
                      </button>
                    </div>
                  )}
                  <div className="ai-provider-guide-links">
                    {PROVIDER_GUIDES[selectedProvider].links.map((link) => (
                      <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                </aside>
              )}

              <label className="ai-provider-field ai-provider-switch-field">
                <span>启用</span>
                <button
                  type="button"
                  className={`board-setting-switch${draft.enabled ? " is-on" : ""}`}
                  aria-pressed={draft.enabled === true}
                  onClick={() => updateDraft("enabled", !draft.enabled)}
                >
                  <span />
                </button>
              </label>

              {(selectedProvider === "codex" || selectedProvider === "claude-code") && (
                <>
                  <label className="ai-provider-field">
                    <span>
                      CLI 路径
                      {scope === "project" && !scopedEntry?.executable && (
                        <em>{inheritedLabel("executable", effective)}：{effective?.executable}</em>
                      )}
                    </span>
                    <input
                      type="text"
                      value={String(draft.executable ?? "")}
                      placeholder={String(effective?.executable ?? "可执行文件路径")}
                      onChange={(event) => updateDraft("executable", event.target.value)}
                    />
                  </label>
                  <label className="ai-provider-field">
                    <span>
                      默认模型
                      {scope === "project" && !scopedEntry?.defaultModel && (
                        <em>{inheritedLabel("defaultModel", effective)}：{effective?.defaultModel || "无"}</em>
                      )}
                    </span>
                    <input
                      type="text"
                      value={String(draft.defaultModel ?? "")}
                      placeholder={String(effective?.defaultModel ?? "模型 slug")}
                      onChange={(event) => updateDraft("defaultModel", event.target.value)}
                    />
                  </label>
                  <label className="ai-provider-field">
                    <span>
                      推理强度
                      {scope === "project" && !scopedEntry?.reasoningEffort && (
                        <em>{inheritedLabel("reasoningEffort", effective)}：{effective?.reasoningEffort || "无"}</em>
                      )}
                    </span>
                    <input
                      type="text"
                      value={String(draft.reasoningEffort ?? "")}
                      placeholder={String(effective?.reasoningEffort ?? "low / medium / high")}
                      onChange={(event) => updateDraft("reasoningEffort", event.target.value)}
                    />
                  </label>
                  <label className="ai-provider-field">
                    <span>
                      权限沙箱
                      {scope === "project" && !scopedEntry?.sandbox && (
                        <em>{inheritedLabel("sandbox", effective)}：{effective?.sandbox || "无"}</em>
                      )}
                    </span>
                    <select
                      value={String(draft.sandbox ?? "workspace-write")}
                      onChange={(event) => updateDraft("sandbox", event.target.value)}
                    >
                      {SANDBOX_OPTIONS.map((sandbox) => (
                        <option key={sandbox} value={sandbox}>{SANDBOX_LABELS[sandbox]}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              {isApiKeyProvider(selectedProvider) && (
                <>
                  <label className="ai-provider-field">
                    <span>
                      API Key
                      {effective?.hasApiKey && (
                        <em>已配置{effective.apiKeyLastFour ? ` · 末四位 ${effective.apiKeyLastFour}` : ""}</em>
                      )}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={String(draft.apiKey ?? "")}
                      placeholder={
                        effective?.hasApiKey
                          ? "输入新 Key 以替换"
                          : (PROVIDER_GUIDES[selectedProvider].apiKeyPlaceholder ?? "API Key")
                      }
                      onChange={(event) => updateDraft("apiKey", event.target.value)}
                      disabled={!config.keychainSupported}
                    />
                  </label>
                  <label className="ai-provider-field">
                    <span>
                      Base URL
                      {scope === "project" && !scopedEntry?.baseUrl && (
                        <em>{inheritedLabel("baseUrl", effective)}：{effective?.baseUrl}</em>
                      )}
                    </span>
                    <input
                      type="url"
                      value={String(draft.baseUrl ?? "")}
                      placeholder={String(
                        effective?.baseUrl
                        ?? PROVIDER_GUIDES[selectedProvider].defaultBaseUrl
                        ?? "",
                      )}
                      onChange={(event) => updateDraft("baseUrl", event.target.value)}
                    />
                  </label>
                  <label className="ai-provider-field">
                    <span>
                      模型列表
                      {scope === "project" && !scopedEntry?.models && (
                        <em>{inheritedLabel("models", effective)}</em>
                      )}
                    </span>
                    <input
                      type="text"
                      value={String(draft.models ?? "")}
                      placeholder={(effective?.models ?? []).join(", ") || "逗号分隔"}
                      onChange={(event) => updateDraft("models", event.target.value)}
                    />
                  </label>
                  <label className="ai-provider-field">
                    <span>
                      默认模型
                      {scope === "project" && !scopedEntry?.defaultModel && (
                        <em>{inheritedLabel("defaultModel", effective)}：{effective?.defaultModel || "无"}</em>
                      )}
                    </span>
                    <input
                      type="text"
                      value={String(draft.defaultModel ?? "")}
                      placeholder={String(effective?.defaultModel ?? (effective?.models?.[0] ?? "模型 slug"))}
                      onChange={(event) => updateDraft("defaultModel", event.target.value)}
                    />
                  </label>
                </>
              )}

              {testResult && (
                <div className={`ai-provider-test-result${testResult.ok ? " is-ok" : " is-error"}`}>
                  <strong>{testResult.ok ? "检测成功" : "检测失败"}</strong>
                  <p>{testResult.detail ?? testResult.reason}</p>
                  {testResult.models && testResult.models.length > 0 && (
                    <ul>
                      {testResult.models.map((model) => (
                        <li key={model.slug}>{model.displayName}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {loginResult?.loginUrl && (
                <div className="ai-provider-test-result is-ok">
                  <strong>登录链接</strong>
                  <p>
                    <a href={loginResult.loginUrl} target="_blank" rel="noreferrer">
                      在浏览器打开登录页
                    </a>
                  </p>
                </div>
              )}

              <div className="ai-provider-form-actions">
                {supportsCliLogin && (
                  <button
                    type="button"
                    disabled={loggingIn || saving || testing}
                    onClick={() => void handleLogin()}
                  >
                    {loggingIn ? "启动登录…" : "登录"}
                  </button>
                )}
                <button type="button" disabled={testing || saving || loggingIn} onClick={() => void handleTest()}>
                  {testing ? "检测中…" : "检测连接"}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={saving || (scope === "project" && !projectId)}
                  onClick={() => void handleSave()}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                {isApiKeyProvider(selectedProvider) && effective?.hasApiKey && (
                  <button type="button" disabled={saving || !config.keychainSupported} onClick={() => void handleClearApiKey()}>
                    清除 Key
                  </button>
                )}
                <button type="button" disabled={saving} onClick={() => void handleReset()}>
                  {scope === "project" ? "删除覆盖" : "恢复默认"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
