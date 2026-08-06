import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "dashi-taskboard.ai-provider";

export class SecretStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

function assertDarwin() {
  if (os.platform() !== "darwin") {
    throw new SecretStoreError(
      "KEYCHAIN_UNSUPPORTED",
      "System keychain is only supported on macOS",
    );
  }
}

function secretAccount(scope, projectId, provider, kind = "api-key") {
  if (scope === "global") return `global:${provider}:${kind}`;
  if (scope === "project" && typeof projectId === "string" && projectId.trim()) {
    return `project:${projectId.trim()}:${provider}:${kind}`;
  }
  throw new SecretStoreError("INVALID_SECRET_ACCOUNT", "Invalid secret account scope");
}

export function createSecretStore(options = {}) {
  const exec = options.execFileAsync ?? execFileAsync;
  const service = options.service ?? KEYCHAIN_SERVICE;

  return {
    supported() {
      return os.platform() === "darwin";
    },

    async getSecret({ scope, projectId, provider, kind = "api-key" }) {
      assertDarwin();
      const account = secretAccount(scope, projectId, provider, kind);
      try {
        const { stdout } = await exec("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ], {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
        const value = stdout.replace(/\r?\n$/, "");
        return value || null;
      } catch (error) {
        if (error?.code === 44 || /could not be found|not found/i.test(String(error?.stderr ?? error?.message ?? ""))) {
          return null;
        }
        throw new SecretStoreError(
          "KEYCHAIN_READ_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async setSecret({ scope, projectId, provider, kind = "api-key", value }) {
      assertDarwin();
      if (typeof value !== "string" || !value.trim()) {
        throw new SecretStoreError("INVALID_SECRET", "Secret value is required");
      }
      const account = secretAccount(scope, projectId, provider, kind);
      await this.deleteSecret({ scope, projectId, provider, kind }).catch(() => {});
      try {
        await exec("security", [
          "add-generic-password",
          "-U",
          "-s",
          service,
          "-a",
          account,
          "-w",
          value.trim(),
        ], {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
      } catch (error) {
        throw new SecretStoreError(
          "KEYCHAIN_WRITE_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async deleteSecret({ scope, projectId, provider, kind = "api-key" }) {
      assertDarwin();
      const account = secretAccount(scope, projectId, provider, kind);
      try {
        await exec("security", [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          account,
        ], {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
      } catch (error) {
        if (error?.code === 44 || /could not be found|not found/i.test(String(error?.stderr ?? error?.message ?? ""))) {
          return false;
        }
        throw new SecretStoreError(
          "KEYCHAIN_DELETE_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
      return true;
    },
  };
}

export { KEYCHAIN_SERVICE, secretAccount };
