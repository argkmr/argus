import fs from "node:fs/promises";
import path from "node:path";

const MAX_VERSION_ENTRIES = 512;
const MAX_VERSIONS = 64;
const VERSION = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

function managerHome(value, fallback) {
  return value && path.isAbsolute(value) ? value : fallback;
}

async function nvmBins(root) {
  const versions = [];
  try {
    const directory = await fs.opendir(path.join(root, "versions", "node"));
    let count = 0;
    for await (const entry of directory) {
      // Refuse an unusually large/untrusted directory rather than selecting a
      // filesystem-order-dependent subset or walking arbitrary descendants.
      if (++count > MAX_VERSION_ENTRIES) return [];
      if (VERSION.test(entry.name)) versions.push(entry.name);
    }
  } catch { return []; }
  versions.sort((a, b) => {
    const left = a.slice(1).split(".").map(Number), right = b.slice(1).split(".").map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2] || a.localeCompare(b);
  });
  const bins = await Promise.all(versions.slice(0, MAX_VERSIONS).map(async version => {
    const bin = path.join(root, "versions", "node", version, "bin");
    try {
      const node = path.join(bin, "node");
      if (!(await fs.stat(node)).isFile()) return null;
      await fs.access(node, fs.constants.X_OK);
      return bin;
    } catch { return null; }
  }));
  return bins.filter(Boolean);
}

/** Finder-safe discovery; never sources shell profiles, nvm scripts or project files. */
export async function commonCliPath(environment, home) {
  const inherited = String(environment.PATH || "").split(path.delimiter).filter(Boolean);
  const paths = [
    "/opt/homebrew/bin", "/usr/local/bin",
    path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"),
    path.join(home, ".pyenv", "shims"), path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"), path.join(home, ".local", "share", "pnpm"),
    ...["3.9", "3.10", "3.11", "3.12", "3.13", "3.14"].map(version => path.join(home, "Library", "Python", version, "bin")),
    ...inherited,
    path.join(managerHome(environment.VOLTA_HOME, path.join(home, ".volta")), "bin"),
    ...await nvmBins(managerHome(environment.NVM_DIR, path.join(home, ".nvm"))),
  ];
  return [...new Set(paths)].join(path.delimiter);
}
