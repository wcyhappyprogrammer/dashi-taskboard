const PROVIDER_LABELS = {
  codex: "Codex",
  "claude-code": "Claude Code",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  volcengine: "火山引擎",
  aliyun: "阿里云百炼",
  tencent: "腾讯云混元",
};

/**
 * Agent identity used for taskctl writes during an AI turn / auto-claim.
 * Codex keeps the legacy id `codex-agent` for compatibility.
 */
export function agentActorForProvider(providerId, options = {}) {
  const id = typeof providerId === "string" && providerId.trim()
    ? providerId.trim()
    : "codex";
  const displayName = typeof options.displayName === "string" && options.displayName.trim()
    ? options.displayName.trim()
    : (PROVIDER_LABELS[id] ?? id);
  const model = typeof options.model === "string" && options.model.trim()
    ? options.model.trim()
    : null;
  const agentId = id === "codex" ? "codex-agent" : `${id}-agent`;
  const name = model ? `${displayName} · ${model}` : `${displayName} Agent`;
  return {
    type: "agent",
    id: agentId,
    name,
    avatarUrl: null,
  };
}

export { PROVIDER_LABELS };
