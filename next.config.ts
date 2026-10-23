import type { NextConfig } from 'next';
import { networkInterfaces } from 'node:os';

/**
 * Dev server only: Next blocks its dev scripts for origins other than localhost,
 * so opening the app via this machine's network address (as `next dev` prints)
 * rendered pages without JavaScript. Allow this machine's own IPv4 addresses.
 */
const ownAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i!.address);

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ownAddresses,
  // pg and pg-boss are Node-only; keep them out of the bundler.
  serverExternalPackages: ['pg', 'pg-boss'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
