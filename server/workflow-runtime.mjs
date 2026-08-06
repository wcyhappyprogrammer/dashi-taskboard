import { ApiError } from "./database.mjs";

function nodeById(workspace, nodeId) {
  const nodes = workspace?.nodes;
  if (!Array.isArray(nodes)) return null;
  return nodes.find((node) => node?.id === nodeId) ?? null;
}

function extractNodeData(node) {
  return node?.data && typeof node.data === "object" ? node.data : {};
}

export function createWorkflowRuntime(options = {}) {
  const lark = options.lark;
  const database = options.database;

  async function runFeishuMessage(data, inputText) {
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
    const action = data.feishuDocsAction === "read" ? "read" : "create";
    if (action === "read") {
      return lark.readDoc({ docToken: data.feishuDocToken || data.docToken });
    }
    return lark.createDoc({
      title: data.feishuDocTitle || data.title || "Taskboard Doc",
      content: data.feishuDocContent || data.content || "",
    });
  }

  async function runNode({ projectId, nodeId, node: nodeInput, inputText }) {
    if (!lark) {
      throw new ApiError(503, "LARK_UNAVAILABLE", "Lark CLI bridge is not configured");
    }
    let node = nodeInput;
    if (!node) {
      if (!projectId || !nodeId) {
        throw new ApiError(400, "INVALID_FIELD", "'projectId' and 'nodeId' are required");
      }
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
      // WorkflowBoard stores nodes at workspace.nodes or in snapshots.
      if (!workspace?.nodes && record?.workspace?.nodes) {
        workspace = record.workspace;
      }
      if (!workspace?.nodes && Array.isArray(record?.workspace?.workflowTabs)) {
        const activeId = record.workspace.activeWorkflowId;
        const tab = record.workspace.workflowTabs.find((entry) => entry.id === activeId)
          || record.workspace.workflowTabs[0];
        workspace = tab?.snapshot || null;
      }
      node = nodeById(workspace, nodeId);
      if (!node && Array.isArray(record?.workspace?.nodes)) {
        node = nodeById(record.workspace, nodeId);
      }
      if (!node) {
        // Fall back: search all tab snapshots.
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
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node '${nodeId}' was not found`);
      }
    }

    const data = extractNodeData(node);
    const kind = data.kind;
    if (kind === "feishu-message") {
      const result = await runFeishuMessage(data, inputText);
      return { kind, ok: true, result };
    }
    if (kind === "feishu-docs") {
      const result = await runFeishuDocs(data);
      return { kind, ok: true, result };
    }
    throw new ApiError(
      400,
      "UNSUPPORTED_WORKFLOW_NODE",
      `Node kind '${kind || "unknown"}' is not executable yet`,
    );
  }

  async function runNodeData({ data, inputText }) {
    if (!data || typeof data !== "object") {
      throw new ApiError(400, "INVALID_BODY", "'data' is required");
    }
    const kind = data.kind;
    if (kind === "feishu-message") {
      const result = await runFeishuMessage(data, inputText);
      return { kind, ok: true, result };
    }
    if (kind === "feishu-docs") {
      const result = await runFeishuDocs(data);
      return { kind, ok: true, result };
    }
    throw new ApiError(
      400,
      "UNSUPPORTED_WORKFLOW_NODE",
      `Node kind '${kind || "unknown"}' is not executable yet`,
    );
  }

  return { runNode, runNodeData };
}
