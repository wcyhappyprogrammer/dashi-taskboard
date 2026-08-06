import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { ApiError } from "./database.mjs";
import { createSecretStore, SecretStoreError } from "./secret-store.mjs";
import {
  defaultCodexExecutableCandidates,
  resolveCommandExecutable,
} from "./ai-providers/shared.mjs";

const CONFIG_VERSION = 1;
const PROVIDER_IDS = [
  "codex",
  "claude-code",
  "anthropic",
  "deepseek",
  "kimi",
  "volcengine",
  "aliyun",
  "tencent",
];
const API_KEY_PROVIDERS = new Set([
  "anthropic",
  "deepseek",
  "kimi",
  "volcengine",
  "aliyun",
  "tencent",
]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

const PROVIDER_META = {
  codex: {
    displayName: "Codex",
    supportsSkills: true,
    supportsSandbox: true,
    defaultExecutable: "codex",
  },
  "claude-code": {
    displayName: "Claude Code",
    supportsSkills: false,
    supportsSandbox: true,
    defaultExecutable: "claude",
  },
  anthropic: {
    displayName: "Anthropic API",
    supportsSkills: false,
    supportsSandbox: false,
    defaultBaseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    baseUrlEnv: ["ANTHROPIC_BASE_URL"],
    modelsEnv: ["ANTHROPIC_MODELS"],
    defaultModels: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  },
  deepseek: {
    displayName: "DeepSeek",
    supportsSkills: false,
    supportsSandbox: false,
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    baseUrlEnv: ["DEEPSEEK_BASE_URL"],
    modelsEnv: ["DEEPSEEK_MODELS"],
    defaultModels: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"],
  },
  kimi: {
    displayName: "Kimi (月之暗面)",
    supportsSkills: false,
    supportsSandbox: false,
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    baseUrlEnv: ["KIMI_BASE_URL", "MOONSHOT_BASE_URL"],
    modelsEnv: ["KIMI_MODELS", "MOONSHOT_MODELS"],
    defaultModels: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2-0711-preview"],
  },
  volcengine: {
    displayName: "火山引擎",
    supportsSkills: false,
    supportsSandbox: false,
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: ["VOLCENGINE_API_KEY", "ARK_API_KEY"],
    baseUrlEnv: ["VOLCENGINE_BASE_URL", "ARK_BASE_URL"],
    modelsEnv: ["VOLCENGINE_MODELS", "ARK_MODELS"],
    defaultModels: ["doubao-pro-32k", "doubao-lite-32k", "deepseek-v3-250324"],
  },
  aliyun: {
    displayName: "阿里云百炼",
    supportsSkills: false,
    supportsSandbox: false,
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["ALIYUN_API_KEY", "DASHSCOPE_API_KEY"],
    baseUrlEnv: ["ALIYUN_BASE_URL", "DASHSCOPE_BASE_URL"],
    modelsEnv: ["ALIYUN_MODELS", "DASHSCOPE_MODELS"],
    defaultModels: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
  },
  tencent: {
    displayName: "腾讯云混元",
    supportsSkills: false,
    supportsSandbox: false,
    defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyEnv: ["TENCENT_API_KEY", "HUNYUAN_API_KEY"],
    baseUrlEnv: ["TENCENT_BASE_URL", "HUNYUAN_BASE_URL"],
    modelsEnv: ["TENCENT_MODELS", "HUNYUAN_MODELS"],
    defaultModels: ["hunyuan-turbos-latest", "hunyuan-lite", "hunyuan-standard"],
  },
};

function isApiKeyProvider(providerId) {
  return API_KEY_PROVIDERS.has(providerId);
}

function envFirst(env, keys = []) {
  for (const key of keys) {
    if (typeof env?.[key] === "string" && env[key].trim()) return env[key].trim();
  }
  return null;
}

function emptyProviderPatch() {
  return {};
}

function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    global: { providers: {} },
    projects: {},
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

function optionalStringArray(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be an array of non-empty strings`);
  }
  if (value.length > 64) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain more than 64 entries`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function sanitizeProviderPatch(providerId, input = {}) {
  if (!PROVIDER_IDS.includes(providerId)) {
    throw new ApiError(400, "INVALID_PROVIDER", `Unknown provider '${providerId}'`);
  }
  if (!isPlainObject(input)) {
    throw new ApiError(400, "INVALID_BODY", "Provider configuration must be an object");
  }
  const allowed = new Set([
    "enabled",
    "executable",
    "baseUrl",
    "models",
    "defaultModel",
    "reasoningEffort",
    "sandbox",
    "apiKeyLastFour",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field '${key}'`);
    }
  }
  const patch = {};
  const enabled = optionalBoolean(input.enabled, "enabled");
  if (enabled !== undefined) patch.enabled = enabled;

  if (providerId === "codex" || providerId === "claude-code") {
    const executable = optionalString(input.executable, "executable", { maxLength: 1024, allowEmpty: true });
    if (executable !== undefined) patch.executable = executable || null;
    const defaultModel = optionalString(input.defaultModel, "defaultModel", { maxLength: 128, allowEmpty: true });
    if (defaultModel !== undefined) patch.defaultModel = defaultModel || null;
    const reasoningEffort = optionalString(input.reasoningEffort, "reasoningEffort", {
      maxLength: 64,
      allowEmpty: true,
    });
    if (reasoningEffort !== undefined) patch.reasoningEffort = reasoningEffort || null;
    if (input.sandbox !== undefined) {
      if (input.sandbox === null || input.sandbox === "") {
        patch.sandbox = null;
      } else if (!SANDBOXES.has(input.sandbox)) {
        throw new ApiError(
          400,
          "INVALID_SANDBOX",
          "'sandbox' must be read-only, workspace-write, or danger-full-access",
        );
      } else {
        patch.sandbox = input.sandbox;
      }
    }
  }

  if (isApiKeyProvider(providerId)) {
    const baseUrl = optionalString(input.baseUrl, "baseUrl", { maxLength: 2048, allowEmpty: true });
    if (baseUrl !== undefined) {
      if (baseUrl) {
        try {
          const url = new URL(baseUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            throw new Error("invalid protocol");
          }
          patch.baseUrl = url.toString().replace(/\/$/, "");
        } catch {
          throw new ApiError(400, "INVALID_FIELD", "'baseUrl' must be a valid URL");
        }
      } else {
        patch.baseUrl = null;
      }
    }
    const models = optionalStringArray(input.models, "models");
    if (models !== undefined) patch.models = models;
    const defaultModel = optionalString(input.defaultModel, "defaultModel", { maxLength: 128, allowEmpty: true });
    if (defaultModel !== undefined) patch.defaultModel = defaultModel || null;
    if (input.apiKeyLastFour !== undefined) {
      const lastFourValue = optionalString(input.apiKeyLastFour, "apiKeyLastFour", {
        maxLength: 4,
        allowEmpty: true,
      });
      patch.apiKeyLastFour = lastFourValue || null;
    }
  }

  return patch;
}

function parseStoredConfig(value) {
  if (!isPlainObject(value) || value.version !== CONFIG_VERSION) return emptyConfig();
  const globalProviders = isPlainObject(value.global?.providers) ? value.global.providers : {};
  const projects = isPlainObject(value.projects) ? value.projects : {};
  const next = emptyConfig();
  for (const providerId of PROVIDER_IDS) {
    if (isPlainObject(globalProviders[providerId])) {
      next.global.providers[providerId] = sanitizeProviderPatch(providerId, globalProviders[providerId]);
    }
  }
  for (const [projectId, projectConfig] of Object.entries(projects)) {
    if (!projectId || !isPlainObject(projectConfig?.providers)) continue;
    next.projects[projectId] = { providers: {} };
    for (const providerId of PROVIDER_IDS) {
      if (isPlainObject(projectConfig.providers[providerId])) {
        next.projects[projectId].providers[providerId] = sanitizeProviderPatch(
          providerId,
          projectConfig.providers[providerId],
        );
      }
    }
  }
  return next;
}

function mergeProviderConfig(providerId, globalPatch = {}, projectPatch = {}, env = process.env) {
  const meta = PROVIDER_META[providerId];
  const merged = {
    id: providerId,
    displayName: meta.displayName,
    supportsSkills: meta.supportsSkills,
    supportsSandbox: meta.supportsSandbox,
    enabled: true,
    source: {},
  };

  function pick(field, envValue, fallback) {
    if (Object.hasOwn(projectPatch, field) && projectPatch[field] != null && projectPatch[field] !== "") {
      merged[field] = projectPatch[field];
      merged.source[field] = "project";
      return;
    }
    if (Object.hasOwn(globalPatch, field) && globalPatch[field] != null && globalPatch[field] !== "") {
      merged[field] = globalPatch[field];
      merged.source[field] = "global";
      return;
    }
    if (envValue != null && envValue !== "") {
      merged[field] = envValue;
      merged.source[field] = "env";
      return;
    }
    if (fallback !== undefined) {
      merged[field] = fallback;
      merged.source[field] = "default";
    }
  }

  if (Object.hasOwn(projectPatch, "enabled")) {
    merged.enabled = projectPatch.enabled;
    merged.source.enabled = "project";
  } else if (Object.hasOwn(globalPatch, "enabled")) {
    merged.enabled = globalPatch.enabled;
    merged.source.enabled = "global";
  } else {
    merged.enabled = true;
    merged.source.enabled = "default";
  }

  if (providerId === "codex") {
    pick("executable", env.CODEX_EXECUTABLE, meta.defaultExecutable);
    pick("defaultModel", null, null);
    pick("reasoningEffort", null, null);
    pick("sandbox", null, "workspace-write");
  } else if (providerId === "claude-code") {
    pick("executable", env.CLAUDE_EXECUTABLE, meta.defaultExecutable);
    pick("defaultModel", null, "sonnet");
    pick("reasoningEffort", null, "medium");
    pick("sandbox", null, "workspace-write");
  } else if (isApiKeyProvider(providerId)) {
    pick("baseUrl", envFirst(env, meta.baseUrlEnv), meta.defaultBaseUrl);
    if (Object.hasOwn(projectPatch, "models") && Array.isArray(projectPatch.models)) {
      merged.models = projectPatch.models;
      merged.source.models = "project";
    } else if (Object.hasOwn(globalPatch, "models") && Array.isArray(globalPatch.models)) {
      merged.models = globalPatch.models;
      merged.source.models = "global";
    } else {
      const fromEnv = envFirst(env, meta.modelsEnv);
      if (fromEnv) {
        merged.models = fromEnv.split(",").map((entry) => entry.trim()).filter(Boolean);
        merged.source.models = "env";
      } else {
        merged.models = [...(meta.defaultModels ?? [])];
        merged.source.models = "default";
      }
    }
    pick("defaultModel", null, merged.models[0] ?? null);
    merged.apiKeyLastFour = projectPatch.apiKeyLastFour
      ?? globalPatch.apiKeyLastFour
      ?? null;
  }

  return merged;
}

function lastFour(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.slice(-4);
}

function publicProviderPatch(providerId, patch = {}) {
  const next = { ...patch };
  if (isApiKeyProvider(providerId)) {
    delete next.apiKey;
  }
  return next;
}

export function createAiProviderConfigStore(options = {}) {
  const configPath = options.configPath;
  if (!configPath) throw new Error("configPath is required");
  const processEnv = options.processEnv ?? process.env;
  const secretStore = options.secretStore ?? createSecretStore();
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return parseStoredConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyConfig();
      throw error;
    }
  }

  async function writeAtomically(config) {
    await mkdir(pathDirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, configPath);
  }

  function pathDirname(filePath) {
    const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    return index >= 0 ? filePath.slice(0, index) : ".";
  }

  function update(mutator) {
    const operation = pendingWrite.then(async () => {
      const next = mutator(await readFromDisk());
      await writeAtomically(next);
      return next;
    });
    pendingWrite = operation.catch(() => {});
    return operation;
  }

  async function resolveSecret(scope, projectId, providerId) {
    if (!isApiKeyProvider(providerId)) return null;
    const meta = PROVIDER_META[providerId];
    if (!secretStore.supported()) {
      return envFirst(processEnv, meta.apiKeyEnv);
    }
    try {
      if (scope === "project" && projectId) {
        const projectSecret = await secretStore.getSecret({
          scope: "project",
          projectId,
          provider: providerId,
        });
        if (projectSecret) return projectSecret;
      }
      const globalSecret = await secretStore.getSecret({
        scope: "global",
        provider: providerId,
      });
      if (globalSecret) return globalSecret;
    } catch (error) {
      if (error instanceof SecretStoreError && error.code === "KEYCHAIN_UNSUPPORTED") {
        // fall through to env
      } else {
        throw error;
      }
    }
    return envFirst(processEnv, meta.apiKeyEnv);
  }

  async function hasSecret(scope, projectId, providerId) {
    if (!isApiKeyProvider(providerId)) return false;
    const meta = PROVIDER_META[providerId];
    if (!secretStore.supported()) {
      return Boolean(envFirst(processEnv, meta.apiKeyEnv));
    }
    try {
      const value = await secretStore.getSecret({ scope, projectId, provider: providerId });
      return Boolean(value);
    } catch {
      return false;
    }
  }

  async function toPublicView(config, projectId = null) {
    const globalProviders = {};
    for (const providerId of PROVIDER_IDS) {
      const patch = config.global.providers[providerId] ?? {};
      const hasApiKey = isApiKeyProvider(providerId)
        ? await hasSecret("global", null, providerId)
        : false;
      globalProviders[providerId] = {
        ...publicProviderPatch(providerId, patch),
        ...(isApiKeyProvider(providerId) ? {
          hasApiKey,
          apiKeyLastFour: hasApiKey ? (patch.apiKeyLastFour ?? null) : null,
        } : {}),
      };
    }

    let projectProviders = null;
    if (projectId) {
      projectProviders = {};
      const projectConfig = config.projects[projectId]?.providers ?? {};
      for (const providerId of PROVIDER_IDS) {
        const patch = projectConfig[providerId] ?? {};
        const hasApiKey = isApiKeyProvider(providerId)
          ? await hasSecret("project", projectId, providerId)
          : false;
        projectProviders[providerId] = {
          ...publicProviderPatch(providerId, patch),
          overriddenFields: Object.keys(patch),
          ...(isApiKeyProvider(providerId) ? {
            hasApiKey,
            apiKeyLastFour: hasApiKey ? (patch.apiKeyLastFour ?? null) : null,
          } : {}),
        };
      }
    }

    const effective = {};
    for (const providerId of PROVIDER_IDS) {
      const merged = mergeProviderConfig(
        providerId,
        config.global.providers[providerId] ?? {},
        projectId ? (config.projects[projectId]?.providers?.[providerId] ?? {}) : {},
        processEnv,
      );
      if (providerId === "codex" && merged.executable) {
        merged.executable = await resolveCommandExecutable(merged.executable, {
          env: processEnv,
          candidates: defaultCodexExecutableCandidates(),
        });
      }
      const apiKey = isApiKeyProvider(providerId)
        ? await resolveSecret(projectId ? "project" : "global", projectId, providerId)
        : null;
      effective[providerId] = {
        ...merged,
        ...(isApiKeyProvider(providerId) ? {
          hasApiKey: Boolean(apiKey),
          apiKeyLastFour: apiKey ? (merged.apiKeyLastFour ?? lastFour(apiKey)) : null,
        } : {}),
      };
      delete effective[providerId].apiKey;
    }

    return {
      keychainSupported: secretStore.supported(),
      global: { providers: globalProviders },
      project: projectId ? { projectId, providers: projectProviders } : null,
      effective: { providers: effective },
      providers: PROVIDER_IDS.map((id) => ({
        id,
        displayName: PROVIDER_META[id].displayName,
        supportsSkills: PROVIDER_META[id].supportsSkills,
        supportsSandbox: PROVIDER_META[id].supportsSandbox,
      })),
    };
  }

  return {
    providerIds: PROVIDER_IDS,
    providerMeta: PROVIDER_META,

    async read() {
      await pendingWrite;
      return readFromDisk();
    },

    async getPublicConfig(projectId = null) {
      const config = await this.read();
      return toPublicView(config, projectId);
    },

    async resolveEffectiveProvider(providerId, projectId = null) {
      if (!PROVIDER_IDS.includes(providerId)) {
        throw new ApiError(400, "INVALID_PROVIDER", `Unknown provider '${providerId}'`);
      }
      const config = await this.read();
      const merged = mergeProviderConfig(
        providerId,
        config.global.providers[providerId] ?? {},
        projectId ? (config.projects[projectId]?.providers?.[providerId] ?? {}) : {},
        processEnv,
      );
      if (providerId === "codex" && merged.executable) {
        merged.executable = await resolveCommandExecutable(merged.executable, {
          env: processEnv,
          candidates: defaultCodexExecutableCandidates(),
        });
      }
      if (isApiKeyProvider(providerId)) {
        merged.apiKey = await resolveSecret(
          projectId ? "project" : "global",
          projectId,
          providerId,
        );
        merged.hasApiKey = Boolean(merged.apiKey);
      }
      return merged;
    },

    async resolveAllEffective(projectId = null) {
      const result = {};
      for (const providerId of PROVIDER_IDS) {
        result[providerId] = await this.resolveEffectiveProvider(providerId, projectId);
      }
      return result;
    },

    async saveProviderConfig({
      scope,
      projectId,
      provider,
      patch,
      apiKey,
      clearApiKey = false,
    }) {
      if (scope !== "global" && scope !== "project") {
        throw new ApiError(400, "INVALID_SCOPE", "'scope' must be global or project");
      }
      if (scope === "project") {
        if (typeof projectId !== "string" || !projectId.trim()) {
          throw new ApiError(400, "INVALID_PROJECT", "projectId is required for project scope");
        }
      }
      const sanitized = sanitizeProviderPatch(provider, patch ?? {});
      if (apiKey !== undefined && apiKey !== null) {
        if (!isApiKeyProvider(provider)) {
          throw new ApiError(400, "INVALID_FIELD", `Provider '${provider}' does not support apiKey`);
        }
        if (!secretStore.supported()) {
          throw new ApiError(
            400,
            "KEYCHAIN_UNSUPPORTED",
            "System keychain is only supported on macOS",
          );
        }
        if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.trim().length > 4096) {
          throw new ApiError(400, "INVALID_FIELD", "'apiKey' must be 1 to 4096 characters");
        }
        const value = apiKey.trim();
        await secretStore.setSecret({
          scope,
          projectId: scope === "project" ? projectId : null,
          provider,
          value,
        });
        sanitized.apiKeyLastFour = lastFour(value);
      } else if (clearApiKey) {
        if (!isApiKeyProvider(provider)) {
          throw new ApiError(400, "INVALID_FIELD", `Provider '${provider}' does not support apiKey`);
        }
        if (secretStore.supported()) {
          await secretStore.deleteSecret({
            scope,
            projectId: scope === "project" ? projectId : null,
            provider,
          });
        }
        sanitized.apiKeyLastFour = null;
      }

      await update((config) => {
        const next = structuredClone(config);
        if (scope === "global") {
          next.global.providers[provider] = {
            ...(next.global.providers[provider] ?? emptyProviderPatch()),
            ...sanitized,
          };
        } else {
          if (!next.projects[projectId]) next.projects[projectId] = { providers: {} };
          next.projects[projectId].providers[provider] = {
            ...(next.projects[projectId].providers[provider] ?? emptyProviderPatch()),
            ...sanitized,
          };
        }
        return next;
      });

      return this.getPublicConfig(scope === "project" ? projectId : null);
    },

    async deleteProviderConfig({ scope, projectId, provider }) {
      if (scope !== "global" && scope !== "project") {
        throw new ApiError(400, "INVALID_SCOPE", "'scope' must be global or project");
      }
      if (!PROVIDER_IDS.includes(provider)) {
        throw new ApiError(400, "INVALID_PROVIDER", `Unknown provider '${provider}'`);
      }
      if (scope === "project" && (!projectId || typeof projectId !== "string")) {
        throw new ApiError(400, "INVALID_PROJECT", "projectId is required for project scope");
      }
      if (isApiKeyProvider(provider) && secretStore.supported()) {
        await secretStore.deleteSecret({
          scope,
          projectId: scope === "project" ? projectId : null,
          provider,
        }).catch(() => {});
      }
      await update((config) => {
        const next = structuredClone(config);
        if (scope === "global") {
          delete next.global.providers[provider];
        } else if (next.projects[projectId]?.providers) {
          delete next.projects[projectId].providers[provider];
          if (Object.keys(next.projects[projectId].providers).length === 0) {
            delete next.projects[projectId];
          }
        }
        return next;
      });
      return this.getPublicConfig(scope === "project" ? projectId : null);
    },
  };
}

export {
  PROVIDER_IDS,
  PROVIDER_META,
  API_KEY_PROVIDERS,
  isApiKeyProvider,
  mergeProviderConfig,
  sanitizeProviderPatch,
};
