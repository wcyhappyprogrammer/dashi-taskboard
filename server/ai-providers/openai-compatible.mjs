import {
  SKILL_MARKER,
  buildManageTaskboardGuidance,
  buildTaskboardContextLines,
  cappedText,
  errorMessage,
} from "./shared.mjs";

function historyToMessages(events, currentMessage, systemPrompt) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const event of events) {
    if (event.role === "user" && event.type === "user_message") {
      messages.push({
        role: "user",
        content: (event.content ?? "").replaceAll(SKILL_MARKER, ""),
      });
    } else if (event.role === "assistant" && event.type === "agent_message" && event.content) {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        last.content = `${last.content}\n${event.content}`;
      } else {
        messages.push({ role: "assistant", content: event.content });
      }
    }
  }
  const cleaned = currentMessage.replaceAll(SKILL_MARKER, "");
  const last = messages[messages.length - 1];
  if (!(last?.role === "user" && last.content === cleaned)) {
    messages.push({ role: "user", content: cleaned });
  }
  return messages;
}

function buildSystemPrompt(thread, attachmentPaths, skillPath) {
  const context = buildTaskboardContextLines(thread, attachmentPaths);
  return [
    buildManageTaskboardGuidance(skillPath),
    "",
    "You are chatting inside Codex Taskboard. You do not have local shell tools in this provider mode.",
    "Answer helpfully about the current project and issue context.",
    "",
    "<taskboard_context>",
    ...context,
    "</taskboard_context>",
  ].join("\n");
}

async function* readSseDataLines(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response body is not readable");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator;
    while ((separator = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, separator).trimEnd();
      buffer = buffer.slice(separator + 1);
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") yield data;
      }
    }
  }
  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") yield data;
  }
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function resolveEnvValue(env, keys = []) {
  for (const key of keys) {
    if (typeof env?.[key] === "string" && env[key].trim()) return env[key].trim();
  }
  return null;
}

/**
 * OpenAI-compatible Chat Completions provider (DeepSeek / Kimi / Volcengine / Aliyun / Tencent…).
 */
export function createOpenAiCompatibleProvider(definition, options = {}) {
  const manageTaskboardSkillPath = options.manageTaskboardSkillPath;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const {
    id,
    displayName,
    defaultBaseUrl,
    defaultModels,
    apiKeyEnv = [],
    baseUrlEnv = [],
    modelsEnv = [],
  } = definition;

  function resolveApiKey(processEnv, providerConfig = {}) {
    if (typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim()) {
      return providerConfig.apiKey.trim();
    }
    return resolveEnvValue(processEnv, apiKeyEnv);
  }

  function resolveBaseUrl(processEnv, providerConfig = {}) {
    return (
      providerConfig.baseUrl
      || resolveEnvValue(processEnv, baseUrlEnv)
      || defaultBaseUrl
    ).replace(/\/$/, "");
  }

  function resolveModels(processEnv, providerConfig = {}) {
    if (Array.isArray(providerConfig.models) && providerConfig.models.length > 0) {
      return providerConfig.models.map((slug) => ({
        slug,
        displayName: slug,
        description: "Configured model",
      }));
    }
    const fromEnv = resolveEnvValue(processEnv, modelsEnv);
    if (fromEnv) {
      return fromEnv.split(",").flatMap((entry) => {
        const slug = entry.trim();
        if (!slug) return [];
        return [{ slug, displayName: slug, description: `Configured via ${modelsEnv[0]}` }];
      });
    }
    return defaultModels.map((model) => ({ ...model }));
  }

  return {
    id,
    displayName,
    supportsSkills: false,
    supportsSandbox: false,
    requiresSessionId: false,
    supportsCliLogin: false,

    async probeAvailability(env, providerConfig = {}) {
      if (resolveApiKey(env, providerConfig)) return { available: true };
      return { available: false, reason: `${displayName} API key is not configured` };
    },

    async discoverCatalog({ processEnv, providerConfig = {} }) {
      const preferred = providerConfig.defaultModel;
      const models = resolveModels(processEnv, providerConfig).map((model) => ({
        provider: id,
        slug: model.slug,
        displayName: model.displayName,
        description: model.description || "",
        defaultReasoningEffort: "default",
        supportedReasoningEfforts: ["default"],
        serviceTiers: [],
      }));
      if (preferred) {
        models.sort((left, right) => (
          (right.slug === preferred ? 1 : 0) - (left.slug === preferred ? 1 : 0)
        ));
      }
      return {
        models,
        skills: [],
        sandboxes: [],
      };
    },

    startTurn({
      thread,
      attachmentPaths,
      message,
      processEnv,
      providerConfig = {},
      historyEvents = [],
      onEvent,
    }) {
      const abortController = new AbortController();
      let terminalOutcome = null;
      let terminalError = "";
      let assistantEventEmitted = false;

      const completion = (async () => {
        const apiKey = resolveApiKey(processEnv, providerConfig);
        if (!apiKey) throw new Error(`${displayName} API key is not configured`);
        const baseUrl = resolveBaseUrl(processEnv, providerConfig);
        const system = buildSystemPrompt(thread, attachmentPaths, manageTaskboardSkillPath);
        const messages = historyToMessages(historyEvents, message, system);

        onEvent({
          kind: "event",
          type: "turn.started",
          role: "activity",
          content: "",
          data: { status: "started" },
        });

        const response = await fetchImpl(chatCompletionsUrl(baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: thread.model,
            messages,
            stream: true,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          let detail = "";
          try {
            detail = await response.text();
          } catch {}
          throw new Error(
            `${displayName} request failed (${response.status})${detail ? `: ${cappedText(detail)}` : ""}`,
          );
        }

        let textBuffer = "";
        for await (const data of readSseDataLines(response)) {
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            throw new Error(`${displayName} emitted malformed SSE JSON`);
          }
          const choice = Array.isArray(event.choices) ? event.choices[0] : null;
          const delta = choice?.delta ?? {};
          const piece = typeof delta.content === "string"
            ? delta.content
            : typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : "";
          if (piece) textBuffer += piece;

          const finishReason = choice?.finish_reason;
          if (finishReason && textBuffer) {
            onEvent({
              kind: "event",
              type: "agent_message",
              role: "assistant",
              content: cappedText(textBuffer),
              data: { status: "completed" },
            });
            assistantEventEmitted = true;
            textBuffer = "";
          }
          if (event.error) {
            terminalOutcome = "failed";
            terminalError = errorMessage(event.error);
            onEvent({
              kind: "event",
              type: "error",
              role: "error",
              content: terminalError,
              data: { status: "failed" },
            });
          }
        }

        if (textBuffer) {
          onEvent({
            kind: "event",
            type: "agent_message",
            role: "assistant",
            content: cappedText(textBuffer),
            data: { status: "completed" },
          });
          assistantEventEmitted = true;
        }

        if (terminalOutcome === "failed") {
          return { exitCode: 1, signal: null };
        }
        void assistantEventEmitted;
        terminalOutcome = "completed";
        onEvent({
          kind: "event",
          type: "turn.completed",
          role: "activity",
          content: "",
          data: { status: "completed" },
        });
        return { exitCode: 0, signal: null };
      })().catch((error) => {
        if (abortController.signal.aborted) {
          terminalOutcome = "failed";
          throw error;
        }
        terminalOutcome = "failed";
        terminalError = errorMessage(error);
        throw error;
      });

      return {
        child: null,
        abortController,
        completion,
        getTerminalOutcome: () => terminalOutcome,
        getTerminalError: () => terminalError,
        getStartedSessionId: () => null,
        getResumeSessionId: () => null,
        label: displayName,
      };
    },
  };
}

export const OPENAI_COMPATIBLE_DEFINITIONS = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    baseUrlEnv: ["DEEPSEEK_BASE_URL"],
    modelsEnv: ["DEEPSEEK_MODELS"],
    defaultModels: [
      { slug: "deepseek-chat", displayName: "DeepSeek Chat", description: "DeepSeek conversational model" },
      { slug: "deepseek-reasoner", displayName: "DeepSeek Reasoner", description: "DeepSeek reasoning model" },
      { slug: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", description: "DeepSeek V4 Flash" },
      { slug: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", description: "DeepSeek V4 Pro" },
    ],
  },
  {
    id: "kimi",
    displayName: "Kimi (月之暗面)",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    baseUrlEnv: ["KIMI_BASE_URL", "MOONSHOT_BASE_URL"],
    modelsEnv: ["KIMI_MODELS", "MOONSHOT_MODELS"],
    defaultModels: [
      { slug: "moonshot-v1-8k", displayName: "Moonshot v1 8K", description: "Kimi 8K context" },
      { slug: "moonshot-v1-32k", displayName: "Moonshot v1 32K", description: "Kimi 32K context" },
      { slug: "moonshot-v1-128k", displayName: "Moonshot v1 128K", description: "Kimi 128K context" },
      { slug: "kimi-k2-0711-preview", displayName: "Kimi K2 Preview", description: "Kimi K2 preview model" },
    ],
  },
  {
    id: "volcengine",
    displayName: "火山引擎",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: ["VOLCENGINE_API_KEY", "ARK_API_KEY"],
    baseUrlEnv: ["VOLCENGINE_BASE_URL", "ARK_BASE_URL"],
    modelsEnv: ["VOLCENGINE_MODELS", "ARK_MODELS"],
    defaultModels: [
      { slug: "doubao-pro-32k", displayName: "Doubao Pro 32K", description: "可改成方舟接入点/Model ID" },
      { slug: "doubao-lite-32k", displayName: "Doubao Lite 32K", description: "可改成方舟接入点/Model ID" },
      { slug: "deepseek-v3-250324", displayName: "DeepSeek V3 (Ark)", description: "火山方舟上的 DeepSeek 示例" },
    ],
  },
  {
    id: "aliyun",
    displayName: "阿里云百炼",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["ALIYUN_API_KEY", "DASHSCOPE_API_KEY"],
    baseUrlEnv: ["ALIYUN_BASE_URL", "DASHSCOPE_BASE_URL"],
    modelsEnv: ["ALIYUN_MODELS", "DASHSCOPE_MODELS"],
    defaultModels: [
      { slug: "qwen-plus", displayName: "Qwen Plus", description: "通义千问 Plus" },
      { slug: "qwen-turbo", displayName: "Qwen Turbo", description: "通义千问 Turbo" },
      { slug: "qwen-max", displayName: "Qwen Max", description: "通义千问 Max" },
      { slug: "qwen-long", displayName: "Qwen Long", description: "通义千问 Long" },
    ],
  },
  {
    id: "tencent",
    displayName: "腾讯云混元",
    defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyEnv: ["TENCENT_API_KEY", "HUNYUAN_API_KEY"],
    baseUrlEnv: ["TENCENT_BASE_URL", "HUNYUAN_BASE_URL"],
    modelsEnv: ["TENCENT_MODELS", "HUNYUAN_MODELS"],
    defaultModels: [
      { slug: "hunyuan-turbos-latest", displayName: "混元 TurboS", description: "腾讯混元 TurboS" },
      { slug: "hunyuan-lite", displayName: "混元 Lite", description: "腾讯混元 Lite" },
      { slug: "hunyuan-standard", displayName: "混元 Standard", description: "腾讯混元 Standard" },
    ],
  },
];
