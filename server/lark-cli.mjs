import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./database.mjs";
import {
  cappedText,
  resolveCommandExecutable,
} from "./ai-providers/shared.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const NOTIFY_EVENTS = new Set([
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
]);

function emptyConfig() {
  return {
    version: CONFIG_VERSION,
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
      mappings: {},
    },
    ai: {
      skillsInstalledAt: null,
      skillsDetail: null,
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value, name, { maxLength = 4096, allowEmpty = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' is too long`);
  }
  return trimmed;
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a boolean`);
  }
  return value;
}

function optionalInteger(value, name, { min, max } = {}) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be <= ${max}`);
  }
  return value;
}

function defaultExecutableCandidates(home = homedir()) {
  return [
    path.join(home, ".local/bin/lark-cli"),
    path.join(home, "bin/lark-cli"),
    "/usr/local/bin/lark-cli",
    "/opt/homebrew/bin/lark-cli",
  ];
}

function parseJsonEnvelope(stdout, stderr) {
  const text = String(stdout || "").trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed)) return parsed;
    } catch {}
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (isPlainObject(parsed)) return parsed;
      } catch {}
    }
  }
  const errText = String(stderr || "").trim();
  if (errText) {
    try {
      const parsed = JSON.parse(errText);
      if (isPlainObject(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function sanitizeNotify(input = {}, current = emptyConfig().notify) {
  if (!isPlainObject(input)) {
    throw new ApiError(400, "INVALID_BODY", "'notify' must be an object");
  }
  const next = { ...current };
  const enabled = optionalBoolean(input.enabled, "notify.enabled");
  if (enabled !== undefined) next.enabled = enabled;
  if (input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.some((entry) => typeof entry !== "string")) {
      throw new ApiError(400, "INVALID_FIELD", "'notify.events' must be an array of strings");
    }
    next.events = [...new Set(input.events.map((entry) => entry.trim()).filter((entry) => (
      NOTIFY_EVENTS.has(entry)
    )))];
  }
  if (input.recipientType !== undefined) {
    if (!["self", "user", "chat"].includes(input.recipientType)) {
      throw new ApiError(400, "INVALID_FIELD", "'notify.recipientType' must be self, user, or chat");
    }
    next.recipientType = input.recipientType;
  }
  const userId = optionalString(input.userId, "notify.userId", { allowEmpty: true, maxLength: 256 });
  if (userId !== undefined) next.userId = userId ?? "";
  const chatId = optionalString(input.chatId, "notify.chatId", { allowEmpty: true, maxLength: 256 });
  if (chatId !== undefined) next.chatId = chatId ?? "";
  // Selecting a chat/user implies the user wants notifications; auto-enable.
  if (next.chatId && next.recipientType === "chat" && enabled === undefined && !current.enabled) {
    next.enabled = true;
  }
  if (next.userId && next.recipientType === "user" && enabled === undefined && !current.enabled) {
    next.enabled = true;
  }
  if (next.enabled) {
    if (next.recipientType === "chat" && !String(next.chatId || "").trim()) {
      throw new ApiError(400, "INVALID_FIELD", "启用群聊通知时必须填写 chatId");
    }
    if (next.recipientType === "user" && !String(next.userId || "").trim()) {
      throw new ApiError(400, "INVALID_FIELD", "启用指定用户通知时必须填写 userId");
    }
    if (!Array.isArray(next.events) || next.events.length === 0) {
      next.events = ["task.created", "task.updated", "task.moved"];
    }
  }
  return next;
}

function sanitizeSync(input = {}, current = emptyConfig().sync) {
  if (!isPlainObject(input)) {
    throw new ApiError(400, "INVALID_BODY", "'sync' must be an object");
  }
  const next = {
    ...current,
    mappings: isPlainObject(current.mappings) ? { ...current.mappings } : {},
  };
  const enabled = optionalBoolean(input.enabled, "sync.enabled");
  if (enabled !== undefined) next.enabled = enabled;
  if (input.direction !== undefined) {
    // Only pull (+ optional done writeback) is implemented; coerce legacy bidirectional.
    if (!["pull", "bidirectional"].includes(input.direction)) {
      throw new ApiError(400, "INVALID_FIELD", "'sync.direction' must be pull");
    }
    next.direction = "pull";
  }
  if (input.projectId !== undefined) {
    next.projectId = optionalString(input.projectId, "sync.projectId", { allowEmpty: true, maxLength: 128 }) || null;
  }
  const taskListGuid = optionalString(input.taskListGuid, "sync.taskListGuid", {
    allowEmpty: true,
    maxLength: 256,
  });
  if (taskListGuid !== undefined) next.taskListGuid = taskListGuid ?? "";
  const intervalSeconds = optionalInteger(input.intervalSeconds, "sync.intervalSeconds", {
    min: 15,
    max: 3600,
  });
  if (intervalSeconds !== undefined) next.intervalSeconds = intervalSeconds;
  const writeback = optionalBoolean(input.writeback, "sync.writeback");
  if (writeback !== undefined) next.writeback = writeback;
  return next;
}

function sanitizeConfigPatch(input = {}, current = emptyConfig()) {
  if (!isPlainObject(input)) {
    throw new ApiError(400, "INVALID_BODY", "Lark configuration must be an object");
  }
  const next = {
    ...current,
    notify: { ...current.notify },
    sync: {
      ...current.sync,
      mappings: isPlainObject(current.sync?.mappings) ? { ...current.sync.mappings } : {},
    },
    ai: { ...current.ai },
  };
  const enabled = optionalBoolean(input.enabled, "enabled");
  if (enabled !== undefined) next.enabled = enabled;
  const executable = optionalString(input.executable, "executable", { maxLength: 1024 });
  if (executable !== undefined) next.executable = executable || "lark-cli";
  if (input.defaultAs !== undefined) {
    if (!["user", "bot"].includes(input.defaultAs)) {
      throw new ApiError(400, "INVALID_FIELD", "'defaultAs' must be user or bot");
    }
    next.defaultAs = input.defaultAs;
  }
  if (input.notify !== undefined) next.notify = sanitizeNotify(input.notify, next.notify);
  if (input.sync !== undefined) next.sync = sanitizeSync(input.sync, next.sync);
  return next;
}

function publicConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    executable: config.executable || "lark-cli",
    defaultAs: config.defaultAs === "bot" ? "bot" : "user",
    lastError: config.lastError ?? null,
    lastTestedAt: config.lastTestedAt ?? null,
    notify: {
      enabled: Boolean(config.notify?.enabled),
      events: Array.isArray(config.notify?.events) ? config.notify.events : [],
      recipientType: config.notify?.recipientType ?? "chat",
      userId: config.notify?.userId ?? "",
      chatId: config.notify?.chatId ?? "",
    },
    sync: {
      enabled: Boolean(config.sync?.enabled),
      direction: "pull",
      projectId: config.sync?.projectId ?? null,
      taskListGuid: config.sync?.taskListGuid ?? "",
      intervalSeconds: Number.isInteger(config.sync?.intervalSeconds)
        ? config.sync.intervalSeconds
        : 60,
      writeback: config.sync?.writeback !== false,
      mappingCount: Object.keys(config.sync?.mappings ?? {}).length,
    },
    ai: {
      skillsInstalledAt: config.ai?.skillsInstalledAt ?? null,
      skillsDetail: config.ai?.skillsDetail ?? null,
    },
  };
}

export function createLarkCliService(options = {}) {
  const configPath = options.configPath;
  const env = options.env ?? process.env;
  let config = emptyConfig();
  let loaded = false;
  let pendingWrite = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = JSON.parse(await readFile(configPath, "utf8"));
      if (isPlainObject(raw)) {
        config = sanitizeConfigPatch(raw, emptyConfig());
        config.version = CONFIG_VERSION;
        if (isPlainObject(raw.sync?.mappings)) {
          config.sync.mappings = { ...raw.sync.mappings };
        }
        if (isPlainObject(raw.ai)) {
          config.ai = {
            skillsInstalledAt: raw.ai.skillsInstalledAt ?? null,
            skillsDetail: raw.ai.skillsDetail ?? null,
          };
        }
        config.lastError = typeof raw.lastError === "string" ? raw.lastError : null;
        config.lastTestedAt = typeof raw.lastTestedAt === "string" ? raw.lastTestedAt : null;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    loaded = true;
  }

  async function persist() {
    await ensureLoaded();
    const snapshot = structuredClone(config);
    pendingWrite = pendingWrite.then(async () => {
      await mkdir(path.dirname(configPath), { recursive: true });
      const tempPath = `${configPath}.${process.pid}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, configPath);
    });
    await pendingWrite;
  }

  async function resolveExecutable(override) {
    await ensureLoaded();
    const command = (
      (typeof override === "string" && override.trim())
      || env.LARK_CLI_EXECUTABLE
      || config.executable
      || "lark-cli"
    ).trim();
    return resolveCommandExecutable(command, {
      env,
      candidates: defaultExecutableCandidates(),
    });
  }

  async function discover(overrideExecutable) {
    const executable = await resolveExecutable(overrideExecutable);
    try {
      await access(executable, constants.X_OK);
      return { executable, installed: true };
    } catch {
      try {
        await execFileAsync(executable, ["--version"], {
          env,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        });
        return { executable, installed: true };
      } catch (error) {
        return {
          executable,
          installed: false,
          reason: error?.code === "ENOENT"
            ? `Executable '${executable}' was not found`
            : cappedText(error?.stderr || error?.message || String(error)),
        };
      }
    }
  }

  async function runCommand(args, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    executable: overrideExecutable,
  } = {}) {
    const discovered = await discover(overrideExecutable);
    if (!discovered.installed) {
      throw new ApiError(409, "LARK_CLI_MISSING", discovered.reason || "lark-cli is not installed");
    }
    const argv = Array.isArray(args) ? args.map(String) : [];
    // Prefer --json: auth/status-style commands reject --format, while service
    // shortcuts accept --json as a shorthand for structured output.
    if (!argv.includes("--json") && !argv.includes("--format")) {
      argv.push("--json");
    }
    try {
      const { stdout, stderr } = await execFileAsync(discovered.executable, argv, {
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      const envelope = parseJsonEnvelope(stdout, stderr);
      if (!envelope) {
        return {
          ok: true,
          identity: null,
          data: stdout?.trim() || null,
          rawStdout: cappedText(stdout),
          rawStderr: cappedText(stderr),
        };
      }
      if (envelope.ok === false) {
        const message = envelope.error?.message
          || envelope.error?.hint
          || "lark-cli command failed";
        const error = new ApiError(502, "LARK_CLI_ERROR", cappedText(message));
        error.details = envelope.error ?? envelope;
        throw error;
      }
      return {
        ok: envelope.ok !== false,
        identity: envelope.identity ?? null,
        data: Object.hasOwn(envelope, "data") ? envelope.data : envelope,
        meta: envelope.meta ?? null,
        rawStdout: cappedText(stdout),
        rawStderr: cappedText(stderr),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const envelope = parseJsonEnvelope(error?.stdout, error?.stderr);
      if (envelope?.ok === false) {
        const message = envelope.error?.message
          || envelope.error?.hint
          || error?.message
          || "lark-cli command failed";
        throw new ApiError(502, "LARK_CLI_ERROR", cappedText(message));
      }
      if (error?.code === "ENOENT") {
        throw new ApiError(409, "LARK_CLI_MISSING", `Executable '${discovered.executable}' was not found`);
      }
      throw new ApiError(
        502,
        "LARK_CLI_ERROR",
        cappedText(error?.stderr || error?.message || String(error)),
      );
    }
  }

  async function getStatus(overrideExecutable) {
    const discovered = await discover(overrideExecutable);
    if (!discovered.installed) {
      return {
        installed: false,
        loggedIn: false,
        executable: discovered.executable,
        detail: discovered.reason || "lark-cli is not installed",
        identity: null,
        data: null,
      };
    }
    try {
      const result = await runCommand(["auth", "status"], {
        executable: discovered.executable,
        timeoutMs: 15_000,
      });
      const data = isPlainObject(result.data) ? result.data : null;
      const identities = isPlainObject(data?.identities) ? data.identities : null;
      const userIdentity = isPlainObject(identities?.user) ? identities.user : null;
      const botIdentity = isPlainObject(identities?.bot) ? identities.bot : null;
      const loggedIn = Boolean(
        data
        && (
          userIdentity?.available === true
          || userIdentity?.status === "ready"
          || botIdentity?.available === true
          || botIdentity?.status === "ready"
          || data.logged_in === true
          || data.loggedIn === true
          || data.user
          || data.open_id
          || data.openId
          || Array.isArray(data.accounts)
          || data.status === "ok"
        ),
      );
      const detail = loggedIn
        ? (
          userIdentity?.userName
            ? `已登录：${userIdentity.userName}`
            : "lark-cli auth status ok"
        )
        : "auth status returned no login";
      return {
        installed: true,
        loggedIn,
        executable: discovered.executable,
        detail,
        identity: data?.identity ?? result.identity,
        data,
      };
    } catch (error) {
      return {
        installed: true,
        loggedIn: false,
        executable: discovered.executable,
        detail: error?.message || "auth status failed",
        identity: null,
        data: null,
      };
    }
  }

  async function getConfig() {
    await ensureLoaded();
    return publicConfig(config);
  }

  async function getInternalConfig() {
    await ensureLoaded();
    return structuredClone(config);
  }

  async function saveConfig(input = {}) {
    await ensureLoaded();
    config = sanitizeConfigPatch(input, config);
    config.version = CONFIG_VERSION;
    await persist();
    return publicConfig(config);
  }

  async function recordTestResult(result) {
    await ensureLoaded();
    config.lastTestedAt = new Date().toISOString();
    config.lastError = result.ok ? null : (result.detail || "Lark CLI test failed");
    await persist();
  }

  async function testConnection(draft = {}) {
    const executable = typeof draft.executable === "string" ? draft.executable : undefined;
    const status = await getStatus(executable);
    const ok = status.installed && status.loggedIn;
    const payload = {
      ok,
      installed: status.installed,
      loggedIn: status.loggedIn,
      executable: status.executable,
      detail: status.detail,
      identity: status.identity,
      data: status.data,
    };
    await recordTestResult(payload);
    return payload;
  }

  function normalizeChatEntries(payload) {
    const root = isPlainObject(payload) ? payload : {};
    const data = isPlainObject(root.data) ? root.data : root;
    const list = Array.isArray(data.chats)
      ? data.chats
      : Array.isArray(data.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
    return list
      .map((entry) => {
        if (!isPlainObject(entry)) return null;
        const chatId = String(entry.chat_id || entry.chatId || entry.id || "").trim();
        if (!chatId) return null;
        return {
          chatId,
          name: String(entry.name || entry.chat_name || entry.title || chatId).trim() || chatId,
          description: String(entry.description || "").trim(),
          chatMode: entry.chat_mode || entry.chatMode || null,
          external: entry.external === true,
        };
      })
      .filter(Boolean);
  }

  async function listChats({ query = "", as } = {}) {
    await ensureLoaded();
    const identity = as === "bot" || as === "user" ? as : config.defaultAs;
    const trimmed = String(query || "").trim();
    const args = trimmed
      ? ["im", "+chat-search", "--as", identity, "--query", trimmed, "--page-size", "30"]
      : ["im", "+chat-list", "--as", identity, "--page-size", "30", "--sort", "active_time"];
    const result = await runCommand(args, { timeoutMs: 45_000 });
    const chats = normalizeChatEntries({ data: result.data, ...result });
    return {
      ok: true,
      identity: result.identity ?? identity,
      query: trimmed || null,
      chats,
    };
  }

  async function sendMessage({
    text,
    recipientType = "chat",
    userId = "",
    chatId = "",
    as,
  }) {
    await ensureLoaded();
    const body = String(text || "").trim();
    if (!body) {
      throw new ApiError(400, "INVALID_FIELD", "'text' is required");
    }
    const identity = as === "bot" || as === "user" ? as : config.defaultAs;
    const args = ["im", "+messages-send", "--as", identity, "--text", body];
    if (recipientType === "chat") {
      if (!String(chatId || "").trim()) {
        throw new ApiError(400, "INVALID_FIELD", "'chatId' is required for chat recipient");
      }
      args.push("--chat-id", String(chatId).trim());
    } else if (recipientType === "user") {
      if (!String(userId || "").trim()) {
        throw new ApiError(400, "INVALID_FIELD", "'userId' is required for user recipient");
      }
      args.push("--user-id", String(userId).trim());
    } else if (recipientType === "self") {
      // Prefer explicit self open_id from auth status when available.
      const status = await getStatus();
      const openId = status.data?.identities?.user?.openId
        || status.data?.identities?.user?.open_id
        || status.data?.user?.open_id
        || status.data?.user?.openId
        || status.data?.open_id
        || status.data?.openId;
      if (openId) args.push("--user-id", String(openId));
    } else {
      throw new ApiError(400, "INVALID_FIELD", "'recipientType' is invalid");
    }
    return runCommand(args);
  }

  async function createDoc({ title, content }) {
    const docTitle = String(title || "Taskboard Doc").trim() || "Taskboard Doc";
    const markdown = String(content || "").trim() || `# ${docTitle}\n`;
    return runCommand([
      "docs",
      "+create",
      "--doc-format",
      "markdown",
      "--content",
      markdown.startsWith("<title>")
        ? markdown
        : `<title>${docTitle}</title>\n${markdown}`,
    ]);
  }

  async function readDoc({ docToken }) {
    const token = String(docToken || "").trim();
    if (!token) {
      throw new ApiError(400, "INVALID_FIELD", "'docToken' is required");
    }
    try {
      return await runCommand(["docs", "+get", "--doc-token", token]);
    } catch (error) {
      if (error instanceof ApiError && error.code === "LARK_CLI_ERROR") {
        return runCommand(["docs", "+read", "--doc-token", token]);
      }
      throw error;
    }
  }

  async function listTasks({ taskListGuid } = {}) {
    const args = ["task", "+list"];
    if (taskListGuid) args.push("--tasklist-guid", String(taskListGuid));
    try {
      return await runCommand(args);
    } catch (error) {
      if (error instanceof ApiError && error.code === "LARK_CLI_ERROR") {
        return runCommand(["task", "tasks", "list", ...(taskListGuid
          ? ["--params", JSON.stringify({ tasklist_guid: taskListGuid })]
          : [])]);
      }
      throw error;
    }
  }

  async function completeTask({ taskGuid }) {
    const guid = String(taskGuid || "").trim();
    if (!guid) {
      throw new ApiError(400, "INVALID_FIELD", "'taskGuid' is required");
    }
    try {
      return await runCommand(["task", "+complete", "--task-guid", guid]);
    } catch (error) {
      if (error instanceof ApiError && error.code === "LARK_CLI_ERROR") {
        return runCommand(["task", "+update", "--task-guid", guid, "--completed", "true"]);
      }
      throw error;
    }
  }

  async function updateMapping(larkTaskId, mapping) {
    await ensureLoaded();
    if (!config.sync.mappings || typeof config.sync.mappings !== "object") {
      config.sync.mappings = {};
    }
    if (mapping == null) {
      delete config.sync.mappings[larkTaskId];
    } else {
      config.sync.mappings[larkTaskId] = mapping;
    }
    await persist();
  }

  async function setLastError(message) {
    await ensureLoaded();
    config.lastError = message ? cappedText(message) : null;
    await persist();
  }

  async function ensureLarkOnPath(processEnv = env) {
    const discovered = await discover();
    const next = { ...processEnv };
    if (!discovered.installed) return next;
    const dir = path.dirname(discovered.executable);
    const current = typeof next.PATH === "string" ? next.PATH : "";
    if (!current.split(path.delimiter).includes(dir)) {
      next.PATH = current ? `${dir}${path.delimiter}${current}` : dir;
    }
    next.LARK_CLI_EXECUTABLE = discovered.executable;
    return next;
  }

  async function installSkills() {
    try {
      const { stdout, stderr } = await execFileAsync(
        "npx",
        ["skills", "add", "larksuite/cli", "-y", "-g"],
        {
          env,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      await ensureLoaded();
      config.ai = {
        skillsInstalledAt: new Date().toISOString(),
        skillsDetail: cappedText(stdout || stderr || "skills added"),
      };
      await persist();
      return {
        ok: true,
        detail: config.ai.skillsDetail,
        installedAt: config.ai.skillsInstalledAt,
      };
    } catch (error) {
      const detail = cappedText(error?.stderr || error?.message || String(error));
      await ensureLoaded();
      config.ai = {
        skillsInstalledAt: config.ai?.skillsInstalledAt ?? null,
        skillsDetail: detail,
      };
      await persist();
      throw new ApiError(502, "LARK_SKILLS_INSTALL_FAILED", detail);
    }
  }

  async function getAiAvailability() {
    const status = await getStatus();
    return {
      available: status.installed && status.loggedIn,
      installed: status.installed,
      loggedIn: status.loggedIn,
      executable: status.executable,
      detail: status.detail,
      skillsInstalledAt: (await getConfig()).ai.skillsInstalledAt,
    };
  }

  return {
    discover,
    getStatus,
    getConfig,
    getInternalConfig,
    saveConfig,
    testConnection,
    runCommand,
    listChats,
    sendMessage,
    createDoc,
    readDoc,
    listTasks,
    completeTask,
    updateMapping,
    setLastError,
    ensureLarkOnPath,
    installSkills,
    getAiAvailability,
  };
}
