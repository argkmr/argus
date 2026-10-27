// Language servers own ordinary identifiers. Configuration references need a
// wider target because Monaco splits dotted and hyphenated property keys.
export const supportsConfigurationNavigation = path => /\.(?:java|kt|kts|ya?ml|properties)$/i.test(String(path || ""));

export function configurationNavigationSymbols(line, path = "") {
  const text = String(line ?? ""), symbols = [];
  const add = (word, offset) => symbols.push({ word, startColumn: offset + 1, endColumn: offset + word.length + 1 });
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.\-[\]]{0,255})(?=[:}])/g)) {
    // Kotlin interpolates ordinary ${value}; only its escaped form is a Spring
    // placeholder in a regular string. Java/YAML/properties have no such rule.
    if (/\.kts?$/i.test(path)) {
      let slashes = 0; for (let at = match.index - 1; at >= 0 && text[at] === "\\"; at--) slashes++;
      if (slashes % 2 !== 1) continue;
    }
    add(match[1], match.index + 2);
  }
  for (const match of text.matchAll(/\bget(?:Required)?Property\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_.\-[\]]{0,255})\1(?=\s*[,\)])/g)) add(match[2], match.index + match[0].indexOf(match[1]) + 1);
  return symbols.sort((a, b) => a.startColumn - b.startColumn);
}

export function navigationSymbolAt(line, column, ordinaryWord = null, path = "") {
  return configurationNavigationSymbols(line, path).find(symbol => column >= symbol.startColumn && column < symbol.endColumn) || ordinaryWord;
}
