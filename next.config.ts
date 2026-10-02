import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/webhook": ["./public/menus/george.png", "./public/menus/george.png.b64"],
  },
};

export default nextConfig;
