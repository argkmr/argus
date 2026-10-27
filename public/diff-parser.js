function changeRow(oldLine, newLine, oldText, newText, type) {
  return { oldLine, newLine, oldText, newText, type };
}

export function parseUnifiedDiff(diff) {
  const lines = String(diff || "").replace(/\r\n/g, "\n").split("\n");
  const rows = [];
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let index = 0;

  while (index < lines.length) {
    const header = lines[index].match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
    if (!header) { index += 1; continue; }
    let oldRemaining = Number(header[2] ?? 1);
    let newRemaining = Number(header[4] ?? 1);
    let oldLine = Number(header[1]) + (oldRemaining === 0 ? 1 : 0);
    let newLine = Number(header[3]) + (newRemaining === 0 ? 1 : 0);
    hunks += 1;
    rows.push({ type: "hunk", label: `@@ −${header[1]}  +${header[3]} @@${header[5] || ""}` });
    index += 1;

    while (index < lines.length && (oldRemaining > 0 || newRemaining > 0) && !lines[index].startsWith("@@")) {
      const line = lines[index];
      if (line.startsWith("diff --git ") || line.startsWith("index ")) break;
      if (line.startsWith("\\ No newline")) { index += 1; continue; }
      if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        const text = line.slice(1);
        rows.push(changeRow(oldLine++, newLine++, text, text, "context"));
        oldRemaining -= 1;
        newRemaining -= 1;
        index += 1;
        continue;
      }
      if (line.startsWith("-") || line.startsWith("+")) {
        const removed = [];
        const added = [];
        while (index < lines.length) {
          if (lines[index].startsWith("\\ No newline")) { index += 1; continue; }
          if (lines[index].startsWith("-") && oldRemaining > 0) { removed.push(lines[index].slice(1)); oldRemaining -= 1; }
          else if (lines[index].startsWith("+") && newRemaining > 0) { added.push(lines[index].slice(1)); newRemaining -= 1; }
          else break;
          index += 1;
        }
        const count = Math.max(removed.length, added.length);
        if (!count) { index += 1; continue; }
        for (let offset = 0; offset < count; offset += 1) {
          const hasOld = offset < removed.length;
          const hasNew = offset < added.length;
          if (hasOld) deletions += 1;
          if (hasNew) additions += 1;
          rows.push(changeRow(
            hasOld ? oldLine++ : null,
            hasNew ? newLine++ : null,
            hasOld ? removed[offset] : "",
            hasNew ? added[offset] : "",
            hasOld && hasNew ? "changed" : hasOld ? "deleted" : "added",
          ));
        }
        continue;
      }
      index += 1;
    }
  }

  if (!hunks) {
    const meaningful = lines.filter((line) => line && !line.startsWith("diff --git") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ "));
    rows.push({ type: "message", label: meaningful.join("\n") || "No textual changes are available." });
  }
  return { rows, additions, deletions, hunks };
}

function contentLines(content) {
  if (typeof content !== "string" || content === "") return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function expandToFullFile(parsed, beforeContent, afterContent) {
  if (typeof beforeContent !== "string" || typeof afterContent !== "string") return parsed;
  const before = contentLines(beforeContent);
  const after = contentLines(afterContent);
  const changedRows = parsed.rows.filter((row) => !["hunk", "message"].includes(row.type));
  const rows = [];
  let oldCursor = 1;
  let newCursor = 1;

  const appendUnchangedUntil = (oldTarget, newTarget) => {
    while (oldCursor < oldTarget && newCursor < newTarget) {
      rows.push(changeRow(oldCursor, newCursor, before[oldCursor - 1] ?? "", after[newCursor - 1] ?? "", "context"));
      oldCursor += 1;
      newCursor += 1;
    }
  };

  for (const row of changedRows) {
    appendUnchangedUntil(row.oldLine ?? oldCursor, row.newLine ?? newCursor);
    rows.push(row);
    if (row.oldLine != null) oldCursor = row.oldLine + 1;
    if (row.newLine != null) newCursor = row.newLine + 1;
  }

  while (oldCursor <= before.length || newCursor <= after.length) {
    const hasOld = oldCursor <= before.length;
    const hasNew = newCursor <= after.length;
    rows.push(changeRow(
      hasOld ? oldCursor++ : null,
      hasNew ? newCursor++ : null,
      hasOld ? before[oldCursor - 2] ?? "" : "",
      hasNew ? after[newCursor - 2] ?? "" : "",
      hasOld && hasNew ? "context" : hasOld ? "deleted" : "added",
    ));
  }

  return { ...parsed, rows, fullFile: true };
}
