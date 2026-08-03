import type { NextConfig } from "next";
import path from "node:path";

const isGithubPages = process.env.GITHUB_PAGES === "1";
const clientProviderEnabled = process.env.NEXT_PUBLIC_CLIENT_PROVIDER === "1";

const nextConfig: NextConfig = {
  // Hide the floating dev-tools indicator (the "N / 1 Issue" badge).
  devIndicators: false,
  ...(isGithubPages
    ? {
        output: "export" as const,
        basePath: "/XZ-Design",
        images: { unoptimized: true },
      }
    : {}),
  webpack(config, { webpack: webpackRuntime }) {
    if (!clientProviderEnabled) {
      config.plugins.push(
        new webpackRuntime.NormalModuleReplacementPlugin(
          /clientImageApi$/,
          path.resolve(process.cwd(), "src/lib/clientImageApi.disabled.ts"),
        ),
        new webpackRuntime.NormalModuleReplacementPlugin(
          /clientKeys$/,
          path.resolve(process.cwd(), "src/lib/clientKeys.disabled.ts"),
        ),
      );
    }
    return config;
  },
};

export default nextConfig;
