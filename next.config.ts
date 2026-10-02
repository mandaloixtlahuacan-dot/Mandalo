import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/webhook": ["./public/menus/**/*"],
  },
};

export default nextConfig;
