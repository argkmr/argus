import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function developmentConfiguration(environment = process.env, directory = root) {
  const requestedPort = String(environment.ARGUS_PORT || "4175");
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535) {
    throw new Error("ARGUS_PORT must be an integer between 1 and 65535.");
  }
  const dataDirectory = path.resolve(directory, environment.ARGUS_DATA_DIR || ".argus-data/dev");
  const sourceRoot = path.resolve(directory, environment.ARGUS_SOURCE_ROOT || ".");
  return {
    jar: path.join(directory, "backend", "target", "argus-backend-0.1.0.jar"),
    environment: {
      ...environment,
      ARGUS_PORT: requestedPort,
      ARGUS_PUBLIC_PORT: requestedPort,
      ARGUS_DATA_DIR: dataDirectory,
      ARGUS_SOURCE_ROOT: sourceRoot,
      ARGUS_IDE_TYPESCRIPT_SERVER: path.join(directory, "build/ide-tools/typescript-language-server/lib/cli.mjs"),
      ARGUS_IDE_JS_DEBUG_SERVER: path.join(directory, "build/ide-tools/js-debug/src/dapDebugServer.js"),
      ARGUS_IDE_TYPESCRIPT_SDK: path.join(directory, "build/ide-tools/typescript/lib/tsserver.js"),
      ARGUS_IDE_JDTLS_HOME: path.join(directory, "build/ide-tools/jdtls"),
      ARGUS_MAINTENANCE_DATA_DIR: path.join(dataDirectory, "maintenance"),
      ARGUS_API_COLLECTIONS_DIR: path.resolve(directory, environment.ARGUS_API_COLLECTIONS_DIR || path.join(dataDirectory, "api-collections")),
      ARGUS_BACKUP_REPOSITORY_DIR: path.join(dataDirectory, "backup-repository"),
      ARGUS_MCP_TOKEN: crypto.randomBytes(32).toString("base64url"),
      ARGUS_PROCESS_LAUNCHER: path.join(directory, "build", `native-${process.arch}`, "argus-process-launcher"),
    },
  };
}

export function javaArguments(jar) {
  return ["-XX:TieredStopAtLevel=1", "-Xms32m", "-Xmx768m", "-Djava.awt.headless=true",
    "-Dspring.jmx.enabled=false", "-jar", jar];
}

function javaHome(environment) {
  if (environment.JAVA_HOME) return environment.JAVA_HOME;
  if (process.platform === "darwin") {
    try { return execFileSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { throw new Error("Install a Java 17 JDK or set JAVA_HOME to a compatible JDK before starting Argus."); }
  }
  return "";
}

export async function startDevelopment({ skipBuild = false, environment = process.env } = {}) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Argus's native process owner currently requires macOS or Linux.");
  const config = developmentConfiguration(environment);
  const home = javaHome(config.environment);
  if (home) {
    config.environment.JAVA_HOME = home;
    config.environment.PATH = `${path.join(home, "bin")}${path.delimiter}${config.environment.PATH || ""}`;
  }
  const executable = home ? path.join(home, "bin", "java") : "java";
  let child;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (child?.exitCode === null && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  const run = (command, args) => new Promise((resolve, reject) => {
    if (stopping) { reject(new Error("Development startup was stopped.")); return; }
    child = spawn(command, args, { cwd: root, env: config.environment, stdio: "inherit", detached: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || stopping ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}.`)));
  });
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (!skipBuild) {
      await run(process.execPath, [path.join(root, "scripts", "sync-build-id.mjs")]);
      await run(process.execPath, [path.join(root, "scripts", "build-ide-tools.mjs")]);
      await run("npm", ["--prefix", "frontend", "run", "build"]);
      await run("mvn", ["-f", "backend/pom.xml", "-DskipTests", "package"]);
      await run(process.execPath, [path.join(root, "scripts", "build-process-launcher.mjs")]);
    }
    if (stopping) return;
    config.environment.ARGUS_BUILD_ID = environment.ARGUS_BUILD_ID || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).argusBuild || "development";
    if (!fs.existsSync(config.jar)) throw new Error("The Java backend has not been built. Run npm run dev without --skip-build first.");
    if (!fs.existsSync(config.environment.ARGUS_PROCESS_LAUNCHER)) throw new Error("The native process helper is missing. Run npm run dev without --skip-build first.");
    console.log(`Argus: http://127.0.0.1:${config.environment.ARGUS_PORT} — Java serves both the API and exported frontend.`);
    console.log(`Development data: ${config.environment.ARGUS_DATA_DIR}`);
    await run(executable, javaArguments(config.jar));
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some(argument => argument !== "--skip-build")) {
    console.error("Usage: node scripts/dev.mjs [--skip-build]"); process.exitCode = 1;
  } else {
    await startDevelopment({ skipBuild: arguments_.includes("--skip-build") }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
