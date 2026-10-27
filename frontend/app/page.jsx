import fs from "node:fs";
import path from "node:path";
import Script from "next/script";
import { NexusRepositoryPicker } from "../features/nexus/components/NexusRepositoryPicker";
import { DiagramStudioHost } from "../features/diagrams/DiagramStudioHost";

const argusBuild = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "..", "package.json"), "utf8"),
).argusBuild;

function legacyShell() {
  const source = fs.readFileSync(path.resolve(process.cwd(), "..", "public", "index.html"), "utf8");
  let body = source.match(/<body>([\s\S]*?)<script type="module"/i)?.[1];
  if (!body) throw new Error("Argus legacy shell could not be extracted");
  return body.trim();
}

export default function ArgusWorkspace() {
  return (
    <>
      <div id="argus-next-root" dangerouslySetInnerHTML={{ __html: legacyShell() }} />
      <NexusRepositoryPicker />
      <DiagramStudioHost />
      <Script type="module" src={`/legacy/app.js?v=${argusBuild}`} strategy="afterInteractive" />
    </>
  );
}
