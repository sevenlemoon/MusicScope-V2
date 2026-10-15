import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.music.126.net", pathname: "/**" },
      { protocol: "http", hostname: "**.music.126.net", pathname: "/**" },
    ],
  },
};

export default nextConfig;
