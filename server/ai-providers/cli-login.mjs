import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { cappedText } from "./shared.mjs";

const execFileAsync = promisify(execFile);
const LOGIN_URL_WAIT_MS = 20_000;
const LOGIN_KEEPALIVE_MS = 10 * 60_000;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/i;

const activeLogins = new Map();

function killLogin(providerId) {
  const active = activeLogins.get(providerId);
  if (!active) return;
  activeLogins.delete(providerId);
  clearTimeout(active.timer);
  try {
    active.child.kill("SIGTERM");
  } catch {}
}

async function openUrl(url) {
  try {
    await execFileAsync("open", [url], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function extractLoginUrl(text) {
  const match = String(text || "").match(URL_PATTERN);
  return match?.[0] ?? null;
}

/**
 * Start a CLI login flow that may print a browser URL.
 * Keeps the child alive so OAuth/device callbacks can complete.
 */
export function startCliLogin({
  providerId,
  executable,
  args,
  env = process.env,
  label = providerId,
}) {
  killLogin(providerId);

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    let loginUrl = null;

    const timer = setTimeout(() => {
      activeLogins.delete(providerId);
      try {
        child.kill("SIGTERM");
      } catch {}
    }, LOGIN_KEEPALIVE_MS);

    activeLogins.set(providerId, { child, timer, startedAt: Date.now() });

    const finish = async (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(urlWait);
      resolve(payload);
    };

    const maybeCapture = async (chunk) => {
      buffer = cappedText(`${buffer}${chunk}`);
      if (loginUrl) return;
      const found = extractLoginUrl(buffer);
      if (!found) return;
      loginUrl = found;
      const opened = await openUrl(loginUrl);
      await finish({
        ok: true,
        providerId,
        loginUrl,
        openedInBrowser: opened,
        detail: opened
          ? `已打开 ${label} 登录页，请在浏览器完成授权后回来点「检测连接」`
          : `请打开登录链接完成授权，然后回来点「检测连接」`,
      });
    };

    child.stdout.on("data", (chunk) => {
      void maybeCapture(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      void maybeCapture(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      killLogin(providerId);
      void finish({
        ok: false,
        providerId,
        detail: error?.code === "ENOENT"
          ? `Executable '${executable}' was not found`
          : cappedText(error?.message || String(error)),
      });
    });

    child.on("exit", (code, signal) => {
      const stillTracked = activeLogins.get(providerId)?.child === child;
      if (stillTracked) {
        activeLogins.delete(providerId);
        clearTimeout(timer);
      }
      if (settled) return;
      if (code === 0) {
        void finish({
          ok: true,
          providerId,
          loginUrl,
          detail: `${label} 登录流程已结束，请点「检测连接」确认状态`,
        });
        return;
      }
      void finish({
        ok: false,
        providerId,
        detail: cappedText(
          buffer.trim()
          || `${label} login exited (${signal || code || "unknown"})`,
        ),
      });
    });

    const urlWait = setTimeout(() => {
      if (settled) return;
      // Some CLIs open the system browser without printing a URL promptly.
      void finish({
        ok: true,
        providerId,
        loginUrl: null,
        openedInBrowser: false,
        detail: `已启动 ${label} 登录，请在弹出的浏览器/终端中完成授权，然后点「检测连接」`,
      });
    }, LOGIN_URL_WAIT_MS);
  });
}

export async function readClaudeAuthStatus(executable, env = process.env) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["auth", "status", "--json"], {
      env,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    const text = String(stdout || stderr || "").trim();
    const parsed = JSON.parse(text);
    return {
      loggedIn: parsed?.loggedIn === true,
      authMethod: parsed?.authMethod ?? null,
      detail: parsed?.loggedIn === true
        ? `已登录${parsed?.authMethod ? `（${parsed.authMethod}）` : ""}`
        : "未登录，请先点击「登录」",
      raw: parsed,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { loggedIn: false, detail: `Executable '${executable}' was not found`, raw: null };
    }
    // `claude auth status --json` exits 1 when logged out, but still prints JSON on stdout.
    const text = String(error?.stdout || error?.stderr || "").trim();
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        return {
          loggedIn: parsed?.loggedIn === true,
          authMethod: parsed?.authMethod ?? null,
          detail: parsed?.loggedIn === true
            ? `已登录${parsed?.authMethod ? `（${parsed.authMethod}）` : ""}`
            : "未登录，请先点击「登录」",
          raw: parsed,
        };
      } catch {}
    }
    return {
      loggedIn: false,
      detail: cappedText(text || error?.message || String(error)) || "未登录，请先点击「登录」",
      raw: null,
    };
  }
}

export async function readCodexAuthStatus(executable, env = process.env) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["login", "status"], {
      env,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    const text = String(stdout || stderr || "").trim();
    const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
    return {
      loggedIn,
      detail: loggedIn ? cappedText(text.split("\n")[0] || "已登录") : "未登录，请先点击「登录」",
      raw: text,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { loggedIn: false, detail: `Executable '${executable}' was not found`, raw: null };
    }
    const detail = cappedText(error?.stderr || error?.message || String(error));
    const loggedIn = /logged in/i.test(detail) && !/not logged in/i.test(detail);
    return { loggedIn, detail: loggedIn ? detail : (detail || "未登录，请先点击「登录」"), raw: detail };
  }
}
