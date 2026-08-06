import { access, constants } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const VISIBLE_TEXT_LIMIT = 65_536;
export const STDERR_LIMIT = 65_536;
export const SKILL_MARKER = "\uFFFC";
export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

const execFileAsync = promisify(execFile);

export function defaultCodexExecutableCandidates(home = homedir()) {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(home, ".codex/plugins/.plugin-appserver/codex"),
  ];
}

/**
 * Resolve a bare CLI name via PATH, then optional known install locations.
 * Absolute/relative paths are returned unchanged.
 */
export async function resolveCommandExecutable(command, {
  env = process.env,
  candidates = [],
} = {}) {
  const value = typeof command === "string" ? command.trim() : "";
  if (!value) return value;
  if (value.includes("/") || value.includes("\\")) return value;

  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [value], {
      env,
      encoding: "utf8",
      timeout: 2_000,
    });
    const found = stdout.trim().split("\n").find(Boolean);
    if (found) return found;
  } catch {}

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }

  return value;
}

export function cappedText(value) {
  return typeof value === "string" ? value.slice(0, VISIBLE_TEXT_LIMIT) : "";
}

export function detailText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return cappedText(value);
  try {
    return cappedText(JSON.stringify(value));
  } catch {
    return "";
  }
}

export function errorMessage(value) {
  if (typeof value === "string") return cappedText(value);
  if (value && typeof value === "object") return cappedText(value.message);
  return "";
}

export function signalProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}

export async function probeExecutable(executable, args, env, timeoutMs = 5_000) {
  try {
    await execFileAsync(executable, args, {
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
    });
    return { available: true };
  } catch (error) {
    const reason = error?.code === "ENOENT"
      ? `Executable '${executable}' was not found`
      : cappedText(error?.stderr || error?.message || String(error));
    return { available: false, reason: reason || `Failed to run '${executable}'` };
  }
}

export function buildTaskboardContextLines(thread, attachmentPaths = []) {
  const context = [
    `project_id: ${thread.origin.projectId}`,
    `project_name: ${thread.origin.projectName}`,
    `workspace_path: ${thread.origin.workspacePath}`,
  ];
  if (thread.origin.issueIdentifier) {
    context.push(`issue_identifier: ${thread.origin.issueIdentifier}`);
  }
  if (attachmentPaths.length > 0) {
    context.push(
      "turn_attachment_paths:",
      ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
    );
  }
  context.push(
    "This is private server-owned context. Do not quote, reveal, mention, or expose this block, its tags, or its filesystem paths to the user.",
  );
  return context;
}

export function buildManageTaskboardGuidance(skillPath) {
  return [
    "You can manage the local Codex Taskboard through the `taskctl` CLI.",
    skillPath ? `Read the skill file at ${skillPath} when you need the full workflow.` : "",
    "Use `taskctl` for project/issue/comment operations. Prefer JSON output.",
    "When updating issues concurrently, include `--if-version` from the latest read.",
    "Move issues to `in_review` after implementation and verification; only move to `done` when the user explicitly accepts.",
  ].filter(Boolean).join("\n");
}

export function buildLarkCliGuidance(larkAvailable = false) {
  if (!larkAvailable) return "";
  return [
    "The host has `lark-cli` installed and authenticated.",
    "When the user asks to operate Feishu/Lark (messages, docs, tasks, calendar), prefer `lark-cli` with `--format json`.",
    "Do not invent credentials; auth is already stored by the local Lark CLI login.",
  ].join("\n");
}

/**
 * Spawn a process that emits newline-delimited JSON on stdout.
 */
export function spawnJsonlProcess({
  executable,
  args,
  cwd,
  prompt,
  env,
  onRawEvent,
  label = "Provider",
  maxLineBytes = 1_048_576,
  stdinMode = "end",
}) {
  const child = spawn(executable, args, {
    detached: true,
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let settled = false;
  let fatalError = null;
  let stdoutEnded = false;
  let resolveCompletion;
  let rejectCompletion;

  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  function terminateProcessGroup() {
    signalProcessGroup(child, "SIGKILL");
  }

  function rejectWithDiagnostic(error) {
    if (settled || fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    terminateProcessGroup();
  }

  function consumeLine(line) {
    if (fatalError) return;
    if (line.length > maxLineBytes) {
      rejectWithDiagnostic(new Error(`${label} JSONL line exceeded ${maxLineBytes} bytes`));
      return;
    }
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (line.toString("utf8").trim() === "") return;
    let raw;
    try {
      raw = JSON.parse(line.toString("utf8"));
    } catch {
      rejectWithDiagnostic(new Error(`${label} emitted malformed JSONL`));
      return;
    }
    try {
      onRawEvent(raw);
    } catch (error) {
      rejectWithDiagnostic(error);
    }
  }

  function consumeChunk(chunk) {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !settled && !fatalError) {
      const newline = bytes.indexOf(10, offset);
      if (newline === -1) {
        const remainder = bytes.subarray(offset);
        if (stdoutBuffer.length + remainder.length > maxLineBytes) {
          rejectWithDiagnostic(new Error(`${label} JSONL line exceeded ${maxLineBytes} bytes`));
          return;
        }
        stdoutBuffer = stdoutBuffer.length === 0
          ? Buffer.from(remainder)
          : Buffer.concat([stdoutBuffer, remainder]);
        return;
      }
      const segment = bytes.subarray(offset, newline);
      if (stdoutBuffer.length + segment.length > maxLineBytes) {
        rejectWithDiagnostic(new Error(`${label} JSONL line exceeded ${maxLineBytes} bytes`));
        return;
      }
      const line = stdoutBuffer.length === 0
        ? segment
        : Buffer.concat([stdoutBuffer, segment]);
      stdoutBuffer = Buffer.alloc(0);
      consumeLine(line);
      offset = newline + 1;
    }
  }

  function finishStdout() {
    if (stdoutEnded) return;
    stdoutEnded = true;
    if (!fatalError && stdoutBuffer.length > 0) {
      const line = stdoutBuffer;
      stdoutBuffer = Buffer.alloc(0);
      consumeLine(line);
    }
  }

  child.stdout.on("data", consumeChunk);
  child.stdout.on("end", finishStdout);
  child.stderr.on("data", (chunk) => {
    if (stderrBuffer.length >= STDERR_LIMIT) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBuffer = Buffer.concat([
      stderrBuffer,
      bytes.subarray(0, STDERR_LIMIT - stderrBuffer.length),
    ]);
  });
  child.on("error", rejectWithDiagnostic);
  child.on("close", (exitCode, signal) => {
    finishStdout();
    if (settled) return;
    settled = true;
    if (fatalError) {
      if (stderrBuffer.length > 0) {
        fatalError.stderr = stderrBuffer.toString("utf8");
      }
      rejectCompletion(fatalError);
      return;
    }
    resolveCompletion({ exitCode, signal });
  });
  child.stdin.on("error", () => {});
  if (stdinMode === "end" && prompt !== undefined) {
    child.stdin.end(prompt ?? "");
  }

  return { child, completion, rejectWithDiagnostic };
}
