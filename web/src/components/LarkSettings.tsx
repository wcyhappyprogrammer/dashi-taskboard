import { useEffect, useState } from "react";

import {
  getLarkSettings,
  installLarkSkills,
  listLarkChats,
  runLarkSync,
  saveLarkSettings,
  testLarkConnection,
} from "../api";
import type { LarkChatOption, LarkSettingsConfig, LarkTestResult, Project } from "../types";
import { LinearIcon } from "./LinearIcon";

interface LarkSettingsProps {
  projects: Project[];
  onClose: () => void;
}

const NOTIFY_EVENT_OPTIONS = [
  { value: "task.created", label: "创建议题" },
  { value: "task.updated", label: "更新议题" },
  { value: "task.moved", label: "移动议题" },
  { value: "task.archived", label: "归档议题" },
  { value: "task.restored", label: "恢复议题" },
] as const;

const SETUP_COMMANDS = [
  {
    id: "install",
    label: "1. 安装",
    command: "npx @larksuite/cli@latest install",
  },
  {
    id: "config",
    label: "2. 初始化",
    command: "lark-cli config init",
  },
  {
    id: "login",
    label: "3. 登录授权",
    command: "lark-cli auth login --recommend",
  },
] as const;

function emptyConfig(): LarkSettingsConfig {
  return {
    enabled: true,
    executable: "lark-cli",
    defaultAs: "user",
    lastError: null,
    lastTestedAt: null,
    notify: {
      enabled: false,
      events: ["task.created", "task.updated", "task.moved"],
      recipientType: "chat",
      userId: "",
      chatId: "",
    },
    sync: {
      enabled: false,
      direction: "pull",
      projectId: null,
      taskListGuid: "",
      intervalSeconds: 60,
      writeback: true,
      mappingCount: 0,
    },
    ai: {
      skillsInstalledAt: null,
      skillsDetail: null,
    },
  };
}

export function LarkSettings({ projects, onClose }: LarkSettingsProps) {
  const [config, setConfig] = useState<LarkSettingsConfig>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [installingSkills, setInstallingSkills] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<LarkTestResult | null>(null);
  const [copiedCommandId, setCopiedCommandId] = useState<string | null>(null);
  const [chats, setChats] = useState<LarkChatOption[]>([]);
  const [chatQuery, setChatQuery] = useState("");
  const [loadingChats, setLoadingChats] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  async function copyCommand(id: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommandId(id);
      window.setTimeout(() => {
        setCopiedCommandId((current) => (current === id ? null : current));
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制失败");
    }
  }

  async function loadChats(query = chatQuery) {
    setLoadingChats(true);
    setChatError(null);
    try {
      const response = await listLarkChats({
        query,
        as: config.defaultAs,
      });
      setChats(response.chats);
      if (response.chats.length === 0) {
        setChatError(query.trim() ? "没有匹配的群聊" : "未找到已加入的群聊");
      }
    } catch (err) {
      setChats([]);
      setChatError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingChats(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getLarkSettings(controller.signal)
      .then((response) => {
        setConfig(response.config);
        setError(null);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (loading || config.notify.recipientType !== "chat") return;
    if (chats.length > 0 || loadingChats) return;
    void loadChats("");
    // Intentionally load once when switching to chat recipient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, config.notify.recipientType]);

  async function handleSave() {
    setSaving(true);
    setBanner(null);
    setError(null);
    try {
      const notify = { ...config.notify };
      if (notify.enabled) {
        if (notify.recipientType === "chat" && !notify.chatId?.trim()) {
          throw new Error("启用群聊通知时请先选择或填写群聊");
        }
        if (notify.recipientType === "user" && !notify.userId?.trim()) {
          throw new Error("启用指定用户通知时请填写用户 ID");
        }
      }
      const response = await saveLarkSettings({
        enabled: config.enabled,
        executable: config.executable,
        defaultAs: config.defaultAs,
        notify,
        sync: {
          enabled: config.sync.enabled,
          direction: "pull",
          projectId: config.sync.projectId,
          taskListGuid: config.sync.taskListGuid,
          intervalSeconds: config.sync.intervalSeconds,
          writeback: config.sync.writeback,
        },
      });
      setConfig(response.config);
      setBanner(
        response.config.notify.enabled
          ? "已保存飞书配置（通知已启用）"
          : "已保存飞书配置",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setBanner(null);
    setError(null);
    try {
      const result = await testLarkConnection({ executable: config.executable });
      setTestResult(result);
      setBanner(result.ok ? "连接正常：已安装且已登录" : (result.detail || "连接失败"));
      if (!result.ok) setError(result.detail || "连接失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function handleInstallSkills() {
    setInstallingSkills(true);
    setBanner(null);
    setError(null);
    try {
      const result = await installLarkSkills();
      setBanner(result.detail || "Lark Skills 已安装");
      const response = await getLarkSettings();
      setConfig(response.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingSkills(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setBanner(null);
    setError(null);
    try {
      await handleSave();
      const result = await runLarkSync();
      if (result.skipped) {
        setBanner(result.reason || "同步已跳过");
      } else {
        setBanner(`同步完成：新建 ${result.created ?? 0}，更新 ${result.updated ?? 0}`);
      }
      const response = await getLarkSettings();
      setConfig(response.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  function toggleNotifyEvent(eventName: string) {
    setConfig((current) => {
      const events = current.notify.events.includes(eventName)
        ? current.notify.events.filter((entry) => entry !== eventName)
        : [...current.notify.events, eventName];
      return {
        ...current,
        notify: { ...current.notify, events },
      };
    });
  }

  return (
    <section className="ai-provider-settings lark-settings" aria-label="飞书 / Lark 配置">
      <header className="ai-provider-settings-header">
        <div>
          <p className="ai-provider-settings-kicker">Integrations</p>
          <h1>飞书 / Lark</h1>
          <p>凭证留在本机 lark-cli；Taskboard 只保存可执行文件路径与业务开关。</p>
        </div>
        <button type="button" className="theme-toggle" onClick={onClose} aria-label="关闭飞书配置">
          <span aria-hidden="true"><LinearIcon name="close" /></span>
          关闭
        </button>
      </header>

      <div className="ai-provider-guide">
        <strong>接入步骤</strong>
        <p>安装 CLI → 本机登录 → 检测连接。不要把 App Secret 填进 Taskboard。</p>
        <div className="lark-setup-commands">
          {SETUP_COMMANDS.map((entry) => (
            <div key={entry.id} className="lark-setup-command">
              <span className="lark-setup-command-label">{entry.label}</span>
              <div className="lark-setup-command-row">
                <code>{entry.command}</code>
                <button
                  type="button"
                  onClick={() => void copyCommand(entry.id, entry.command)}
                  aria-label={`复制 ${entry.label} 命令`}
                  title="复制命令"
                >
                  <LinearIcon name="copy" />
                  <span>{copiedCommandId === entry.id ? "已复制" : "复制"}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="lark-setup-next">完成后回到此页点击「检测连接」。</p>
        <div className="ai-provider-guide-links">
          <a href="https://github.com/larksuite/cli" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://www.feishu.cn/feishu-cli" target="_blank" rel="noreferrer">飞书 CLI 介绍</a>
        </div>
      </div>

      {loading ? (
        <p className="ai-provider-form-empty">正在加载配置…</p>
      ) : (
        <div className="ai-provider-form lark-settings-form">
          {(error || config.lastError || banner) && (
            <p className={`ai-provider-settings-banner${error || config.lastError ? " is-error" : ""}`}>
              {error || (config.lastError ? `飞书错误：${config.lastError}` : null) || banner}
            </p>
          )}

          <label className="ai-provider-field">
            <span>启用 Lark 桥</span>
            <button
              type="button"
              className={`board-setting-switch${config.enabled ? " is-on" : ""}`}
              role="switch"
              aria-checked={config.enabled}
              onClick={() => setConfig((current) => ({ ...current, enabled: !current.enabled }))}
            >
              <span aria-hidden="true" />
            </button>
          </label>

          <label className="ai-provider-field">
            <span>可执行文件</span>
            <input
              type="text"
              value={config.executable}
              placeholder="lark-cli"
              onChange={(event) => setConfig((current) => ({
                ...current,
                executable: event.target.value,
              }))}
            />
          </label>

          <label className="ai-provider-field">
            <span>默认身份</span>
            <select
              value={config.defaultAs}
              onChange={(event) => setConfig((current) => ({
                ...current,
                defaultAs: event.target.value as "user" | "bot",
              }))}
            >
              <option value="user">user（用户身份）</option>
              <option value="bot">bot（机器人）</option>
            </select>
          </label>

          <div className="lark-settings-actions">
            <button type="button" onClick={() => void handleTest()} disabled={testing}>
              {testing ? "检测中…" : "检测连接"}
            </button>
            <button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>

          {testResult && (
            <p className="ai-provider-form-heading">
              <small>
                {testResult.installed ? "已安装" : "未安装"}
                {" · "}
                {testResult.loggedIn ? "已登录" : "未登录"}
                {" · "}
                {testResult.executable}
              </small>
            </p>
          )}

          <div className="ai-provider-form-heading">
            <h2>任务板通知</h2>
            <p>
              议题变更后通过 lark-cli 发飞书消息。选择群聊并保存后会自动启用通知；
              失败不阻断任务 API，错误显示在本页顶部。
            </p>
          </div>

          <label className="ai-provider-field">
            <span>启用通知</span>
            <button
              type="button"
              className={`board-setting-switch${config.notify.enabled ? " is-on" : ""}`}
              role="switch"
              aria-checked={config.notify.enabled}
              onClick={() => setConfig((current) => ({
                ...current,
                notify: { ...current.notify, enabled: !current.notify.enabled },
              }))}
            >
              <span aria-hidden="true" />
            </button>
          </label>

          <label className="ai-provider-field">
            <span>接收对象</span>
            <select
              value={config.notify.recipientType}
              onChange={(event) => setConfig((current) => ({
                ...current,
                notify: {
                  ...current.notify,
                  recipientType: event.target.value as "self" | "user" | "chat",
                },
              }))}
            >
              <option value="self">自己</option>
              <option value="user">指定用户</option>
              <option value="chat">群聊</option>
            </select>
          </label>

          {config.notify.recipientType === "user" && (
            <label className="ai-provider-field">
              <span>用户 ID</span>
              <input
                type="text"
                value={config.notify.userId}
                onChange={(event) => setConfig((current) => ({
                  ...current,
                  notify: { ...current.notify, userId: event.target.value },
                }))}
              />
            </label>
          )}

          {config.notify.recipientType === "chat" && (
            <div className="lark-chat-picker">
              <div className="ai-provider-form-heading">
                <h2>选择群聊</h2>
                <p>从你已加入的群里点选即可，不必手抄群 ID。</p>
              </div>
              <div className="lark-chat-picker-toolbar">
                <input
                  type="search"
                  value={chatQuery}
                  placeholder="按群名搜索…"
                  aria-label="搜索群聊"
                  onChange={(event) => setChatQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void loadChats(chatQuery);
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void loadChats(chatQuery)}
                  disabled={loadingChats}
                >
                  {loadingChats ? "加载中…" : chats.length > 0 ? "刷新" : "加载群聊"}
                </button>
              </div>
              {chatError && <p className="workflow-inspector-error">{chatError}</p>}
              {chats.length > 0 && (
                <label className="ai-provider-field">
                  <span>群聊</span>
                  <select
                    aria-label="选择通知群聊"
                    value={config.notify.chatId}
                    onChange={(event) => setConfig((current) => ({
                      ...current,
                      notify: {
                        ...current.notify,
                        chatId: event.target.value,
                        enabled: event.target.value ? true : current.notify.enabled,
                      },
                    }))}
                  >
                    <option value="">请选择群聊</option>
                    {chats.map((chat) => (
                      <option key={chat.chatId} value={chat.chatId}>
                        {chat.name}{chat.external ? " · 外部" : ""}
                      </option>
                    ))}
                    {config.notify.chatId
                      && !chats.some((chat) => chat.chatId === config.notify.chatId)
                      && (
                        <option value={config.notify.chatId}>
                          已保存：{config.notify.chatId}
                        </option>
                      )}
                  </select>
                </label>
              )}
              <label className="ai-provider-field">
                <span>群聊 ID（可选手填）</span>
                <input
                  type="text"
                  value={config.notify.chatId}
                  placeholder="oc_…"
                  onChange={(event) => setConfig((current) => ({
                    ...current,
                    notify: {
                      ...current.notify,
                      chatId: event.target.value,
                      enabled: event.target.value.trim() ? true : current.notify.enabled,
                    },
                  }))}
                />
              </label>
              {config.notify.chatId && (
                <p className="lark-setup-next">
                  当前：
                  {chats.find((chat) => chat.chatId === config.notify.chatId)?.name
                    || config.notify.chatId}
                  {config.notify.enabled ? " · 通知已开" : " · 保存后将自动开启通知"}
                </p>
              )}
            </div>
          )}

          <div className="lark-settings-events">
            <span>通知事件</span>
            <div>
              {NOTIFY_EVENT_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={config.notify.events.includes(option.value)}
                    onChange={() => toggleNotifyEvent(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          <div className="ai-provider-form-heading">
            <h2>任务同步</h2>
            <p>
              当前仅支持「从飞书拉取到看板」；看板完成状态可选择回写飞书。
              不支持真正的双向实时同步。
            </p>
          </div>

          <label className="ai-provider-field">
            <span>启用同步</span>
            <button
              type="button"
              className={`board-setting-switch${config.sync.enabled ? " is-on" : ""}`}
              role="switch"
              aria-checked={config.sync.enabled}
              onClick={() => setConfig((current) => ({
                ...current,
                sync: { ...current.sync, enabled: !current.sync.enabled },
              }))}
            >
              <span aria-hidden="true" />
            </button>
          </label>

          <label className="ai-provider-field">
            <span>目标项目</span>
            <select
              value={config.sync.projectId ?? ""}
              onChange={(event) => setConfig((current) => ({
                ...current,
                sync: {
                  ...current.sync,
                  projectId: event.target.value || null,
                },
              }))}
            >
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <label className="ai-provider-field">
            <span>飞书任务清单 GUID</span>
            <input
              type="text"
              value={config.sync.taskListGuid}
              placeholder="可选"
              onChange={(event) => setConfig((current) => ({
                ...current,
                sync: { ...current.sync, taskListGuid: event.target.value },
              }))}
            />
          </label>

          <label className="ai-provider-field">
            <span>完成回写飞书</span>
            <button
              type="button"
              className={`board-setting-switch${config.sync.writeback ? " is-on" : ""}`}
              role="switch"
              aria-checked={config.sync.writeback}
              onClick={() => setConfig((current) => ({
                ...current,
                sync: { ...current.sync, writeback: !current.sync.writeback },
              }))}
            >
              <span aria-hidden="true" />
            </button>
          </label>

          <div className="lark-settings-actions">
            <button type="button" onClick={() => void handleSync()} disabled={syncing}>
              {syncing ? "同步中…" : "立即同步"}
            </button>
            <small>已映射 {config.sync.mappingCount} 条</small>
          </div>

          <div className="ai-provider-form-heading">
            <h2>给 AI 使用</h2>
            <p>Codex / Claude Code 可调用本机 lark-cli。Anthropic API 模式无本地 shell，不支持。</p>
          </div>

          <div className="lark-settings-actions">
            <button type="button" onClick={() => void handleInstallSkills()} disabled={installingSkills}>
              {installingSkills ? "安装中…" : "安装 / 检查 Lark Skills"}
            </button>
            {config.ai.skillsInstalledAt && (
              <small>上次：{new Date(config.ai.skillsInstalledAt).toLocaleString()}</small>
            )}
          </div>
          {config.ai.skillsDetail && (
            <p className="ai-provider-form-empty">{config.ai.skillsDetail}</p>
          )}
        </div>
      )}
    </section>
  );
}
