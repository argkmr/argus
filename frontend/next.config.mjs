import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
  trailingSlash: false,
  turbopack: { root: repositoryRoot },
  compiler: { removeConsole: { exclude: ["error"] } },
};

export default nextConfig;
