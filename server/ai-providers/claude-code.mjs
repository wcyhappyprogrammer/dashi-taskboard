import { readFile } from "node:fs/promises";

import { readClaudeAuthStatus } from "./cli-login.mjs";
import {
  SANDBOXES,
  SKILL_MARKER,
  buildLarkCliGuidance,
  buildManageTaskboardGuidance,
  buildTaskboardContextLines,
  cappedText,
  detailText,
  errorMessage,
  probeExecutable,
  resolveCommandExecutable,
  spawnJsonlProcess,
} from "./shared.mjs";

const CLAUDE_MODELS = [
  {
    slug: "sonnet",
    displayName: "Claude Sonnet",
    description: "Balanced Claude Code model",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
  },
  {
    slug: "opus",
    displayName: "Claude Opus",
    description: "Highest-capability Claude Code model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
  },
  {
    slug: "haiku",
    displayName: "Claude Haiku",
    description: "Fast Claude Code model",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
  },
];

function permissionModeForSandbox(sandbox) {
  if (sandbox === "read-only") return "plan";
  if (sandbox === "danger-full-access") return "bypassPermissions";
  return "acceptEdits";
}

function buildClaudeArgs(thread, addDirectories = []) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    thread.model,
    "--permission-mode",
    permissionModeForSandbox(thread.sandbox),
  ];
  if (thread.sandbox === "danger-full-access") {
    args.push("--allow-dangerously-skip-permissions");
  }
  if (thread.reasoningEffort && thread.reasoningEffort !== "default") {
    args.push("--effort", thread.reasoningEffort);
  }
  for (const directory of addDirectories) {
    args.push("--add-dir", directory);
  }
  const sessionId = thread.providerSessionId ?? thread.codexThreadId;
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  return args;
}

async function buildClaudePrompt(thread, { message, attachmentPaths }, skillPath, larkAvailable = false) {
  let skillBody = "";
  if (skillPath) {
    try {
      skillBody = await readFile(skillPath, "utf8");
    } catch {
      skillBody = "";
    }
  }
  const userMessage = message.replaceAll(SKILL_MARKER, "");
  const context = buildTaskboardContextLines(thread, attachmentPaths);
  const guidance = buildManageTaskboardGuidance(skillPath);
  const larkGuidance = buildLarkCliGuidance(larkAvailable);
  return [
    guidance,
    larkGuidance,
    skillBody ? `\n<manage_taskboard_skill>\n${skillBody}\n</manage_taskboard_skill>` : "",
    "",
    "<taskboard_context>",
    ...context,
    "</taskboard_context>",
    "",
    "<user_message>",
    userMessage,
    "</user_message>",
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
}

function extractTextBlocks(content) {
  if (typeof content === "string") return cappedText(content);
  if (!Array.isArray(content)) return "";
  return cappedText(
    content
      .flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join(""),
  );
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool_use");
}

function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool_result");
}

export function normalizeClaudeCodeEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  if (raw.type === "system" && raw.subtype === "init") {
    const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
    if (!sessionId || sessionId.length > 256 || sessionId.includes("\0")) return null;
    return { kind: "session.started", sessionId };
  }

  if (raw.type === "result") {
    const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
    if (raw.is_error) {
      return {
        kind: "event",
        type: "turn.failed",
        role: "error",
        content: errorMessage(raw.result ?? raw.error ?? raw.message ?? "Claude Code turn failed"),
        data: { status: "failed" },
        sessionId: sessionId || undefined,
        terminalOutcome: "failed",
      };
    }
    return {
      kind: "event",
      type: "turn.completed",
      role: "activity",
      content: "",
      data: { status: "completed" },
      sessionId: sessionId || undefined,
      terminalOutcome: "completed",
    };
  }

  if (raw.type === "assistant") {
    const content = raw.message?.content;
    const text = extractTextBlocks(content);
    const toolUses = extractToolUses(content);
    const events = [];
    if (text) {
      events.push({
        kind: "event",
        type: "agent_message",
        role: "assistant",
        content: text,
        data: { status: "completed" },
      });
    }
    for (const tool of toolUses) {
      const name = cappedText(tool.name ?? "tool");
      const input = tool.input;
      const command = typeof input?.command === "string"
        ? cappedText(input.command)
        : name;
      events.push({
        kind: "event",
        type: name === "Bash" || name === "bash" ? "command_execution" : "mcp_tool_call",
        role: "activity",
        content: command,
        data: {
          status: "in_progress",
          tool: name,
          ...(input !== undefined ? { detail: detailText(input) } : {}),
          ...(tool.id ? { itemId: cappedText(tool.id) } : {}),
        },
      });
    }
    if (events.length === 0) return null;
    return { kind: "events", events };
  }

  if (raw.type === "user") {
    const results = extractToolResults(raw.message?.content);
    if (results.length === 0) return null;
    return {
      kind: "events",
      events: results.map((result) => ({
        kind: "event",
        type: "command_execution",
        role: typeof result.is_error === "boolean" && result.is_error ? "error" : "activity",
        content: extractTextBlocks(
          Array.isArray(result.content) ? result.content : [{ type: "text", text: String(result.content ?? "") }],
        ) || cappedText(result.tool_use_id ?? "tool_result"),
        data: {
          status: result.is_error ? "failed" : "completed",
          ...(result.tool_use_id ? { itemId: cappedText(result.tool_use_id) } : {}),
        },
      })),
    };
  }

  if (raw.type === "error") {
    return {
      kind: "event",
      type: "error",
      role: "error",
      content: errorMessage(raw.error ?? raw.message),
      data: { status: "failed" },
      terminalOutcome: "failed",
    };
  }

  return null;
}

export function createClaudeCodeProvider(options = {}) {
  const defaultExecutable = options.executable ?? "claude";
  const manageTaskboardSkillPath = options.manageTaskboardSkillPath;

  async function resolveExecutable(providerConfig, env = process.env) {
    const requested = providerConfig?.executable || defaultExecutable;
    return resolveCommandExecutable(requested, { env });
  }

  return {
    id: "claude-code",
    displayName: "Claude Code",
    supportsSkills: false,
    supportsSandbox: true,
    requiresSessionId: false,
    supportsCliLogin: true,

    async probeAvailability(env, providerConfig = {}) {
      const executable = await resolveExecutable(providerConfig, env);
      const installed = await probeExecutable(executable, ["--version"], env);
      if (!installed.available) return installed;
      const auth = await readClaudeAuthStatus(executable, env);
      if (!auth.loggedIn) {
        return { available: false, reason: auth.detail || "Not logged in · Please run login" };
      }
      return { available: true, detail: auth.detail };
    },

    async startLogin({ env = process.env, providerConfig = {} } = {}) {
      const { startCliLogin } = await import("./cli-login.mjs");
      const executable = await resolveExecutable(providerConfig, env);
      return startCliLogin({
        providerId: "claude-code",
        executable,
        args: ["auth", "login", "--claudeai"],
        env,
        label: "Claude Code",
      });
    },

    async discoverCatalog({ providerConfig = {} } = {}) {
      const preferred = providerConfig.defaultModel;
      const models = CLAUDE_MODELS.map((model) => ({
        provider: "claude-code",
        serviceTiers: [],
        ...model,
      }));
      if (preferred) {
        models.sort((left, right) => (
          (right.slug === preferred ? 1 : 0) - (left.slug === preferred ? 1 : 0)
        ));
      }
      return {
        models,
        skills: [],
        sandboxes: [...SANDBOXES],
      };
    },

    async startTurn({
      thread,
      addDirectories,
      attachmentPaths,
      message,
      processEnv,
      larkAvailable = false,
      providerConfig = {},
      onEvent,
    }) {
      const executable = await resolveExecutable(providerConfig, processEnv);
      const resumeSessionId = thread.providerSessionId ?? thread.codexThreadId ?? null;
      const args = buildClaudeArgs(
        { ...thread, providerSessionId: resumeSessionId },
        addDirectories,
      );
      const prompt = await buildClaudePrompt(
        thread,
        { message, attachmentPaths },
        manageTaskboardSkillPath,
        larkAvailable,
      );

      let startedSessionId = null;
      let terminalOutcome = null;
      let terminalError = "";

      const { child, completion } = spawnJsonlProcess({
        executable,
        args,
        cwd: thread.origin.workspacePath,
        prompt,
        env: processEnv,
        label: "Claude Code",
        onRawEvent: (raw) => {
          const normalized = normalizeClaudeCodeEvent(raw);
          if (!normalized) return;
          if (normalized.kind === "session.started") {
            startedSessionId = normalized.sessionId;
            onEvent(normalized);
            return;
          }
          if (normalized.sessionId && !startedSessionId) {
            startedSessionId = normalized.sessionId;
            onEvent({ kind: "session.started", sessionId: normalized.sessionId });
          }
          if (normalized.terminalOutcome === "completed" && terminalOutcome === null) {
            terminalOutcome = "completed";
          } else if (normalized.terminalOutcome === "failed") {
            terminalOutcome = "failed";
            terminalError ||= normalized.content;
          }
          if (normalized.kind === "events") {
            for (const event of normalized.events) onEvent(event);
            return;
          }
          if (normalized.kind === "event") onEvent(normalized);
        },
      });

      return {
        child,
        completion,
        getTerminalOutcome: () => terminalOutcome,
        getTerminalError: () => terminalError,
        getStartedSessionId: () => startedSessionId,
        getResumeSessionId: () => resumeSessionId,
        label: "Claude Code",
      };
    },
  };
}
