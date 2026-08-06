import { ApiError } from "./database.mjs";

const WORKFLOW_ACTOR = {
  type: "agent",
  id: "workflow-runtime",
  name: "Workflow",
  avatarUrl: null,
};

function nodeById(workspace, nodeId) {
  const nodes = workspace?.nodes;
  if (!Array.isArray(nodes)) return null;
  return nodes.find((node) => node?.id === nodeId) ?? null;
}

function extractNodeData(node) {
  return node?.data && typeof node.data === "object" ? node.data : {};
}

function parseLabels(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function resolveTask(database, projectId, data, inputText) {
  const specific = String(data.specificIssueId || data.issueId || data.taskId || "").trim();
  if (specific) {
    const byId = database.getTask(specific);
    if (byId) return byId;
    const listed = database.listTasks({ projectId, archived: "false" });
    return listed.find((task) => task.identifier === specific || task.id === specific) ?? null;
  }
  const fromInput = String(inputText || "").trim();
  if (fromInput && /^[A-Z]+-\d+$/i.test(fromInput)) {
    const listed = database.listTasks({ projectId, archived: "false" });
    return listed.find((task) => task.identifier.toLowerCase() === fromInput.toLowerCase()) ?? null;
  }
  return null;
}

export function createWorkflowRuntime(options = {}) {
  const lark = options.lark;
  const database = options.database;
  const events = options.events ?? null;

  function emit(type, value) {
    events?.emit?.(type, value);
  }

  async function runFeishuMessage(data, inputText) {
    if (!lark) {
      throw new ApiError(503, "LARK_UNAVAILABLE", "Lark CLI bridge is not configured");
    }
    const text = String(
      inputText
      || data.feishuMessageText
      || data.message
      || data.title
      || "",
    ).trim();
    if (!text) {
      throw new ApiError(400, "INVALID_FIELD", "飞书消息内容为空");
    }
    return lark.sendMessage({
      text,
      recipientType: data.feishuRecipientType || "self",
      userId: data.feishuUserId || "",
      chatId: data.feishuChatId || "",
    });
  }

  async function runFeishuDocs(data) {
    if (!lark) {
      throw new ApiError(503, "LARK_UNAVAILABLE", "Lark CLI bridge is not configured");
    }
    const action = data.feishuDocsAction === "read" ? "read" : "create";
    if (action === "read") {
      return lark.readDoc({ docToken: data.feishuDocToken || data.docToken });
    }
    return lark.createDoc({
      title: data.feishuDocTitle || data.title || "Taskboard Doc",
      content: data.feishuDocContent || data.content || "",
    });
  }

  async function runIssueCreate(projectId, data, inputText) {
    if (!database) {
      throw new ApiError(503, "DATABASE_UNAVAILABLE", "Database is not configured");
    }
    if (!projectId) {
      throw new ApiError(400, "INVALID_FIELD", "'projectId' is required for issue-create");
    }
    const title = String(data.createIssueTitle || data.title || inputText || "").trim();
    if (!title) {
      throw new ApiError(400, "INVALID_FIELD", "创建议题需要标题");
    }
    const task = database.createTask({
      projectId,
      title,
      description: String(data.createIssueDescription || "").trim(),
      status: data.createIssueStatus || "todo",
      priority: data.createIssuePriority || "none",
      labels: parseLabels(data.createIssueLabels),
      actor: WORKFLOW_ACTOR,
      assignee: WORKFLOW_ACTOR,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    emit("task.created", { task });
    return { task };
  }

  async function runIssueUpdate(projectId, data, inputText) {
    if (!database) {
      throw new ApiError(503, "DATABASE_UNAVAILABLE", "Database is not configured");
    }
    if (!projectId) {
      throw new ApiError(400, "INVALID_FIELD", "'projectId' is required for issue-update");
    }
    let task = resolveTask(database, projectId, data, inputText);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", "未找到要更新的议题，请填写 specificIssueId 或传入 ISSUE 标识");
    }

    if (data.changeStatus && data.targetStatus && data.targetStatus !== task.status) {
      task = database.moveTask(task.id, task.version, data.targetStatus, undefined, null);
      emit("task.moved", { task });
    }

    if (data.setPriority && data.targetPriority && data.targetPriority !== task.priority) {
      task = database.updateTask(task.id, task.version, { priority: data.targetPriority }, null);
      emit("task.updated", { task });
    }

    if (data.addLabels) {
      const extra = parseLabels(data.labelsToAdd);
      if (extra.length > 0) {
        const labels = [...new Set([...(task.labels || []), ...extra])];
        task = database.updateTask(task.id, task.version, { labels }, null);
        emit("task.updated", { task });
      }
    }

    if (data.addComment) {
      const body = data.commentSource === "custom"
        ? String(data.customComment || "").trim()
        : String(inputText || data.customComment || "").trim();
      if (body) {
        const comment = database.createComment(task.id, {
          body,
          actor: WORKFLOW_ACTOR,
        });
        emit("comment.created", { comment, task });
      }
    }

    return { task: database.getTask(task.id) };
  }

  function resolveWorkspaceNode(projectId, nodeId) {
    const record = database.getWorkflowWorkspace(projectId);
    const tabs = record?.workspace?.tabs ?? record?.workspace?.workflows;
    let workspace = record?.workspace;
    if (Array.isArray(tabs) && tabs.length > 0) {
      const activeId = record.workspace.activeWorkflowId || tabs[0]?.id;
      workspace = tabs.find((tab) => tab.id === activeId)?.snapshot
        || tabs.find((tab) => tab.id === activeId)
        || tabs[0]?.snapshot
        || tabs[0];
    }
    if (!workspace?.nodes && record?.workspace?.nodes) {
      workspace = record.workspace;
    }
    if (!workspace?.nodes && Array.isArray(record?.workspace?.workflowTabs)) {
      const activeId = record.workspace.activeWorkflowId;
      const tab = record.workspace.workflowTabs.find((entry) => entry.id === activeId)
        || record.workspace.workflowTabs[0];
      workspace = tab?.snapshot || null;
    }
    let node = nodeById(workspace, nodeId);
    if (!node && Array.isArray(record?.workspace?.nodes)) {
      node = nodeById(record.workspace, nodeId);
    }
    if (!node) {
      const candidates = [
        record?.workspace,
        ...(record?.workspace?.workflowTabs ?? []).map((tab) => tab.snapshot),
        ...(record?.workspace?.tabs ?? []).map((tab) => tab.snapshot || tab),
      ].filter(Boolean);
      for (const candidate of candidates) {
        node = nodeById(candidate, nodeId);
        if (node) break;
      }
    }
    return node;
  }

  async function executeKind(kind, { projectId, data, inputText }) {
    if (kind === "feishu-message") {
      const result = await runFeishuMessage(data, inputText);
      return { kind, ok: true, result };
    }
    if (kind === "feishu-docs") {
      const result = await runFeishuDocs(data);
      return { kind, ok: true, result };
    }
    if (kind === "issue-create") {
      const result = await runIssueCreate(projectId, data, inputText);
      return { kind, ok: true, result };
    }
    if (kind === "issue-update") {
      const result = await runIssueUpdate(projectId, data, inputText);
      return { kind, ok: true, result };
    }
    throw new ApiError(
      400,
      "UNSUPPORTED_WORKFLOW_NODE",
      `Node kind '${kind || "unknown"}' is not executable yet`,
    );
  }

  async function runNode({ projectId, nodeId, node: nodeInput, inputText }) {
    let node = nodeInput;
    if (!node) {
      if (!projectId || !nodeId) {
        throw new ApiError(400, "INVALID_FIELD", "'projectId' and 'nodeId' are required");
      }
      if (!database) {
        throw new ApiError(503, "DATABASE_UNAVAILABLE", "Database is not configured");
      }
      node = resolveWorkspaceNode(projectId, nodeId);
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node '${nodeId}' was not found`);
      }
    }

    const data = extractNodeData(node);
    return executeKind(data.kind, { projectId, data, inputText });
  }

  async function runNodeData({ projectId = null, data, inputText }) {
    if (!data || typeof data !== "object") {
      throw new ApiError(400, "INVALID_BODY", "'data' is required");
    }
    return executeKind(data.kind, { projectId, data, inputText });
  }

  return { runNode, runNodeData };
}
