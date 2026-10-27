import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Excalidraw's font loader must never fall back to its public CDN.
const source = path.join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const destination = path.join(root, 'public/assets/excalidraw/fonts');
await fs.mkdir(destination, { recursive: true });
await fs.cp(source, destination, { recursive: true });

// Ship the complete dependency/font notices beside the locally served assets.
const licenseSource = path.join(root, 'docs/third-party/diagram-studio');
const licenseDestination = path.join(root, 'public/assets/excalidraw/licenses');
await fs.mkdir(licenseDestination, { recursive: true });
await fs.cp(licenseSource, licenseDestination, { recursive: true });
