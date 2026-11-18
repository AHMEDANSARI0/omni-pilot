/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is a static export served by the Cloudflare Worker next to /api/v1.
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },

  // Development only: proxy /api to the local Hono server so the browser sees one origin.
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const target = process.env.LOCAL_API_URL ?? 'http://127.0.0.1:8787';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;
