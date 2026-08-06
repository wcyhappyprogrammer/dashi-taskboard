import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { agentActorForProvider } from "../shared/ai-agent-actor.mjs";
import {
  buildApiProviderAutomationPrompt,
  buildTaskboardAutomationPrompt,
} from "../shared/taskboard-automation.mjs";
import { ApiError } from "./database.mjs";

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 180;
const TICK_MS = 15_000;
const PROVIDER_IDS = new Set([
  "codex",
  "claude-code",
  "anthropic",
  "deepseek",
  "kimi",
  "volcengine",
  "aliyun",
  "tencent",
]);

function emptyStore() {
  return { version: 1, projects: {} };
}

function rruleFor(intervalMinutes) {
  return `RRULE:FREQ=MINUTELY;INTERVAL=${intervalMinutes}`;
}

function lastRunFromRecord(record) {
  if (!record?.lastRunAt && !record?.lastRunOutcome) return null;
  return {
    at: record.lastRunAt ?? null,
    outcome: record.lastRunOutcome ?? null,
    error: record.lastRunError ?? null,
    threadId: record.lastThreadId ?? null,
    issueId: record.lastIssueId ?? null,
    issueIdentifier: record.lastIssueIdentifier ?? null,
    mode: record.lastRunMode ?? null,
  };
}

function itemFromRecord(record) {
  return {
    id: record.automationId,
    status: record.status,
    provider: record.provider ?? null,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    rrule: rruleFor(record.intervalMinutes),
    nextRunAt: record.nextRunAt ?? null,
    lastRun: lastRunFromRecord(record),
  };
}

function policyFromRecord(record) {
  return {
    automationId: record.automationId,
    enabledByUser: record.enabledByUser,
    quotaAware: false,
    intervalMinutes: record.intervalMinutes,
    provider: record.provider ?? null,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    lastRun: lastRunFromRecord(record),
  };
}

function normalizeIntervalMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'intervalMinutes' must be an integer from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`,
    );
  }
  return minutes;
}

function collectAssistantReply(events) {
  const chunks = [];
  for (const event of events) {
    if (event.role === "assistant" && event.type === "agent_message" && event.content) {
      chunks.push(String(event.content).trim());
    }
  }
  return chunks.filter(Boolean).join("\n\n").trim();
}

export function createLocalAutomationService(options = {}) {
  const database = options.database;
  const aiChat = options.aiChat;
  const events = options.events ?? null;
  const skillPath = options.skillPath;
  const configPath = options.configPath;
  let store = emptyStore();
  let loaded = false;
  let pendingWrite = Promise.resolve();
  let timer = null;
  const runningProjects = new Set();

  function emit(type, value) {
    events?.emit?.(type, value);
  }

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = JSON.parse(await readFile(configPath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.projects) {
        store = {
          version: 1,
          projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      store = emptyStore();
    }
    loaded = true;
  }

  async function persist() {
    const snapshot = JSON.stringify(store, null, 2);
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await mkdir(path.dirname(configPath), { recursive: true });
      const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporaryPath, configPath);
    });
    await pendingWrite;
  }

  async function validateOptions(input) {
    if (typeof input.enabledByUser !== "boolean") {
      throw new ApiError(400, "INVALID_FIELD", "'enabledByUser' must be a boolean");
    }
    normalizeIntervalMinutes(input.intervalMinutes);
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 128) {
      throw new ApiError(400, "INVALID_FIELD", "'model' is required");
    }
    if (
      typeof input.reasoningEffort !== "string"
      || !input.reasoningEffort.trim()
      || input.reasoningEffort.length > 64
    ) {
      throw new ApiError(400, "INVALID_FIELD", "'reasoningEffort' is required");
    }
    if (input.provider != null && !PROVIDER_IDS.has(input.provider)) {
      throw new ApiError(400, "INVALID_FIELD", "'provider' is invalid");
    }

    const catalog = await aiChat.getCatalog(input.projectId);
    const available = (catalog.providers ?? []).filter((entry) => entry.available);
    if (available.length === 0) {
      throw new ApiError(409, "PROVIDER_UNAVAILABLE", "没有可用的 AI Provider，请先在 AI 配置中完成安装与检测");
    }
    const providerId = input.provider && available.some((entry) => entry.id === input.provider)
      ? input.provider
      : (
        available.find((entry) => (
          (catalog.models ?? []).some((model) => (
            model.provider === entry.id && model.slug === input.model
          ))
        ))?.id
        ?? available[0].id
      );
    const models = (catalog.models ?? []).filter((model) => model.provider === providerId);
    const model = models.find((entry) => entry.slug === input.model);
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        `Model '${input.model}' is not available for provider '${providerId}'`,
      );
    }
    if (!model.supportedReasoningEfforts.includes(input.reasoningEffort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${input.reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
    return { providerId, model };
  }

  function computeNextRunAt(intervalMinutes, from = Date.now()) {
    return from + intervalMinutes * 60_000;
  }

  async function applyPolicy(input) {
    await ensureLoaded();
    const projectId = input.projectId;
    if (!projectId || typeof projectId !== "string") {
      throw new ApiError(400, "INVALID_PROJECT", "projectId is required");
    }
    const project = database.getProject(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const intervalMinutes = normalizeIntervalMinutes(input.intervalMinutes);
    const validated = await validateOptions({ ...input, projectId, intervalMinutes });

    const previous = store.projects[projectId];
    const enabled = input.enabledByUser === true;
    const intervalChanged = previous?.intervalMinutes !== intervalMinutes;
    const record = {
      automationId: previous?.automationId ?? `local-${projectId}`,
      status: enabled ? "ACTIVE" : "PAUSED",
      enabledByUser: enabled,
      quotaAware: false,
      intervalMinutes,
      provider: validated.providerId,
      model: validated.model.slug,
      reasoningEffort: input.reasoningEffort.trim(),
      lastRunAt: previous?.lastRunAt ?? null,
      lastRunOutcome: previous?.lastRunOutcome ?? null,
      lastRunError: previous?.lastRunError ?? null,
      lastThreadId: previous?.lastThreadId ?? null,
      lastIssueId: previous?.lastIssueId ?? null,
      lastIssueIdentifier: previous?.lastIssueIdentifier ?? null,
      lastRunMode: previous?.lastRunMode ?? null,
      nextRunAt: enabled
        ? (
          previous?.status === "ACTIVE" && previous?.nextRunAt && !intervalChanged
            ? previous.nextRunAt
            : computeNextRunAt(intervalMinutes)
        )
        : null,
      updatedAt: new Date().toISOString(),
    };
    store.projects[projectId] = record;
    await persist();
    return {
      item: itemFromRecord(record),
      policy: policyFromRecord(record),
      quota: {
        state: "unavailable",
        checkedAt: Math.floor(Date.now() / 1000),
        reason: "local",
      },
    };
  }

  async function getState(projectId) {
    await ensureLoaded();
    const record = store.projects[projectId];
    if (!record) {
      return {
        items: [],
        policy: null,
        quota: {
          state: "unavailable",
          checkedAt: Math.floor(Date.now() / 1000),
          reason: "local",
        },
      };
    }
    return {
      items: [itemFromRecord(record)],
      item: itemFromRecord(record),
      policy: policyFromRecord(record),
      quota: {
        state: "unavailable",
        checkedAt: Math.floor(Date.now() / 1000),
        reason: "local",
      },
    };
  }

  function patchRunResult(projectId, patch) {
    const current = store.projects[projectId];
    if (!current) return;
    Object.assign(current, patch, { updatedAt: new Date().toISOString() });
    store.projects[projectId] = current;
  }

  async function runApiProviderClaim({
    task,
    thread,
    providerId,
    modelSlug,
    displayName,
  }) {
    const actor = agentActorForProvider(providerId, {
      displayName,
      model: modelSlug,
    });
    let current = database.getTask(task.id);
    if (!current || current.status !== "todo" || current.archivedAt) {
      return { outcome: "skipped", error: "议题已不在 todo" };
    }

    current = database.updateTask(current.id, current.version, { assignee: actor }, thread.id);
    emit("task.updated", { task: current });
    current = database.moveTask(current.id, current.version, "in_progress", undefined, thread.id);
    emit("task.moved", { task: current });

    const run = await aiChat.startTurn(thread.id, {
      message: buildApiProviderAutomationPrompt(current),
      skillIds: [],
    });
    const finished = await aiChat.waitForRun(run.id);
    const reply = collectAssistantReply(database.listAiChatEvents(thread.id));
    const failed = finished.status === "failed" || !reply;
    const body = reply
      || (
        finished.status === "failed"
          ? `自动认领失败：${finished.error || "模型未返回结果"}`
          : "（模型未返回可展示内容）"
      );

    current = database.getTask(current.id);
    const comment = database.createComment(current.id, {
      body,
      actor,
      threadId: thread.id,
    });
    emit("comment.created", { comment, task: current });

    current = database.getTask(current.id);
    // Success → in_review; model failure stays in_progress with error comment.
    if (!failed && current.status === "in_progress") {
      current = database.moveTask(current.id, current.version, "in_review", undefined, thread.id);
      emit("task.moved", { task: current });
    }

    return {
      outcome: failed ? "failed" : "succeeded",
      error: failed ? (finished.error || "模型未返回可展示内容") : null,
    };
  }

  async function runProject(projectId, record) {
    if (runningProjects.has(projectId)) return null;
    runningProjects.add(projectId);
    let result = {
      outcome: "skipped",
      error: null,
      threadId: null,
      issueId: null,
      issueIdentifier: null,
      mode: null,
    };
    try {
      const todos = database.listTasks({
        projectId,
        status: "todo",
        archived: "false",
      });
      if (todos.length === 0) {
        result = { ...result, outcome: "idle", error: null };
        return result;
      }

      const task = todos[0];
      result.issueId = task.id;
      result.issueIdentifier = task.identifier;
      const catalog = await aiChat.getCatalog(projectId);
      const available = (catalog.providers ?? []).filter((entry) => entry.available);
      if (available.length === 0) {
        throw new ApiError(409, "PROVIDER_UNAVAILABLE", "没有可用的 AI Provider");
      }
      const providerId = record.provider && available.some((entry) => entry.id === record.provider)
        ? record.provider
        : (
          available.find((entry) => (
            (catalog.models ?? []).some((model) => (
              model.provider === entry.id && model.slug === record.model
            ))
          ))?.id
          ?? available[0].id
        );
      const providerInfo = catalog.providers.find((entry) => entry.id === providerId);
      const providerRuntime = aiChat.providers.get(providerId);
      const modelInfo = (catalog.models ?? []).find((model) => (
        model.provider === providerId && model.slug === record.model
      )) ?? (catalog.models ?? []).find((model) => model.provider === providerId);
      if (!modelInfo) {
        throw new ApiError(409, "PROVIDER_UNAVAILABLE", `Provider '${providerId}' 没有可用模型`);
      }
      const reasoningEffort = modelInfo.supportedReasoningEfforts.includes(record.reasoningEffort)
        ? record.reasoningEffort
        : (modelInfo.defaultReasoningEffort || modelInfo.supportedReasoningEfforts[0] || "medium");
      const apiOnly = providerRuntime?.supportsSandbox === false
        || providerInfo?.supportsSandbox === false;
      const sandbox = apiOnly
        ? "workspace-write"
        : (catalog.defaults?.[providerId]?.sandbox ?? "workspace-write");

      const thread = await aiChat.createThread({
        projectId,
        issueId: task.id,
        title: `自动认领 · ${task.identifier}`,
        provider: providerId,
        model: modelInfo.slug,
        reasoningEffort,
        sandbox,
      });
      result.threadId = thread.id;
      result.mode = apiOnly ? "api" : "cli";

      if (apiOnly) {
        const claim = await runApiProviderClaim({
          task,
          thread,
          providerId,
          modelSlug: modelInfo.slug,
          displayName: providerRuntime?.displayName || providerInfo?.displayName || providerId,
        });
        result.outcome = claim.outcome;
        result.error = claim.error;
        return result;
      }

      const message = buildTaskboardAutomationPrompt({
        taskboardProjectId: projectId,
        projectName: thread.origin.projectName,
        workspacePath: thread.origin.workspacePath,
        skillPath,
        intervalMinutes: record.intervalMinutes,
        provider: providerId,
        model: modelInfo.slug,
      });
      const run = await aiChat.startTurn(thread.id, {
        message,
        skillIds: [],
      });
      const finished = await aiChat.waitForRun(run.id);
      if (finished.status === "failed") {
        result.outcome = "failed";
        result.error = finished.error || "CLI Agent 执行失败";
      } else if (finished.status === "interrupted") {
        result.outcome = "failed";
        result.error = "CLI Agent 被中断";
      } else {
        result.outcome = "succeeded";
        result.error = null;
      }
      return result;
    } finally {
      runningProjects.delete(projectId);
    }
  }

  async function tick() {
    await ensureLoaded();
    const now = Date.now();
    for (const [projectId, record] of Object.entries(store.projects)) {
      if (record.status !== "ACTIVE" || !record.enabledByUser) continue;
      if (runningProjects.has(projectId)) continue;
      if (Number.isFinite(record.nextRunAt) && record.nextRunAt > now) continue;
      let runResult = {
        outcome: "failed",
        error: null,
        threadId: null,
        issueId: null,
        issueIdentifier: null,
        mode: null,
      };
      try {
        runResult = await runProject(projectId, record) ?? runResult;
      } catch (error) {
        runResult.outcome = "failed";
        runResult.error = error?.message || String(error);
        console.error(`[local-automation] ${projectId}: ${runResult.error}`);
      }
      const current = store.projects[projectId];
      if (!current || current.status !== "ACTIVE") continue;
      patchRunResult(projectId, {
        lastRunAt: now,
        lastRunOutcome: runResult.outcome,
        lastRunError: runResult.error,
        lastThreadId: runResult.threadId,
        lastIssueId: runResult.issueId,
        lastIssueIdentifier: runResult.issueIdentifier,
        lastRunMode: runResult.mode,
        nextRunAt: computeNextRunAt(current.intervalMinutes, now),
      });
      await persist();
    }
  }

  return {
    async start() {
      await ensureLoaded();
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, TICK_MS);
      timer.unref?.();
      void tick();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    applyPolicy,
    getState,
    tick,
  };
}

export { rruleFor, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES };
