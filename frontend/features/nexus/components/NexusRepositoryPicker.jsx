"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./NexusRepositoryPicker.module.css";

const MAX_REPOSITORIES = 6;

export function NexusRepositoryPicker() {
  const [target, setTarget] = useState(null);
  const [repositories, setRepositories] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadRepositories = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load repositories");
      const workspace = await response.json();
      setRepositories(Array.isArray(workspace.repositories) ? workspace.repositories : []);
    } catch {
      // A refresh failure must not silently broaden an explicitly chosen scope.
      setError("Could not refresh repositories. Your selection is unchanged.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setTarget(document.querySelector("#nexus-repository-picker-root"));
    loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    const available = new Set(repositories.map((repository) => repository.id));
    setSelected((current) => current.filter((id) => available.has(id)));
  }, [repositories]);

  useEffect(() => {
    window.argusNexusRepositoryIds = selected;
    if (target) {
      target.dataset.selectedRepositoryCount = String(selected.length);
      target.dataset.repositoryScopeLabel = selected.length ? `${selected.length} repositories` : "All repositories";
    }
  }, [selected, target]);

  function toggle(repositoryId) {
    setSelected((current) => {
      if (current.includes(repositoryId)) return current.filter((id) => id !== repositoryId);
      if (current.length >= MAX_REPOSITORIES) return current;
      return [...current, repositoryId];
    });
  }

  if (!target) return null;

  const label = selected.length ? `${selected.length} selected` : "Auto-select";
  return createPortal(
    <section className={styles.picker} aria-label="Nexus repository scope">
      <details className={styles.menu} onToggle={(event) => event.currentTarget.open && loadRepositories()}>
        <summary><span aria-hidden="true">⌘</span><strong>Repositories</strong><small>{label}</small><svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4" /></svg></summary>
        <div className={styles.popover}>
          <header>
            <small>Select up to {MAX_REPOSITORIES}. Only selected repositories are sent; Auto uses all connected repositories.</small>
            {selected.length > 0 && <button type="button" onClick={() => setSelected([])}>Use Auto</button>}
          </header>
          {error && <p className={styles.error} role="status">{error} <button type="button" onClick={loadRepositories}>Retry</button></p>}
          <div className={styles.list} aria-busy={loading}>
            {loading && !repositories.length && <p>Loading connected repositories…</p>}
            {!loading && !error && !repositories.length && <p>No connected repositories yet.</p>}
            {repositories.map((repository) => {
              const checked = selected.includes(repository.id);
              const disabled = !checked && selected.length >= MAX_REPOSITORIES;
              return (
                <label key={repository.id} className={checked ? styles.selected : ""}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(repository.id)} />
                  <span className={styles.status} />
                  <strong>{repository.name}</strong>
                </label>
              );
            })}
          </div>
        </div>
      </details>
    </section>,
    target,
  );
}
