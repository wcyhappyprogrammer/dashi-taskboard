import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { resolveAiWorkspace } from "./ai-chat-catalog.mjs";
import { agentActorForProvider } from "../shared/ai-agent-actor.mjs";
import { createProviderRegistry, SANDBOXES } from "./ai-providers/index.mjs";
import { signalProcessGroup } from "./ai-providers/shared.mjs";

const ERROR_CONTENT_LIMIT = 65_536;
const IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SANDBOX_SET = new Set(SANDBOXES);

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.configStore = options.configStore ?? null;
    this.larkCli = options.larkCli ?? null;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.active = new Map();
    this.listeners = new Map();
    this.completions = new Map();
    this.providers = options.providers ?? createProviderRegistry({
      codexExecutable: options.codexExecutable,
      claudeExecutable: options.claudeExecutable,
      codexStatePath: options.codexStatePath,
      manageTaskboardSkillPath: options.manageTaskboardSkillPath,
      processEnv: this.processEnv,
      providerIds: options.providerIds,
      fetchImpl: options.fetchImpl,
      configStore: this.configStore,
    });
  }

  listThreads() {
    return this.database.listAiChatThreads();
  }

  getThread(threadId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(
        404,
        "AI_CHAT_THREAD_NOT_FOUND",
        `AI chat thread '${threadId}' does not exist`,
      );
    }
    return thread;
  }

  getThreadSnapshot(threadId) {
    const thread = this.getThread(threadId);
    return {
      thread,
      events: this.database.listAiChatEvents(threadId),
      runs: this.database.listAiChatRuns(threadId),
    };
  }

  getRun(runId) {
    const run = this.database.getAiChatRun(runId);
    if (!run) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${runId}' does not exist`);
    }
    return run;
  }

  subscribe(threadId, listener) {
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  async getCatalog(projectId) {
    const catalog = await this.providers.getCatalog({
      database: this.database,
      projectId,
      processEnv: this.processEnv,
    });
    if (!this.larkCli) return catalog;
    try {
      catalog.lark = await this.larkCli.getAiAvailability();
    } catch (error) {
      catalog.lark = {
        available: false,
        installed: false,
        loggedIn: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return catalog;
  }

  async createThread(input) {
    const [catalog, resolved] = await Promise.all([
      this.getCatalog(input.projectId),
      resolveAiWorkspace(input.projectId, this.codexStatePath, this.database),
    ]);
    const defaults = catalog.defaults ?? {};
    const preferredProvider = input.provider
      ?? catalog.providers.find((entry) => entry.available)?.id;
    const provider = this.#resolveProvider(catalog, preferredProvider);
    const preferredModel = input.model ?? defaults[provider.id]?.model;
    const model = this.#resolveModel(catalog, preferredModel, provider.id);
    const reasoningEffort = input.reasoningEffort
      ?? defaults[provider.id]?.reasoningEffort
      ?? model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const sandbox = provider.supportsSandbox === false
      ? (input.sandbox ?? "workspace-write")
      : (input.sandbox ?? defaults[provider.id]?.sandbox ?? "workspace-write");
    this.#validateSandbox(sandbox);

    let issue;
    if (input.issueId !== undefined) {
      issue = this.database.getTask(input.issueId);
      if (!issue || issue.projectId !== input.projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${input.issueId}' is not an active task in project '${input.projectId}'`,
        );
      }
    }

    return this.database.createAiChatThread({
      title: input.title ?? issue?.identifier ?? "New conversation",
      origin: {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        workspacePath: resolved.workspacePath,
        ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}),
      },
      provider: provider.id,
      model: model.slug,
      reasoningEffort,
      sandbox,
    });
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    const changesSettings = ["provider", "model", "reasoningEffort", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const wasActive = changesSettings && this.#threadIsActive(thread);

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (
      Object.hasOwn(changes, "provider")
      || Object.hasOwn(changes, "model")
      || Object.hasOwn(changes, "reasoningEffort")
    ) {
      const catalog = await this.getCatalog(thread.origin.projectId);
      thread = this.getThread(threadId);
      const provider = this.#resolveProvider(catalog, changes.provider ?? thread.provider);
      const model = this.#resolveModel(catalog, changes.model ?? thread.model, provider.id);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
      if (Object.hasOwn(changes, "provider") && changes.provider !== thread.provider) {
        changes = {
          ...changes,
          provider: provider.id,
          providerSessionId: null,
          model: Object.hasOwn(changes, "model") ? changes.model : model.slug,
          reasoningEffort: Object.hasOwn(changes, "reasoningEffort")
            ? changes.reasoningEffort
            : model.defaultReasoningEffort,
        };
      }
    }
    if (wasActive || (changesSettings && this.#threadIsActive(thread))) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }

    return this.database.updateAiChatThread(threadId, changes);
  }

  deleteThread(threadId) {
    const thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    return this.database.deleteAiChatThread(threadId);
  }

  async startTurn(threadId, input) {
    let thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const [catalog, resolved] = await Promise.all([
      this.getCatalog(thread.origin.projectId),
      resolveAiWorkspace(thread.origin.projectId, this.codexStatePath, this.database),
    ]);

    thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    const provider = this.#resolveProvider(catalog, thread.provider);
    const model = this.#resolveModel(catalog, thread.model, provider.id);
    this.#validateReasoningEffort(model, thread.reasoningEffort);
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }

    const skillIds = input.skillIds ?? [];
    if (skillIds.length > 0 && provider.supportsSkills === false) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        `Provider '${provider.id}' does not support skills`,
      );
    }
    const availableSkills = new Map(
      catalog.skills
        .filter((skill) => (
          skill.id !== "manage-taskboard"
          && (skill.provider ?? "codex") === provider.id
        ))
        .map((skill) => [skill.id, skill]),
    );
    for (const skillId of skillIds) {
      if (!availableSkills.has(skillId)) {
        throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
      }
    }
    const selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
      imagePaths,
    } = await this.#writeTurnAttachments(attachments);
    try {
      const run = this.database.createAiChatRun({ threadId });
      this.#emit(threadId, { type: "ai.run", run });
      const userEventData = {};
      if (skillIds.length > 0) userEventData.skillIds = skillIds;
      if (attachments.length > 0) {
        userEventData.attachments = attachments.map(({ filename, contentType, size }) => ({
          filename,
          contentType,
          size,
        }));
      }
      const userEvent = this.database.insertAiChatEvent({
        threadId,
        runId: run.id,
        type: "user_message",
        role: "user",
        content: input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      });
      this.#emit(threadId, { type: "ai.event", event: userEvent });

      const historyEvents = this.database.listAiChatEvents(threadId);
      const providerConfig = await this.providers.resolveProviderConfig(
        provider.id,
        thread.origin.projectId,
      );
      if (providerConfig.enabled === false) {
        throw new ApiError(
          400,
          "INVALID_PROVIDER",
          `Provider '${provider.id}' is disabled in AI provider settings`,
        );
      }
      const agentActor = agentActorForProvider(provider.id, {
        displayName: provider.displayName,
        model: model.slug,
      });
      let processEnv = {
        ...this.processEnv,
        TASKBOARD_AGENT_ID: agentActor.id,
        TASKBOARD_AGENT_NAME: agentActor.name,
        CODEX_THREAD_ID: threadId,
      };
      let larkAvailable = false;
      if (this.larkCli) {
        try {
          processEnv = await this.larkCli.ensureLarkOnPath(processEnv);
          const availability = await this.larkCli.getAiAvailability();
          larkAvailable = availability.available === true;
        } catch {
          // keep agent identity env even if Lark PATH enrichment fails
        }
      }
      const handle = await provider.startTurn({
        thread,
        addDirectories: resolved.addDirectories,
        imagePaths,
        attachmentPaths,
        message: input.message,
        skills: selectedSkills,
        processEnv,
        larkAvailable,
        providerConfig,
        historyEvents,
        onEvent: (normalized) => {
          if (normalized.kind === "session.started") {
            this.database.updateAiChatThread(threadId, {
              providerSessionId: normalized.sessionId,
            });
            return;
          }
          if (normalized.kind !== "event") return;
          const event = this.database.insertAiChatEvent({
            threadId,
            runId: run.id,
            type: normalized.type,
            role: normalized.role,
            content: normalized.content,
            data: normalized.data,
          });
          this.#emit(threadId, { type: "ai.event", event });
        },
      });

      const active = {
        child: handle.child ?? null,
        abortController: handle.abortController ?? null,
        threadId,
        interrupted: false,
        temporaryDirectory,
        label: handle.label ?? provider.displayName,
        getTerminalOutcome: handle.getTerminalOutcome,
        getTerminalError: handle.getTerminalError,
        getStartedSessionId: handle.getStartedSessionId,
        getResumeSessionId: handle.getResumeSessionId,
        requiresSessionId: provider.requiresSessionId === true,
      };
      this.active.set(run.id, active);
      const finalization = handle.completion.then(
        (result) => this.#finishRun({ run, active, result }),
        (error) => this.#finishRun({ run, active, error }),
      );
      this.completions.set(run.id, finalization);
      void finalization.finally(() => this.completions.delete(run.id)).catch(() => {});
      return run;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async waitForRun(runId) {
    const pending = this.completions.get(runId);
    if (pending) {
      await pending.catch(() => {});
      return this.getRun(runId);
    }
    let run = this.getRun(runId);
    while (run.status === "running") {
      await wait(100);
      run = this.getRun(runId);
    }
    return run;
  }

  async interrupt(runId) {
    let run = this.getRun(runId);
    if (run.status !== "running") return run;

    const active = this.active.get(runId);
    if (!active) {
      run = this.database.updateAiChatRun(runId, {
        status: "interrupted",
        error: "Interrupted",
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run });
      return run;
    }

    active.interrupted = true;
    if (active.abortController) {
      try {
        active.abortController.abort();
      } catch {}
    }
    if (active.child) {
      signalProcessGroup(active.child, "SIGTERM");
      const timer = setTimeout(() => {
        if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
      }, this.killGraceMs);
      timer.unref();
    }

    const completion = this.completions.get(runId);
    if (completion) {
      await Promise.race([completion.catch(() => {}), wait(this.killGraceMs + 25)]);
    }
    return this.getRun(runId);
  }

  async close() {
    const entries = [...this.active.entries()];
    for (const [, active] of entries) {
      active.interrupted = true;
      if (active.abortController) {
        try {
          active.abortController.abort();
        } catch {}
      }
      if (active.child) signalProcessGroup(active.child, "SIGTERM");
    }

    const completions = entries
      .map(([runId]) => this.completions.get(runId))
      .filter(Boolean);
    if (completions.length > 0) {
      const settled = Promise.allSettled(completions);
      await Promise.race([settled, wait(this.killGraceMs)]);
      for (const [runId, active] of entries) {
        if (this.active.has(runId) && active.child) {
          signalProcessGroup(active.child, "SIGKILL");
        }
      }
      await settled;
    }
    this.listeners.clear();
  }

  #resolveProvider(catalog, requestedProvider) {
    const available = (catalog.providers ?? []).filter((entry) => entry.available);
    const providerId = requestedProvider === undefined
      ? (available[0]?.id ?? this.providers.list()[0]?.id)
      : requestedProvider;
    const meta = (catalog.providers ?? []).find((entry) => entry.id === providerId);
    const provider = this.providers.get(providerId);
    if (!provider || !meta?.available) {
      throw new ApiError(
        400,
        "INVALID_PROVIDER",
        requestedProvider === undefined
          ? "No AI provider is currently available"
          : `Unknown or unavailable provider '${requestedProvider}'${meta?.reason ? `: ${meta.reason}` : ""}`,
      );
    }
    return provider;
  }

  #resolveModel(catalog, requestedModel, providerId) {
    const providerModels = catalog.models.filter((model) => (
      (model.provider ?? "codex") === providerId
    ));
    const model = requestedModel === undefined
      ? providerModels[0]
      : providerModels.find((candidate) => candidate.slug === requestedModel);
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        requestedModel === undefined
          ? `Provider '${providerId}' did not provide an available model`
          : `Unknown model '${requestedModel}' for provider '${providerId}'`,
      );
    }
    return model;
  }

  #validateReasoningEffort(model, reasoningEffort) {
    if (!model.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
  }

  #validateSandbox(sandbox) {
    if (!SANDBOX_SET.has(sandbox)) {
      throw new ApiError(
        400,
        "INVALID_SANDBOX",
        "'sandbox' must be read-only, workspace-write, or danger-full-access",
      );
    }
  }

  #validateTurnInput(input) {
    if (
      !input
      || typeof input.message !== "string"
      || input.message.length > 100_000
      || (
        input.message.trim() === ""
        && (!Array.isArray(input.attachments) || input.attachments.length === 0)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_MESSAGE",
        "A message or at least one attachment is required",
      );
    }
    if (
      input.skillIds !== undefined
      && (
        !Array.isArray(input.skillIds)
        || input.skillIds.length > 20
        || input.skillIds.some((skillId) => typeof skillId !== "string" || !skillId)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        "'skillIds' must contain at most 20 skill ids",
      );
    }
  }

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [], imagePaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codex-taskboard-ai-turn-"),
    );
    try {
      const attachmentPaths = [];
      const imagePaths = [];
      for (const [index, attachment] of attachments.entries()) {
        const attachmentPath = path.join(
          temporaryDirectory,
          `attachment-${index + 1}-${attachment.filename}`,
        );
        await writeFile(attachmentPath, attachment.data, { flag: "wx", mode: 0o600 });
        attachmentPaths.push(attachmentPath);
        if (IMAGE_TYPES.has(attachment.contentType)) imagePaths.push(attachmentPath);
      }
      return { temporaryDirectory, attachmentPaths, imagePaths };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #threadIsActive(thread) {
    return Boolean(thread.currentRun)
      || [...this.active.values()].some((active) => active.threadId === thread.id);
  }

  async #finishRun({ run, active, result, error }) {
    const label = active.label || "Provider";
    const terminalOutcome = active.getTerminalOutcome?.() ?? null;
    const terminalError = active.getTerminalError?.() ?? "";
    const resumeSessionId = active.getResumeSessionId?.() ?? null;
    const startedSessionId = active.getStartedSessionId?.() ?? null;

    let status;
    let publicError = null;
    if (active.interrupted) {
      status = "interrupted";
      publicError = "Interrupted";
    } else if (error) {
      status = "failed";
      publicError = cappedError(error) || `${label} turn failed`;
    } else if (terminalOutcome === "failed") {
      status = "failed";
      publicError = terminalError || `${label} reported a failed turn`;
    } else if (result?.exitCode !== 0 && result?.exitCode !== undefined) {
      status = "failed";
      publicError = result.exitCode === null
        ? `${label} exited due to signal ${result.signal ?? "unknown"}`
        : `${label} exited with code ${result.exitCode}`;
    } else if (terminalOutcome !== "completed") {
      status = "failed";
      publicError = `${label} exited without reporting turn completion`;
    } else if (active.requiresSessionId && !resumeSessionId && !startedSessionId) {
      status = "failed";
      publicError = `${label} did not provide a thread id`;
    } else {
      status = "completed";
    }

    try {
      if (status === "failed" && terminalOutcome !== "failed") {
        const errorEvent = this.database.insertAiChatEvent({
          threadId: run.threadId,
          runId: run.id,
          type: "error",
          role: "error",
          content: cappedError(publicError),
          data: { status: "failed" },
        });
        this.#emit(run.threadId, { type: "ai.event", event: errorEvent });
      }
      const updated = this.database.updateAiChatRun(run.id, {
        status,
        exitCode: result?.exitCode ?? null,
        error: publicError === null ? null : cappedError(publicError),
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run: updated });
      return updated;
    } finally {
      this.active.delete(run.id);
      if (active.temporaryDirectory) {
        await rm(active.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  #emit(threadId, event) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
