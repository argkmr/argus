import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

const [source, css] = await Promise.all([
  fs.readFile(new URL('../frontend/features/nexus/components/NexusRepositoryPicker.jsx', import.meta.url), 'utf8'),
  fs.readFile(new URL('../frontend/features/nexus/components/NexusRepositoryPicker.module.css', import.meta.url), 'utf8'),
]);

test('repository scope is an inline disclosure inside the compact context menu', () => {
  assert.match(source, /<details className=\{styles\.menu\}/);
  assert.match(source, /<summary>[\s\S]*?<strong>Repositories<\/strong>[\s\S]*?<small>\{label\}<\/small>/);
  assert.doesNotMatch(source, /<p><strong>Exact scope:/);
  assert.doesNotMatch(css, /position:\s*absolute/);
  assert.match(css, /\.list\s*\{[^}]*max-height:\s*min\(220px,\s*32dvh\)[^}]*overflow:\s*auto/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('repository scope uses a fixed-size non-focusable chevron independent of the UI font', () => {
  assert.match(source, /<svg className=\{styles\.chevron\} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4" \/><\/svg>/);
  assert.doesNotMatch(source, /[⌄▾▼]/);
  assert.match(css, /\.menu > summary \.chevron\s*\{[^}]*display:\s*block[^}]*flex:\s*0 0 14px[^}]*width:\s*14px[^}]*height:\s*14px[^}]*fill:\s*none[^}]*stroke:\s*currentColor[^}]*stroke-width:\s*1\.8[^}]*stroke-linecap:\s*round[^}]*stroke-linejoin:\s*round/);
  assert.match(css, /\.menu\[open\] > summary \.chevron\s*\{[^}]*transform:\s*rotate\(180deg\)/);
});

test('compact scope retains the exact request contract and exposes a text-free summary', () => {
  assert.match(source, /window\.argusNexusRepositoryIds = selected/);
  assert.match(source, /target\.dataset\.selectedRepositoryCount = String\(selected\.length\)/);
  assert.match(source, /target\.dataset\.repositoryScopeLabel = selected\.length/);
  assert.match(source, /const MAX_REPOSITORIES = 6/);
  assert.match(source, /current\.includes\(repositoryId\)[\s\S]*?current\.filter[\s\S]*?current\.length >= MAX_REPOSITORIES[\s\S]*?\[\.\.\.current, repositoryId\]/);
  assert.match(source, /Only selected repositories are sent; Auto uses all connected repositories/);
  assert.match(source, /onClick=\{\(\) => setSelected\(\[\]\)\}>Use Auto/);
});

test('failed scope refresh keeps the current repository selection and offers retry', () => {
  const failure = source.match(/\} catch \{([\s\S]*?)\} finally/)?.[1] || '';
  assert.doesNotMatch(failure, /setRepositories|setSelected/);
  assert.match(failure, /setError\("Could not refresh repositories\. Your selection is unchanged/);
  assert.match(source, /role="status"[\s\S]*?onClick=\{loadRepositories\}>Retry/);
  assert.match(source, /!loading && !error && !repositories\.length/);
});
