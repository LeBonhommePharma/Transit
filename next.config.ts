import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    return [{ source: "/Transit", destination: "/Transit/index.html" }];
  },
};

export default nextConfig;
