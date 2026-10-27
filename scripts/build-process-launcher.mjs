import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (!["darwin", "linux"].includes(process.platform)) throw new Error("This desktop build requires a POSIX process launcher.");
const directory = path.join(root, "build", `native-${process.arch}`);
fs.mkdirSync(directory, { recursive: true });
const executable = path.join(directory, "argus-process-launcher");
execFileSync(process.env.CC || "cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-o", executable,
  path.join(root, "desktop", "native", "argus-process-launcher.c")], { stdio: "inherit" });
fs.chmodSync(executable, 0o755);
console.log(`Built Java process-isolation helper: ${executable}`);
