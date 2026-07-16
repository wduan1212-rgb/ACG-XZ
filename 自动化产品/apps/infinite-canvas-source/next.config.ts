import type { NextConfig } from "next";

const isGithubPages = process.env.GITHUB_PAGES === "1";

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
};

export default nextConfig;
