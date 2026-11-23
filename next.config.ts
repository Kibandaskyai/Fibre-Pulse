import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Customer CSV imports send up to 2 MB through a server action
    // (the file once when checked, then its text once when confirmed).
    serverActions: { bodySizeLimit: "3mb" },
  },
};

export default nextConfig;
