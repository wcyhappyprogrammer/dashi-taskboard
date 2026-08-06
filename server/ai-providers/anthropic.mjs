import {
  SKILL_MARKER,
  buildManageTaskboardGuidance,
  buildTaskboardContextLines,
  cappedText,
  errorMessage,
} from "./shared.mjs";

const DEFAULT_MODELS = [
  {
    slug: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    description: "Anthropic Messages API — balanced",
  },
  {
    slug: "claude-opus-4-5",
    displayName: "Claude Opus 4.5",
    description: "Anthropic Messages API — highest capability",
  },
  {
    slug: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Anthropic Messages API — fast",
  },
];

function parseModelOverride(env) {
  const raw = env.ANTHROPIC_MODELS;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.split(",").flatMap((entry) => {
    const slug = entry.trim();
    if (!slug) return [];
    return [{
      slug,
      displayName: slug,
      description: "Configured via ANTHROPIC_MODELS",
    }];
  });
}

function historyToMessages(events, currentMessage) {
  const messages = [];
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
  // Current user message is already persisted by the service before startTurn streams;
  // avoid duplicating if the last history event is that same user message.
  const last = messages[messages.length - 1];
  if (!(last?.role === "user" && last.content === cleaned)) {
    messages.push({ role: "user", content: cleaned });
  }
  // Anthropic requires alternating roles starting with user.
  return messages.filter((message, index) => {
    if (index === 0) return message.role === "user";
    return message.role !== messages[index - 1].role;
  });
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
  if (!reader) throw new Error("Anthropic response body is not readable");
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

export function createAnthropicApiProvider(options = {}) {
  const manageTaskboardSkillPath = options.manageTaskboardSkillPath;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function resolveApiKey(processEnv, providerConfig = {}) {
    if (typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim()) {
      return providerConfig.apiKey.trim();
    }
    if (typeof processEnv.ANTHROPIC_API_KEY === "string" && processEnv.ANTHROPIC_API_KEY.trim()) {
      return processEnv.ANTHROPIC_API_KEY.trim();
    }
    return null;
  }

  function resolveBaseUrl(processEnv, providerConfig = {}) {
    return (
      providerConfig.baseUrl
      || processEnv.ANTHROPIC_BASE_URL
      || "https://api.anthropic.com"
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
    return parseModelOverride(processEnv) ?? DEFAULT_MODELS;
  }

  return {
    id: "anthropic",
    displayName: "Anthropic API",
    supportsSkills: false,
    supportsSandbox: false,
    requiresSessionId: false,

    async probeAvailability(env, providerConfig = {}) {
      if (resolveApiKey(env, providerConfig)) return { available: true };
      return { available: false, reason: "Anthropic API key is not configured" };
    },

    async discoverCatalog({ processEnv, providerConfig = {} }) {
      const preferred = providerConfig.defaultModel;
      const models = resolveModels(processEnv, providerConfig).map((model) => ({
        provider: "anthropic",
        slug: model.slug,
        displayName: model.displayName,
        description: model.description,
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
        if (!apiKey) throw new Error("Anthropic API key is not configured");
        const baseUrl = resolveBaseUrl(processEnv, providerConfig);
        const system = buildSystemPrompt(thread, attachmentPaths, manageTaskboardSkillPath);
        const messages = historyToMessages(historyEvents, message);

        onEvent({
          kind: "event",
          type: "turn.started",
          role: "activity",
          content: "",
          data: { status: "started" },
        });

        const response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: thread.model,
            max_tokens: 8_192,
            system,
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
            `Anthropic API request failed (${response.status})${detail ? `: ${cappedText(detail)}` : ""}`,
          );
        }

        let textBuffer = "";
        for await (const data of readSseDataLines(response)) {
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            throw new Error("Anthropic emitted malformed SSE JSON");
          }
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            textBuffer += event.delta.text ?? "";
          } else if (event.type === "content_block_stop" || event.type === "message_delta") {
            if (textBuffer) {
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
          } else if (event.type === "message_stop") {
            if (textBuffer) {
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
          } else if (event.type === "error") {
            terminalOutcome = "failed";
            terminalError = errorMessage(event.error ?? event.message);
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
        if (!assistantEventEmitted && terminalOutcome === null) {
          // Empty successful responses still count as completed turns.
        }
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
        label: "Anthropic",
      };
    },
  };
}
