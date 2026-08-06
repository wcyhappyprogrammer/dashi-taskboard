import { ApiError } from "./database.mjs";

const LARK_SYNC_ACTOR = {
  type: "agent",
  id: "lark-sync",
  name: "Lark Sync",
  avatarUrl: null,
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.tasks)) return value.tasks;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function taskGuid(entry) {
  return entry?.guid
    || entry?.task_guid
    || entry?.taskGuid
    || entry?.id
    || entry?.task?.guid
    || null;
}

function taskTitle(entry) {
  return String(
    entry?.summary
    || entry?.title
    || entry?.name
    || entry?.task?.summary
    || entry?.task?.title
    || "Lark task",
  ).trim() || "Lark task";
}

function taskCompleted(entry) {
  if (entry?.completed === true || entry?.is_completed === true) return true;
  const status = String(entry?.status || entry?.task?.status || "").toLowerCase();
  return status === "done" || status === "completed" || status === "complete";
}

function taskUpdatedAt(entry) {
  const raw = entry?.updated_at || entry?.updatedAt || entry?.modify_time || entry?.modified_at;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function createLarkTaskSync(options = {}) {
  const lark = options.lark;
  const database = options.database;
  const events = options.events;
  let timer = null;
  let running = false;
  let lastSyncAt = 0;

  function emit(type, value) {
    events?.emit?.(type, { ...value, source: "lark-sync" });
  }

  async function pullOnce() {
    const config = await lark.getInternalConfig();
    if (!config.enabled || !config.sync?.enabled) {
      return { ok: false, skipped: true, reason: "sync disabled" };
    }
    const projectId = config.sync.projectId;
    if (!projectId) {
      throw new ApiError(400, "INVALID_FIELD", "sync.projectId is required");
    }
    if (!database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }

    const listed = await lark.listTasks({ taskListGuid: config.sync.taskListGuid || undefined });
    const remoteTasks = asArray(listed.data);
    const mappings = { ...(config.sync.mappings || {}) };
    let created = 0;
    let updated = 0;

    for (const remote of remoteTasks) {
      const guid = taskGuid(remote);
      if (!guid) continue;
      const title = taskTitle(remote);
      const completed = taskCompleted(remote);
      const remoteUpdatedAt = taskUpdatedAt(remote);
      const mapping = mappings[guid];
      const status = completed ? "done" : "todo";

      if (!mapping?.issueId) {
        const task = database.createTask({
          projectId,
          title,
          description: `Synced from Lark task ${guid}`,
          status,
          priority: "none",
          labels: ["lark-sync"],
          actor: LARK_SYNC_ACTOR,
          assignee: LARK_SYNC_ACTOR,
          workflowId: null,
          dueDate: null,
          recurrence: null,
          developmentContext: null,
        });
        mappings[guid] = {
          issueId: task.id,
          larkUpdatedAt: remoteUpdatedAt,
          localUpdatedAt: Date.parse(task.updatedAt) || Date.now(),
        };
        created += 1;
        emit("task.created", { task });
        continue;
      }

      let local;
      try {
        local = database.getTask(mapping.issueId);
      } catch {
        local = null;
      }
      if (!local || local.projectId !== projectId) {
        const task = database.createTask({
          projectId,
          title,
          description: `Synced from Lark task ${guid}`,
          status,
          priority: "none",
          labels: ["lark-sync"],
          actor: LARK_SYNC_ACTOR,
          assignee: LARK_SYNC_ACTOR,
          workflowId: null,
          dueDate: null,
          recurrence: null,
          developmentContext: null,
        });
        mappings[guid] = {
          issueId: task.id,
          larkUpdatedAt: remoteUpdatedAt,
          localUpdatedAt: Date.parse(task.updatedAt) || Date.now(),
        };
        created += 1;
        emit("task.created", { task });
        continue;
      }

      const localUpdatedAt = Date.parse(local.updatedAt) || 0;
      const mappingLocal = mapping.localUpdatedAt || 0;
      const mappingRemote = mapping.larkUpdatedAt || 0;
      // Last-write-wins: only pull when remote is newer than last synced remote stamp
      // and not behind a newer local edit we already tracked.
      if (remoteUpdatedAt && remoteUpdatedAt <= mappingRemote) {
        continue;
      }
      if (localUpdatedAt > mappingLocal && localUpdatedAt > remoteUpdatedAt) {
        continue;
      }

      const changes = {};
      if (local.title !== title) changes.title = title;
      if (local.status !== status) changes.status = status;
      if (Object.keys(changes).length === 0) {
        mappings[guid] = {
          ...mapping,
          larkUpdatedAt: remoteUpdatedAt || mapping.larkUpdatedAt,
        };
        continue;
      }
      const task = database.updateTask(local.id, local.version, changes, null);
      mappings[guid] = {
        issueId: task.id,
        larkUpdatedAt: remoteUpdatedAt || Date.now(),
        localUpdatedAt: Date.parse(task.updatedAt) || Date.now(),
      };
      updated += 1;
      emit(changes.status && changes.status !== local.status ? "task.moved" : "task.updated", { task });
    }

    for (const [guid, mapping] of Object.entries(mappings)) {
      await lark.updateMapping(guid, mapping);
    }

    return {
      ok: true,
      created,
      updated,
      remoteCount: remoteTasks.length,
      mappingCount: Object.keys(mappings).length,
    };
  }

  async function writebackTask(task) {
    const config = await lark.getInternalConfig();
    if (!config.enabled || !config.sync?.enabled || !config.sync.writeback) return;
    if (config.sync.direction !== "bidirectional" && config.sync.direction !== "pull") {
      // pull still allows completion writeback when writeback=true
    }
    const mappings = config.sync.mappings || {};
    const entry = Object.entries(mappings).find(([, value]) => value?.issueId === task.id);
    if (!entry) return;
    const [guid, mapping] = entry;
    if (task.status !== "done") {
      await lark.updateMapping(guid, {
        ...mapping,
        localUpdatedAt: Date.parse(task.updatedAt) || Date.now(),
      });
      return;
    }
    try {
      await lark.completeTask({ taskGuid: guid });
      await lark.updateMapping(guid, {
        ...mapping,
        localUpdatedAt: Date.parse(task.updatedAt) || Date.now(),
        larkUpdatedAt: Date.now(),
      });
      await lark.setLastError(null);
    } catch (error) {
      await lark.setLastError(error?.message || String(error)).catch(() => {});
    }
  }

  async function handleLocalEvent(type, value) {
    if (value?.source === "lark-sync") return;
    if (!["task.updated", "task.moved"].includes(type)) return;
    const task = value?.task;
    if (!task) return;
    void writebackTask(task);
  }

  async function runSync() {
    if (running) return { ok: false, skipped: true, reason: "already running" };
    running = true;
    try {
      const result = await pullOnce();
      await lark.setLastError(null);
      return result;
    } catch (error) {
      await lark.setLastError(error?.message || String(error)).catch(() => {});
      throw error;
    } finally {
      running = false;
    }
  }

  async function tick() {
    try {
      const config = await lark.getInternalConfig();
      if (!config.enabled || !config.sync?.enabled) return;
      const intervalMs = Math.max(15, Number(config.sync.intervalSeconds) || 60) * 1000;
      if (Date.now() - lastSyncAt < intervalMs) return;
      lastSyncAt = Date.now();
      await runSync();
    } catch {
      // Keep timer alive; errors are stored on config.lastError.
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, 15_000);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function attach(eventHub) {
    eventHub?.onLocal?.((type, value) => {
      void handleLocalEvent(type, value);
    });
    start();
  }

  return {
    runSync,
    attach,
    start,
    stop,
    handleLocalEvent,
  };
}
