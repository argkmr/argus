// Compact only directory-only chains. Files (including dotfiles), branches and
// incomplete listings are meaningful boundaries, regardless of language.
function onlyDirectory(path, listing) {
  if (listing?.truncated || !Array.isArray(listing?.entries) || listing.entries.length !== 1) return null;
  const child = listing.entries[0];
  if (child?.directory !== true || child.symlink || child.symbolicLink || typeof child.path !== "string") return null;
  const prefix = `${path}/`, name = child.path.slice(prefix.length);
  if (!child.path.startsWith(prefix) || !name || name === "." || name === ".." || /[/\\\0\r\n]/.test(name)) return null;
  return child;
}

export async function compactDirectoryChain({ path, listing, read, isCurrent = () => true, maxDepth = 32, budgetMs = 1500, now = () => performance.now() }) {
  const chain = [], deadline = now() + budgetMs;
  while (isCurrent() && chain.length < maxDepth) {
    const child = onlyDirectory(path, listing), remaining = deadline - now();
    if (!child || remaining <= 0) break;
    let next;
    try {
      // The caller must apply this remaining budget as the request timeout.
      // Only the folder explicitly opened by the user gets the normal timeout.
      next = await read(child.path, remaining);
    } catch {
      // Keep the last successful listing: the unexpanded child remains visible
      // and can be retried normally instead of hiding an inaccessible folder.
      break;
    }
    if (!isCurrent()) return null;
    if (!Array.isArray(next?.entries)) break;
    chain.push(child); path = child.path; listing = next;
  }
  return isCurrent() ? { path, chain, listing } : null;
}
