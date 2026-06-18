/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.VERCEL ? "export" : "standalone",
  trailingSlash: true,
  experimental: {
    outputFileTracingExcludes: {
      "*": ["./database-archive/**"],
    },
  },
};

export default nextConfig;
