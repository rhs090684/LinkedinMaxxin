/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No ESLint config is shipped; don't let a lint step fail the Vercel build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
