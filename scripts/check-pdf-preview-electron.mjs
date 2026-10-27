import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Runs only a test renderer, never desktop/main.mjs or the installed Argus app.
// Profile, caches and result files are isolated and removed on every exit path.
export async function checkPdfPreviewElectron({ pdfPath, screenshotPath, modernBaseline = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "argus-pdf-electron-"));
  const resultPath = path.join(temporary, "result.json");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const args = [path.join(root, "test", "fixtures", "pdf-preview-electron.cjs"), "--fixture-root", temporary];
    if (pdfPath) {
      if (!path.isAbsolute(pdfPath)) throw new Error("The optional PDF fixture must be an explicit absolute path.");
      args.push("--fixture-pdf", pdfPath);
    }
    if (screenshotPath) {
      if (!path.isAbsolute(screenshotPath) || !screenshotPath.endsWith(".png")) throw new Error("The optional screenshot must be an explicit absolute PNG output path.");
      args.push("--fixture-screenshot", screenshotPath);
    }
    if (modernBaseline) args.push("--modern-baseline");
    let output = "";
    await new Promise((resolve, reject) => {
      const child = spawn(require("electron"), args, { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk) => { output = (output + chunk.toString()).slice(-12_000); };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timer = setTimeout(() => {
        // Only the new test process group: never a name-based Electron/Argus kill.
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      }, 55_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Isolated Electron PDF test failed (${code ?? signal}): ${output}`));
      });
    });
    return JSON.parse(await fs.readFile(resultPath, "utf8"));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pdfIndex = args.indexOf("--pdf");
  const screenshotIndex = args.indexOf("--screenshot");
  const allowed = args.filter((_, index) => (index !== pdfIndex + 1 || pdfIndex < 0) && (index !== screenshotIndex + 1 || screenshotIndex < 0));
  if (allowed.some((arg) => !["--pdf", "--screenshot", "--modern-baseline"].includes(arg)) || (pdfIndex >= 0 && !args[pdfIndex + 1]) || (screenshotIndex >= 0 && !args[screenshotIndex + 1])) throw new Error("Usage: node scripts/check-pdf-preview-electron.mjs [--pdf /absolute/file.pdf] [--screenshot /absolute/new.png] [--modern-baseline]");
  console.log(JSON.stringify(await checkPdfPreviewElectron({ pdfPath: pdfIndex >= 0 ? args[pdfIndex + 1] : undefined, screenshotPath: screenshotIndex >= 0 ? args[screenshotIndex + 1] : undefined, modernBaseline: args.includes("--modern-baseline") }), null, 2));
}
