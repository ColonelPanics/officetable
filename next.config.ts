import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only CSRF guard: Next blocks client fetches from any host it doesn't
  // recognise, which locks the office machines out when they open localhost
  // by IP. Allow the office network range (restart `npm run dev` to apply).
  allowedDevOrigins: ['10.150.0.76', '10.150.*.*'],
};

export default nextConfig;
