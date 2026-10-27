import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const logoPath = path.join(projectRoot, "public", "assets", "argus-logo.svg");
const iconsetPath = path.join(projectRoot, "build", "Argus.iconset");
const iconPath = path.join(projectRoot, "build", "icon.png");
const extensionPath = path.join(projectRoot, "chrome-extension");
const extensionIconPath = path.join(extensionPath, "icons");

const iconFiles = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

const glyph = await sharp(logoPath, { density: 768 })
  .trim()
  .resize({ width: 720, height: 560, fit: "inside", withoutEnlargement: false })
  .png()
  .toBuffer();
const background = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <defs><linearGradient id="surface" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#171c20"/><stop offset="1" stop-color="#090c0f"/></linearGradient></defs>
    <rect x="34" y="34" width="956" height="956" rx="220" fill="url(#surface)" stroke="#526129" stroke-width="16"/>
  </svg>
`);
const master = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "transparent" } })
  .composite([{ input: background }, { input: glyph, gravity: "center" }])
  .png()
  .toBuffer();

await fs.mkdir(iconsetPath, { recursive: true });
await Promise.all(iconFiles.map(async ([filename, size]) => {
  const output = await sharp(master).resize(size, size).png().toBuffer();
  await fs.writeFile(path.join(iconsetPath, filename), output);
}));
await fs.writeFile(iconPath, master);

await fs.mkdir(extensionIconPath, { recursive: true });
await Promise.all([16, 32, 48, 128].map(async (size) => {
  const output = await sharp(master).resize(size, size).png().toBuffer();
  await fs.writeFile(path.join(extensionIconPath, `icon${size}.png`), output);
}));
await fs.writeFile(path.join(extensionPath, "argus-logo.png"), await sharp(master).resize(256, 256).png().toBuffer());

console.log(`Created ${iconPath} and synchronized Chrome extension icons`);
