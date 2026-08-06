import { createAnthropicApiProvider } from "./anthropic.mjs";
import { createClaudeCodeProvider } from "./claude-code.mjs";
import { createCodexProvider } from "./codex.mjs";
import {
  OPENAI_COMPATIBLE_DEFINITIONS,
  createOpenAiCompatibleProvider,
} from "./openai-compatible.mjs";
import { SANDBOXES } from "./shared.mjs";

const PROVIDER_ORDER = [
  "codex",
  "claude-code",
  "anthropic",
  "deepseek",
  "kimi",
  "volcengine",
  "aliyun",
  "tencent",
];

const OPENAI_COMPAT_BY_ID = Object.fromEntries(
  OPENAI_COMPATIBLE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

function resolveEnvApiKey(processEnv, definition) {
  for (const key of definition.apiKeyEnv ?? []) {
    if (typeof processEnv?.[key] === "string" && processEnv[key].trim()) {
      return processEnv[key].trim();
    }
  }
  return undefined;
}

function resolveEnvBaseUrl(processEnv, definition) {
  for (const key of definition.baseUrlEnv ?? []) {
    if (typeof processEnv?.[key] === "string" && processEnv[key].trim()) {
      return processEnv[key].trim();
    }
  }
  return definition.defaultBaseUrl;
}

export function createProviderRegistry(options = {}) {
  const processEnv = options.processEnv ?? process.env;
  const configStore = options.configStore ?? null;
  const requestedIds = Array.isArray(options.providerIds) && options.providerIds.length > 0
    ? options.providerIds
    : PROVIDER_ORDER;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const factories = {
    codex: () => createCodexProvider({
      executable: options.codexExecutable ?? processEnv.CODEX_EXECUTABLE ?? "codex",
      codexStatePath: options.codexStatePath,
      manageTaskboardSkillPath: options.manageTaskboardSkillPath,
    }),
    "claude-code": () => createClaudeCodeProvider({
      executable: options.claudeExecutable ?? processEnv.CLAUDE_EXECUTABLE ?? "claude",
      manageTaskboardSkillPath: options.manageTaskboardSkillPath,
    }),
    anthropic: () => createAnthropicApiProvider({
      manageTaskboardSkillPath: options.manageTaskboardSkillPath,
      fetchImpl,
    }),
  };

  for (const definition of OPENAI_COMPATIBLE_DEFINITIONS) {
    factories[definition.id] = () => createOpenAiCompatibleProvider(definition, {
      manageTaskboardSkillPath: options.manageTaskboardSkillPath,
      fetchImpl,
    });
  }

  const providers = requestedIds
    .map((id) => factories[id]?.())
    .filter(Boolean);

  async function resolveProviderConfig(providerId, projectId) {
    if (!configStore) {
      if (providerId === "codex" || providerId === "claude-code") {
        return {
          id: providerId,
          enabled: true,
          executable: providerId === "codex"
            ? (options.codexExecutable ?? processEnv.CODEX_EXECUTABLE ?? "codex")
            : (options.claudeExecutable ?? processEnv.CLAUDE_EXECUTABLE ?? "claude"),
        };
      }
      if (providerId === "anthropic") {
        return {
          id: providerId,
          enabled: true,
          apiKey: processEnv.ANTHROPIC_API_KEY,
          baseUrl: processEnv.ANTHROPIC_BASE_URL,
        };
      }
      const definition = OPENAI_COMPAT_BY_ID[providerId];
      if (definition) {
        return {
          id: providerId,
          enabled: true,
          apiKey: resolveEnvApiKey(processEnv, definition),
          baseUrl: resolveEnvBaseUrl(processEnv, definition),
        };
      }
      return { id: providerId, enabled: true };
    }
    return configStore.resolveEffectiveProvider(providerId, projectId);
  }

  return {
    list() {
      return providers;
    },

    get(id) {
      return providers.find((provider) => provider.id === id) ?? null;
    },

    async resolveProviderConfig(providerId, projectId) {
      return resolveProviderConfig(providerId, projectId);
    },

    async getCatalog({ database, projectId, processEnv: env = processEnv }) {
      const providerEntries = [];
      const models = [];
      const skills = [];
      const sandboxSet = new Set();
      const defaults = {};

      for (const provider of providers) {
        const providerConfig = await resolveProviderConfig(provider.id, projectId);
        defaults[provider.id] = {
          model: providerConfig.defaultModel ?? null,
          reasoningEffort: providerConfig.reasoningEffort ?? null,
          sandbox: providerConfig.sandbox ?? null,
        };
        if (providerConfig.enabled === false) {
          providerEntries.push({
            id: provider.id,
            displayName: provider.displayName,
            available: false,
            reason: "Disabled in AI provider settings",
            enabled: false,
            supportsSkills: provider.supportsSkills === true,
            supportsSandbox: provider.supportsSandbox === true,
          });
          continue;
        }
        const availability = await provider.probeAvailability(env, providerConfig);
        providerEntries.push({
          id: provider.id,
          displayName: provider.displayName,
          available: availability.available,
          enabled: true,
          ...(availability.reason ? { reason: availability.reason } : {}),
          supportsSkills: provider.supportsSkills === true,
          supportsSandbox: provider.supportsSandbox === true,
        });
        if (!availability.available) continue;
        try {
          const catalog = await provider.discoverCatalog({
            database,
            projectId,
            processEnv: env,
            providerConfig,
          });
          for (const model of catalog.models ?? []) {
            models.push({
              ...model,
              provider: model.provider ?? provider.id,
            });
          }
          for (const skill of catalog.skills ?? []) {
            skills.push({
              ...skill,
              provider: skill.provider ?? provider.id,
            });
          }
          for (const sandbox of catalog.sandboxes ?? []) sandboxSet.add(sandbox);
        } catch (error) {
          const entry = providerEntries.at(-1);
          entry.available = false;
          entry.reason = error instanceof Error ? error.message : String(error);
        }
      }

      return {
        providers: providerEntries,
        models,
        skills,
        sandboxes: SANDBOXES.filter((sandbox) => sandboxSet.has(sandbox)).length > 0
          ? SANDBOXES.filter((sandbox) => sandboxSet.has(sandbox))
          : [...sandboxSet],
        defaults,
      };
    },

    async testProvider({
      providerId,
      projectId = null,
      draft = {},
      processEnv: env = processEnv,
      database = null,
    }) {
      const provider = this.get(providerId);
      if (!provider) {
        return {
          ok: false,
          providerId,
          reason: `Unknown provider '${providerId}'`,
        };
      }
      const saved = await resolveProviderConfig(providerId, projectId);
      const providerConfig = {
        ...saved,
        ...draft,
        apiKey: draft.apiKey || saved.apiKey,
      };
      if (providerConfig.enabled === false && draft.enabled !== true) {
        return {
          ok: false,
          providerId,
          reason: "Provider is disabled",
        };
      }
      const availability = await provider.probeAvailability(env, providerConfig);
      if (!availability.available) {
        return {
          ok: false,
          providerId,
          reason: availability.reason || "Provider is unavailable",
          supportsCliLogin: provider.supportsCliLogin === true,
        };
      }
      try {
        const catalog = await provider.discoverCatalog({
          database,
          projectId: projectId || "local",
          processEnv: env,
          providerConfig,
        });
        const isApiProvider = providerId === "anthropic" || Boolean(OPENAI_COMPAT_BY_ID[providerId]);
        return {
          ok: true,
          providerId,
          modelCount: Array.isArray(catalog.models) ? catalog.models.length : 0,
          models: (catalog.models ?? []).slice(0, 8).map((model) => ({
            slug: model.slug,
            displayName: model.displayName,
          })),
          detail: isApiProvider
            ? `API reachable · ${catalog.models?.length ?? 0} models`
            : (
              availability.detail
                ? `${availability.detail} · ${catalog.models?.length ?? 0} models`
                : `CLI available · ${catalog.models?.length ?? 0} models`
            ),
          supportsCliLogin: provider.supportsCliLogin === true,
        };
      } catch (error) {
        return {
          ok: false,
          providerId,
          reason: error instanceof Error ? error.message : String(error),
          supportsCliLogin: provider.supportsCliLogin === true,
        };
      }
    },

    async startLogin({
      providerId,
      projectId = null,
      draft = {},
      processEnv: env = processEnv,
    }) {
      const provider = this.get(providerId);
      if (!provider) {
        return { ok: false, providerId, detail: `Unknown provider '${providerId}'` };
      }
      if (typeof provider.startLogin !== "function") {
        return {
          ok: false,
          providerId,
          detail: `Provider '${providerId}' does not support CLI login from settings`,
        };
      }
      const saved = await resolveProviderConfig(providerId, projectId);
      const providerConfig = {
        ...saved,
        ...draft,
      };
      return provider.startLogin({ env, providerConfig });
    },
  };
}

export { SANDBOXES, PROVIDER_ORDER };
