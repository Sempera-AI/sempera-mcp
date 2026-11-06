// Where the CLI keeps an API key: the OS keychain when one is available, otherwise a config file only the
// current user can read (mode 0600 in a 0700 directory). SEMPERA_API_KEY in the environment always wins.

import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEYCHAIN_SERVICE = "sempera";
export const KEYCHAIN_ACCOUNT = "api-key";

export function configDir(env = process.env, platform = process.platform) {
  if (env.SEMPERA_CONFIG_DIR) return env.SEMPERA_CONFIG_DIR;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "sempera");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sempera");
}

export function configPath(env = process.env, platform = process.platform) {
  return join(configDir(env, platform), "config.json");
}

/**
 * The OS keychain through the optional `keytar` module, or null when it is not installed, disabled with
 * SEMPERA_NO_KEYCHAIN=1, or cannot load (for example a Linux host without a secret service).
 */
export async function loadKeychain(env = process.env) {
  if (env.SEMPERA_NO_KEYCHAIN === "1") return null;
  try {
    const mod = await import("keytar");
    const keytar = mod.default ?? mod;
    if (typeof keytar.getPassword !== "function") return null;
    return {
      name: "OS keychain",
      get: () => keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
      set: (value) => keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, value),
      delete: () => keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
    };
  } catch {
    return null;
  }
}

async function readConfig(env, warn) {
  const path = configPath(env);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    if (mode & 0o077) warn?.(`warning: ${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`);
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`${path} is not valid JSON; fix it or delete it and run \`sempera login\` again`);
  }
}

async function writeConfig(env, data) {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode applies only when it creates the file
  return path;
}

/** @returns {Promise<{key: string, source: string} | null>} */
export async function resolveApiKey({ env = process.env, keychain, warn } = {}) {
  if (env.SEMPERA_API_KEY) return { key: env.SEMPERA_API_KEY.trim(), source: "SEMPERA_API_KEY" };
  if (keychain) {
    try {
      const key = await keychain.get();
      if (key) return { key, source: keychain.name };
    } catch {
      // A keychain that cannot be read is treated as empty; the config file is still checked.
    }
  }
  const cfg = await readConfig(env, warn);
  if (typeof cfg.api_key === "string" && cfg.api_key) return { key: cfg.api_key, source: configPath(env) };
  return null;
}

/**
 * Store a key. `store` is "auto" (keychain, else file), "keychain" or "file".
 * @returns {Promise<string>} where it was stored
 */
export async function saveApiKey(key, { env = process.env, keychain, store = "auto" } = {}) {
  if (store !== "file") {
    if (keychain) {
      try {
        await keychain.set(key);
        // Never leave an older key behind in the file, where it would be used if the keychain went away.
        await removeKeyFromFile(env);
        return keychain.name;
      } catch (err) {
        if (store === "keychain") throw new Error(`could not write to the OS keychain: ${err.message}`);
      }
    } else if (store === "keychain") {
      throw new Error("no OS keychain is available (install the optional `keytar` module, or use --store file)");
    }
  }
  const cfg = await readConfig(env);
  return writeConfig(env, { ...cfg, api_key: key });
}

async function removeKeyFromFile(env) {
  const cfg = await readConfig(env);
  if (!("api_key" in cfg)) return false;
  delete cfg.api_key;
  if (Object.keys(cfg).length) await writeConfig(env, cfg);
  else await rm(configPath(env), { force: true });
  return true;
}

/** @returns {Promise<string[]>} the places a key was removed from */
export async function deleteApiKey({ env = process.env, keychain } = {}) {
  const removed = [];
  if (keychain) {
    try {
      if (await keychain.delete()) removed.push(keychain.name);
    } catch {
      // Nothing stored there, or no keychain to ask.
    }
  }
  if (await removeKeyFromFile(env)) removed.push(configPath(env));
  return removed;
}
