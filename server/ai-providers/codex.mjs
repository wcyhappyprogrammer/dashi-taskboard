import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  spawnCodexTurn,
} from "../ai-chat-process.mjs";
import { resolveAiWorkspace } from "../ai-chat-catalog.mjs";
import { readCodexAuthStatus } from "./cli-login.mjs";
import {
  SANDBOXES,
  defaultCodexExecutableCandidates,
  resolveCommandExecutable,
} from "./shared.mjs";

const execFileAsync = promisify(execFile);
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BUFFER = 2 * 1024 * 1024;

function sanitizeModels(value) {
  if (!Array.isArray(value)) throw new Error("Codex returned an invalid model catalog");
  return value.flatMap((model) => {
    if (
      !model
      || typeof model !== "object"
      || (model.visibility !== undefined && model.visibility !== "list")
      || typeof model.slug !== "string"
      || !model.slug.trim()
    ) {
      return [];
    }
    const slug = model.slug.trim();
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? [...new Set(model.supported_reasoning_levels.flatMap((level) => (
          typeof level?.effort === "string" && level.effort.trim() ? [level.effort.trim()] : []
        )))]
      : [];
    const serviceTiers = Array.isArray(model.service_tiers)
      ? model.service_tiers.flatMap((tier) => (
          typeof tier?.id === "string"
          && tier.id.trim()
          && typeof tier.name === "string"
          && tier.name.trim()
            ? [{ id: tier.id.trim(), name: tier.name.trim() }]
            : []
        ))
      : [];
    return [{
      provider: "codex",
      slug,
      displayName: typeof model.display_name === "string" && model.display_name.trim()
        ? model.display_name.trim()
        : slug,
      description: typeof model.description === "string" ? model.description : "",
      defaultReasoningEffort: typeof model.default_reasoning_level === "string"
        ? model.default_reasoning_level.trim()
        : "",
      supportedReasoningEfforts: efforts,
      serviceTiers,
    }];
  });
}

function listSkills(codexExecutable, workspacePath, processEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable, ["app-server", "--stdio"], {
      cwd: workspacePath,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Timed out while reading Codex skills")),
      CATALOG_TIMEOUT_MS,
    );

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) return finish(new Error("Codex app-server rejected initialization"));
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) return finish(new Error("Codex app-server could not list skills"));
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > CATALOG_MAX_BUFFER) {
        finish(new Error("Codex skills response exceeded the catalog size limit"));
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0 && !settled) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });
}

function sanitizeSkills(entries) {
  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        provider: "codex",
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope) ? skill.scope : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function createCodexProvider(options = {}) {
  const defaultExecutable = options.executable ?? "codex";
  const codexStatePath = options.codexStatePath;
  const manageTaskboardSkillPath = options.manageTaskboardSkillPath;

  async function resolveExecutable(providerConfig, env = process.env) {
    const requested = providerConfig?.executable || defaultExecutable;
    return resolveCommandExecutable(requested, {
      env,
      candidates: defaultCodexExecutableCandidates(),
    });
  }

  return {
    id: "codex",
    displayName: "Codex",
    supportsSkills: true,
    supportsSandbox: true,
    requiresSessionId: true,
    supportsCliLogin: true,

    async probeAvailability(env, providerConfig = {}) {
      const executable = await resolveExecutable(providerConfig, env);
      try {
        await execFileAsync(executable, ["--version"], {
          env,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        });
      } catch (error) {
        if (error?.code === "ENOENT") {
          return { available: false, reason: `Executable '${executable}' was not found` };
        }
      }
      const auth = await readCodexAuthStatus(executable, env);
      if (!auth.loggedIn) {
        return { available: false, reason: auth.detail || "Not logged in" };
      }
      return { available: true, detail: auth.detail };
    },

    async startLogin({ env = process.env, providerConfig = {} } = {}) {
      const { startExternalTerminalLogin } = await import("./cli-login.mjs");
      const executable = await resolveExecutable(providerConfig, env);
      // Browser OAuth via Terminal.app — device-auth often returns 403 until enabled
      // in ChatGPT Security settings; in-process login dies with Taskboard restarts.
      return startExternalTerminalLogin({
        providerId: "codex",
        executable,
        args: ["login"],
        label: "Codex",
      });
    },

    async discoverCatalog({ database, projectId, processEnv, providerConfig = {} }) {
      const executable = await resolveExecutable(providerConfig, processEnv);
      let workspacePath = homedir();
      try {
        workspacePath = (await resolveAiWorkspace(projectId, codexStatePath, database)).workspacePath;
      } catch {
        // Connection checks from settings may have no project workspace.
      }
      const [modelResult, skillEntries] = await Promise.all([
        execFileAsync(executable, ["debug", "models"], {
          cwd: workspacePath,
          env: processEnv,
          encoding: "utf8",
          timeout: CATALOG_TIMEOUT_MS,
          maxBuffer: CATALOG_MAX_BUFFER,
        }),
        listSkills(executable, workspacePath, processEnv),
      ]);
      const modelCatalog = JSON.parse(modelResult.stdout);
      return {
        models: sanitizeModels(modelCatalog?.models),
        skills: sanitizeSkills(skillEntries),
        sandboxes: [...SANDBOXES],
      };
    },

    async startTurn({
      thread,
      addDirectories,
      imagePaths,
      attachmentPaths,
      message,
      skills,
      processEnv,
      larkAvailable = false,
      providerConfig = {},
      onEvent,
    }) {
      const executable = await resolveExecutable(providerConfig, processEnv);
      const resumeSessionId = thread.providerSessionId ?? thread.codexThreadId ?? null;
      const turnThread = {
        ...thread,
        codexThreadId: resumeSessionId,
      };
      const args = buildCodexArgs(turnThread, addDirectories, imagePaths);
      const prompt = buildCodexPrompt(
        turnThread,
        { message, skills, attachmentPaths },
        manageTaskboardSkillPath,
        larkAvailable,
      );

      let startedSessionId = null;
      let terminalOutcome = null;
      let terminalError = "";

      const { child, completion } = spawnCodexTurn({
        executable,
        args,
        prompt,
        env: processEnv,
        onRawEvent: (raw) => {
          const normalized = normalizeCodexEvent(raw);
          if (!normalized) return;
          if (normalized.kind === "thread.started") {
            if (
              (resumeSessionId && normalized.threadId !== resumeSessionId)
              || (startedSessionId && normalized.threadId !== startedSessionId)
            ) {
              throw new Error("Codex returned an unexpected thread id");
            }
            startedSessionId = normalized.threadId;
            onEvent({ kind: "session.started", sessionId: normalized.threadId });
            return;
          }
          if (raw.type === "turn.completed" && terminalOutcome === null) {
            terminalOutcome = "completed";
          } else if (raw.type === "turn.failed" || raw.type === "error") {
            terminalOutcome = "failed";
            terminalError ||= normalized.content;
          }
          onEvent(normalized);
        },
      });

      return {
        child,
        completion,
        getTerminalOutcome: () => terminalOutcome,
        getTerminalError: () => terminalError,
        getStartedSessionId: () => startedSessionId,
        getResumeSessionId: () => resumeSessionId,
        label: "Codex",
      };
    },
  };
}
