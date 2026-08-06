import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatProviderId,
  AiChatRun,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  AiProviderSettingsPatch,
  AiProviderSettingsResponse,
  AiProviderTestResult,
  Attachment,
  Comment,
  DevelopmentScan,
  IssueRelationType,
  LarkSettingsResponse,
  LarkSyncResult,
  LarkTestResult,
  Project,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskStatus,
  WorkflowCapabilities,
  WorkflowRunResult,
  WorkflowWorkspaceRecord,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接本地 Taskboard 服务，请重新通过 Taskboard 启动 Codex。",
      },
    });
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function getAiProviderSettings(
  projectId?: string | null,
  signal?: AbortSignal,
): Promise<AiProviderSettingsResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return request<AiProviderSettingsResponse>(`/api/local/ai-providers/config${query}`, { signal });
}

export async function saveAiProviderSettings(input: {
  scope: "global" | "project";
  projectId?: string;
  provider: AiChatProviderId;
  patch?: AiProviderSettingsPatch;
  apiKey?: string | null;
  clearApiKey?: boolean;
}): Promise<AiProviderSettingsResponse> {
  return request<AiProviderSettingsResponse>("/api/local/ai-providers/config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteAiProviderSettings(input: {
  scope: "global" | "project";
  projectId?: string;
  provider: AiChatProviderId;
}): Promise<AiProviderSettingsResponse> {
  const query = new URLSearchParams({
    scope: input.scope,
    provider: input.provider,
  });
  if (input.projectId) query.set("projectId", input.projectId);
  return request<AiProviderSettingsResponse>(
    `/api/local/ai-providers/config?${query}`,
    { method: "DELETE" },
  );
}

export async function testAiProvider(input: {
  provider: AiChatProviderId;
  projectId?: string | null;
  draft?: AiProviderSettingsPatch & { apiKey?: string };
}): Promise<AiProviderTestResult> {
  return request<AiProviderTestResult>("/api/local/ai-providers/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function loginAiProvider(input: {
  provider: AiChatProviderId;
  projectId?: string | null;
  draft?: AiProviderSettingsPatch;
}): Promise<{
  ok: boolean;
  providerId: AiChatProviderId;
  detail?: string;
  loginUrl?: string | null;
  openedInBrowser?: boolean;
}> {
  return request("/api/local/ai-providers/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getLarkSettings(signal?: AbortSignal): Promise<LarkSettingsResponse> {
  return request<LarkSettingsResponse>("/api/local/lark/config", { signal });
}

export async function saveLarkSettings(input: {
  enabled?: boolean;
  executable?: string;
  defaultAs?: "user" | "bot";
  notify?: Partial<LarkSettingsResponse["config"]["notify"]>;
  sync?: Partial<Omit<LarkSettingsResponse["config"]["sync"], "mappingCount">>;
}): Promise<LarkSettingsResponse> {
  return request<LarkSettingsResponse>("/api/local/lark/config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function testLarkConnection(input: {
  executable?: string;
} = {}): Promise<LarkTestResult> {
  return request<LarkTestResult>("/api/local/lark/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listLarkChats(input: {
  query?: string;
  as?: "user" | "bot";
} = {}, signal?: AbortSignal): Promise<{
  ok: boolean;
  identity?: string | null;
  query?: string | null;
  chats: Array<{
    chatId: string;
    name: string;
    description: string;
    chatMode: string | null;
    external: boolean;
  }>;
}> {
  const params = new URLSearchParams();
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.as) params.set("as", input.as);
  const query = params.toString();
  return request(`/api/local/lark/chats${query ? `?${query}` : ""}`, { signal });
}

export async function installLarkSkills(): Promise<{ ok: boolean; detail?: string; installedAt?: string }> {
  return request("/api/local/lark/skills/install", { method: "POST", body: "{}" });
}

export async function runLarkSync(): Promise<LarkSyncResult> {
  return request<LarkSyncResult>("/api/local/lark/sync", { method: "POST", body: "{}" });
}

export async function runWorkflowNode(input: {
  projectId?: string;
  nodeId?: string;
  data?: Record<string, unknown>;
  inputText?: string;
}): Promise<WorkflowRunResult> {
  return request<WorkflowRunResult>("/api/local/workflow/run", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  title?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export type LocalAutomationLastRun = {
  at: number | null;
  outcome: "succeeded" | "failed" | "skipped" | "idle" | null;
  error: string | null;
  threadId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  mode: "cli" | "api" | null;
};

export async function getLocalAutomation(
  projectId: string,
  signal?: AbortSignal,
): Promise<{
  item?: {
    id: string;
    status: "ACTIVE" | "PAUSED";
    provider?: string | null;
    model: string;
    reasoningEffort: string;
    rrule: string;
    nextRunAt?: number | null;
    lastRun?: LocalAutomationLastRun | null;
  };
  items?: Array<{
    id: string;
    status: "ACTIVE" | "PAUSED";
    provider?: string | null;
    model: string;
    reasoningEffort: string;
    rrule: string;
    nextRunAt?: number | null;
    lastRun?: LocalAutomationLastRun | null;
  }>;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: number;
    provider?: string | null;
    model: string;
    reasoningEffort: string;
    lastRun?: LocalAutomationLastRun | null;
  } | null;
  quota?: {
    state: "available" | "blocked" | "unknown" | "unavailable";
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key" | "local";
  };
}> {
  return request(`/api/local/automation?projectId=${encodeURIComponent(projectId)}`, { signal });
}

export async function saveLocalAutomation(input: {
  projectId: string;
  enabledByUser: boolean;
  intervalMinutes: number;
  provider?: string | null;
  model: string;
  reasoningEffort: string;
}): Promise<{
  item?: {
    id: string;
    status: "ACTIVE" | "PAUSED";
    provider?: string | null;
    model: string;
    reasoningEffort: string;
    rrule: string;
    nextRunAt?: number | null;
    lastRun?: LocalAutomationLastRun | null;
  };
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: number;
    provider?: string | null;
    model: string;
    reasoningEffort: string;
    lastRun?: LocalAutomationLastRun | null;
  };
  quota?: {
    state: "available" | "blocked" | "unknown" | "unavailable";
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key" | "local";
  };
}> {
  return request("/api/local/automation", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function setProjectWorkspace(
  projectId: string,
  workspacePath: string,
): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ workspacePath }),
    },
  );
  return data.project;
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const data = await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WorkflowCapabilities>(`/api/workflow-capabilities${suffix}`, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ projectId, archived: "false" });
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function updateTask(task: Task, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function createComment(taskId: string, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
