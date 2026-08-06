import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";
import {
  buildTaskboardAutomationPrompt,
} from "../shared/taskboard-automation.mjs";

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

function itemFromRecord(record) {
  return {
    id: record.automationId,
    status: record.status,
    provider: record.provider ?? null,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    rrule: rruleFor(record.intervalMinutes),
    nextRunAt: record.nextRunAt ?? null,
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

export function createLocalAutomationService(options = {}) {
  const database = options.database;
  const aiChat = options.aiChat;
  const skillPath = options.skillPath;
  const configPath = options.configPath;
  let store = emptyStore();
  let loaded = false;
  let pendingWrite = Promise.resolve();
  let timer = null;
  const runningProjects = new Set();

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

  async function runProject(projectId, record) {
    if (runningProjects.has(projectId)) return;
    runningProjects.add(projectId);
    try {
      const todos = database.listTasks({
        projectId,
        status: "todo",
        archived: "false",
      });
      if (todos.length === 0) return;

      const task = todos[0];
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
      const modelInfo = (catalog.models ?? []).find((model) => (
        model.provider === providerId && model.slug === record.model
      )) ?? (catalog.models ?? []).find((model) => model.provider === providerId);
      if (!modelInfo) {
        throw new ApiError(409, "PROVIDER_UNAVAILABLE", `Provider '${providerId}' 没有可用模型`);
      }
      const reasoningEffort = modelInfo.supportedReasoningEfforts.includes(record.reasoningEffort)
        ? record.reasoningEffort
        : (modelInfo.defaultReasoningEffort || modelInfo.supportedReasoningEfforts[0] || "medium");
      const sandbox = providerInfo?.supportsSandbox === false
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
      const message = buildTaskboardAutomationPrompt({
        taskboardProjectId: projectId,
        projectName: thread.origin.projectName,
        workspacePath: thread.origin.workspacePath,
        skillPath,
        intervalMinutes: record.intervalMinutes,
        provider: providerId,
        model: modelInfo.slug,
      });
      await aiChat.startTurn(thread.id, {
        message,
        skillIds: [],
      });
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
      try {
        await runProject(projectId, record);
      } catch (error) {
        console.error(`[local-automation] ${projectId}: ${error?.message || error}`);
      }
      const current = store.projects[projectId];
      if (!current || current.status !== "ACTIVE") continue;
      current.lastRunAt = now;
      current.nextRunAt = computeNextRunAt(current.intervalMinutes, now);
      current.updatedAt = new Date().toISOString();
      store.projects[projectId] = current;
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
