export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface TaskboardMetadata {
  manageTaskboardSkillPath?: string;
  capabilities?: TaskboardCapabilities;
  mode?: "local" | "cloud";
  realtime?: {
    transport: "poll";
    intervalMs: number;
  };
  localCapabilities?: {
    available: boolean;
  };
}

export interface TaskboardCapabilities {
  localAiChat: boolean;
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";

export type AiChatProviderId =
  | "codex"
  | "claude-code"
  | "anthropic"
  | "deepseek"
  | "kimi"
  | "volcengine"
  | "aliyun"
  | "tencent";

export interface AiChatProviderInfo {
  id: AiChatProviderId;
  displayName: string;
  available: boolean;
  reason?: string;
  supportsSkills: boolean;
  supportsSandbox: boolean;
}

export interface AiChatModel {
  provider: AiChatProviderId;
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface AiChatSkill {
  provider?: AiChatProviderId;
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface AiChatAttachmentInput {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface LarkAvailability {
  available: boolean;
  installed: boolean;
  loggedIn: boolean;
  executable?: string;
  detail?: string;
  skillsInstalledAt?: string | null;
}

export interface AiChatCatalog {
  providers: AiChatProviderInfo[];
  models: AiChatModel[];
  skills: AiChatSkill[];
  sandboxes: string[];
  defaults?: Partial<Record<AiChatProviderId, {
    model: string | null;
    reasoningEffort: string | null;
    sandbox: string | null;
  }>>;
  lark?: LarkAvailability;
}

export interface LarkSettingsConfig {
  enabled: boolean;
  executable: string;
  defaultAs: "user" | "bot";
  lastError: string | null;
  lastTestedAt: string | null;
  notify: {
    enabled: boolean;
    events: string[];
    recipientType: "self" | "user" | "chat";
    userId: string;
    chatId: string;
  };
  sync: {
    enabled: boolean;
    direction: "pull" | "bidirectional";
    projectId: string | null;
    taskListGuid: string;
    intervalSeconds: number;
    writeback: boolean;
    mappingCount: number;
  };
  ai: {
    skillsInstalledAt: string | null;
    skillsDetail: string | null;
  };
}

export interface LarkSettingsResponse {
  config: LarkSettingsConfig;
  availability: LarkAvailability;
}

export interface LarkTestResult {
  ok: boolean;
  installed: boolean;
  loggedIn: boolean;
  executable: string;
  detail?: string;
  identity?: string | null;
  data?: unknown;
}

export interface LarkChatOption {
  chatId: string;
  name: string;
  description: string;
  chatMode: string | null;
  external: boolean;
}

export interface LarkSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  created?: number;
  updated?: number;
  remoteCount?: number;
  mappingCount?: number;
}

export interface WorkflowRunResult {
  kind: string;
  ok: boolean;
  result?: unknown;
}

export interface AiProviderSettingsPatch {
  enabled?: boolean;
  executable?: string | null;
  baseUrl?: string | null;
  models?: string[] | null;
  defaultModel?: string | null;
  reasoningEffort?: string | null;
  sandbox?: AiChatSandbox | null;
}

export interface AiProviderSettingsEntry extends AiProviderSettingsPatch {
  hasApiKey?: boolean;
  apiKeyLastFour?: string | null;
  overriddenFields?: string[];
}

export interface AiProviderEffectiveConfig extends AiProviderSettingsEntry {
  id: AiChatProviderId;
  displayName: string;
  supportsSkills: boolean;
  supportsSandbox: boolean;
  enabled: boolean;
  source?: Record<string, string>;
}

export interface AiProviderSettingsResponse {
  keychainSupported: boolean;
  providers: Array<{
    id: AiChatProviderId;
    displayName: string;
    supportsSkills: boolean;
    supportsSandbox: boolean;
  }>;
  global: {
    providers: Partial<Record<AiChatProviderId, AiProviderSettingsEntry>>;
  };
  project: {
    projectId: string;
    providers: Partial<Record<AiChatProviderId, AiProviderSettingsEntry>>;
  } | null;
  effective: {
    providers: Partial<Record<AiChatProviderId, AiProviderEffectiveConfig>>;
  };
}

export interface AiProviderTestResult {
  ok: boolean;
  providerId: AiChatProviderId;
  reason?: string;
  detail?: string;
  modelCount?: number;
  models?: Array<{ slug: string; displayName: string }>;
  supportsCliLogin?: boolean;
}

export interface AiProviderLoginResult {
  ok: boolean;
  providerId: AiChatProviderId;
  detail?: string;
  loginUrl?: string | null;
  openedInBrowser?: boolean;
}

export interface AiChatOrigin {
  projectId: string;
  projectName: string;
  workspacePath: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  provider: AiChatProviderId;
  providerSessionId: string | null;
  codexThreadId: string | null;
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
}

export interface AiChatEvent {
  id: string;
  threadId?: string;
  runId?: string | null;
  type: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  data?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AiChatThreadSnapshot {
  thread: AiChatThread;
  events: AiChatEvent[];
  runs: AiChatRun[];
}

export interface WorkflowCapabilityOption {
  id: string;
  label: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface WorkflowMcpServerOption {
  id: string;
  label: string;
  transport: string;
}

export interface WorkflowCapabilities {
  skills: WorkflowCapabilityOption[];
  mcpServers: WorkflowMcpServerOption[];
}

export interface WorkflowOption {
  id: string;
  name: string;
}

export interface WorkflowWorkspaceRecord<T = unknown> {
  projectId: string;
  workspace: T | null;
  version: number;
  updatedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface HostContext {
  user?: ActorIdentity;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
