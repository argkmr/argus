import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const modules = [
  "java.base",
  "java.desktop",
  "java.instrument",
  "java.logging",
  "java.management",
  "java.naming",
  "java.net.http",
  "java.security.jgss",
  "java.sql",
  "jdk.crypto.ec",
  "jdk.jdi",
  "jdk.unsupported",
].join(",");

export function validateRuntimeProperties(text, architecture) {
  const property = name => text.match(new RegExp(`^\\s*${name.replaceAll(".", "\\.")}\\s*=\\s*(\\S+)`, "m"))?.[1];
  const version = property("java.specification.version");
  const actualArchitecture = property("os.arch");
  const expected = { arm64: ["aarch64", "arm64"], x64: ["amd64", "x86_64"] }[architecture];
  if (version !== "17") throw new Error(`Argus packaging requires a Java 17 JDK; selected runtime reports ${version || "an unknown version"}. Set JAVA_HOME to Java 17. Repository service JDKs are selected separately.`);
  if (!expected?.includes(actualArchitecture)) throw new Error(`Argus runtime architecture mismatch: expected ${architecture}, found ${actualArchitecture || "unknown"}. Use a native Java 17 JDK.`);
}

function runtimeProperties(executable) {
  const result = spawnSync(executable, ["-XshowSettings:properties", "-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 512 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Could not execute the selected Java runtime for compatibility verification.");
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

export function buildJavaRuntime({ root = repositoryRoot, environment = process.env, architecture = process.arch, platform = process.platform, run = execFileSync, probe = runtimeProperties, rename = fs.renameSync } = {}) {
  // This release command packages the explicitly supported native macOS target.
  // Development Java on other systems is separate from this release artifact.
  if (platform !== "darwin" || architecture !== "arm64") throw new Error("The current Argus desktop release requires macOS arm64; cross-architecture packaging is not supported.");
  const javaHome = environment.JAVA_HOME || run("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8" }).trim();
  // Execute the actual JDK and staged runtime; jlink release files may omit
  // OS_ARCH. Captured properties are never printed to the build log.
  const verify = home => {
    validateRuntimeProperties(probe(path.join(home, "bin", "java")), architecture);
  };
  verify(javaHome);
  const buildDirectory = path.join(root, "build");
  fs.mkdirSync(buildDirectory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(buildDirectory, ".runtime-"));
  const fresh = path.join(staging, "runtime");
  const previous = path.join(staging, "previous");
  const output = path.join(buildDirectory, `runtime-${architecture}`);
  let promoted = false;
  try {
    run(path.join(javaHome, "bin", "jlink"), ["--add-modules", modules, "--strip-debug", "--no-header-files", "--no-man-pages", "--compress=2", "--output", fresh], { stdio: "inherit" });
    verify(fresh);
    if (fs.existsSync(output)) rename(output, previous);
    try { rename(fresh, output); promoted = true; }
    catch (error) {
      if (fs.existsSync(previous)) {
        try { rename(previous, output); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], `Runtime promotion and rollback failed. Previous runtime preserved at ${previous}`); }
      }
      throw error;
    }
    console.log(`Created verified Java 17 ${architecture} runtime at ${output}`);
    return output;
  } finally {
    // Keep the previous runtime recoverable if promotion and rollback both
    // failed (e.g. an external filesystem error). Never erase the last copy.
    if (!fs.existsSync(previous) || promoted) fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildJavaRuntime();
