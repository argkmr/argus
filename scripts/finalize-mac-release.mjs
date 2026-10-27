import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function releaseArtifactNames(metadata, architecture = "arm64") {
  const version = String(metadata.version || ""), build = String(metadata.argusBuild || "");
  if (!/^[\w.-]+$/.test(version) || !/^[\w.-]+$/.test(build) || !/^(arm64|x64)$/.test(architecture)) throw new Error("Invalid release identity");
  return { generated: `Argus-Personal-${version}-${architecture}.dmg`, versioned: `Argus-Personal-${version}-build-${build}-${architecture}.dmg` };
}

export async function finalizeRelease({ publish = false, root = projectRoot } = {}) {
  const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const names = releaseArtifactNames(metadata);
  const release = path.join(root, "dist", names.versioned);
  const generated = path.join(root, "dist", names.generated);
  try {
    await fs.access(generated);
    await fs.rename(generated, release);
    try { await fs.rename(`${generated}.blockmap`, `${release}.blockmap`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.access(release);
  }
  console.log(`Latest Argus build: ${release}`);
  // Publication is an explicit command; local packaging never inspects or writes Drive.
  if (publish) {
    const workspacePath = path.join(os.homedir(), "Library", "Application Support", "Argus Personal", "workspace.json");
    const workspace = JSON.parse(await fs.readFile(workspacePath, "utf8"));
    const configured = String(workspace?.preferences?.backup?.driveDirectory || "").trim();
    if (!configured) throw new Error("No Google Drive backup destination is configured; the release remains local");
    const backupRoot = path.basename(configured) === "Argus Backups" ? configured : path.join(configured, "Argus Backups");
    const destination = path.join(backupRoot, "releases", names.versioned);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(release, `${destination}.uploading`);
    await fs.rename(`${destination}.uploading`, destination);
    console.log(`Published the current build to ${destination}`);
  }
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(value => value !== "--publish")) throw new Error("Usage: node scripts/finalize-mac-release.mjs [--publish]");
  await finalizeRelease({ publish: process.argv.includes("--publish") });
}
