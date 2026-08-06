export function createLarkNotifier(options = {}) {
  const lark = options.lark;
  let attached = false;

  function formatTaskMessage(type, task) {
    const title = task?.title || "(untitled)";
    const identifier = task?.identifier || task?.id || "";
    const status = task?.status || "";
    const projectId = task?.projectId || "";
    switch (type) {
      case "task.created":
        return `[Taskboard] 新建议题 ${identifier} ${title}（${status}）· ${projectId}`;
      case "task.moved":
        return `[Taskboard] 移动议题 ${identifier} ${title} → ${status}`;
      case "task.archived":
        return `[Taskboard] 归档议题 ${identifier} ${title}`;
      case "task.restored":
        return `[Taskboard] 恢复议题 ${identifier} ${title}`;
      case "task.updated":
      default:
        return `[Taskboard] 更新议题 ${identifier} ${title}（${status}）`;
    }
  }

  async function handle(type, value) {
    if (!lark) return;
    if (value?.source === "lark-sync") return;
    const task = value?.task;
    if (!task) return;

    let config;
    try {
      config = await lark.getInternalConfig();
    } catch {
      return;
    }
    if (!config.enabled || !config.notify?.enabled) return;
    const events = Array.isArray(config.notify.events) ? config.notify.events : [];
    if (!events.includes(type)) return;

    try {
      await lark.sendMessage({
        text: formatTaskMessage(type, task),
        recipientType: config.notify.recipientType || "chat",
        userId: config.notify.userId || "",
        chatId: config.notify.chatId || "",
        as: config.defaultAs,
      });
      await lark.setLastError(null);
    } catch (error) {
      await lark.setLastError(error?.message || String(error)).catch(() => {});
    }
  }

  function attach(eventHub) {
    if (attached || !eventHub?.onLocal) return;
    eventHub.onLocal((type, value) => {
      void handle(type, value);
    });
    attached = true;
  }

  return { handle, attach };
}
