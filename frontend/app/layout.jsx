import fs from "node:fs";
import path from "node:path";

const argusBuild = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "..", "package.json"), "utf8"),
).argusBuild;

export const metadata = {
  title: "Argus Personal",
  description: "Repositories, Git, diagrams and your Codex or Claude CLI",
  icons: { icon: "/assets/argus-logo.svg" },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.theme=localStorage.getItem("argus-theme")||"dark";document.documentElement.dataset.fontSize=localStorage.getItem("argus-font-size")||"comfortable";document.documentElement.dataset.fontFamily=localStorage.getItem("argus-font-family")||"system";}catch{}` }} />
        <link rel="stylesheet" href={`/legacy/styles.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/chat-revisions.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/git-stash.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/git-bulk-revert.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/font-family.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/agent-question-cards.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/task-prompt-notes.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/repository-ide-shell.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/repository-ports.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/repository-tab-search.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/repository-ide.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/ide-code-chat.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/compact-composer.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/daily-planner.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/planner-time-picker.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/diagram-studio-shell.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/repository-context-bar.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/project-structure-polish.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/ai-context-header.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/repository-ai-kit.css?v=${argusBuild}`} />
        <link rel="stylesheet" href={`/legacy/chat-history-panel.css?v=${argusBuild}`} />
      </head>
      <body>{children}</body>
    </html>
  );
}
