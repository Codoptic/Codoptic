/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '32mb' },
    serverComponentsExternalPackages: ['@lydell/node-pty'],
  },
  webpack: (config, { isServer }) => {
    // Inline .txt assets (DSL examples, test fixtures)
    config.module.rules.push({
      test: /\.txt$/i,
      type: 'asset/source',
    });

    // @hpcc-js/wasm-graphviz ships a pre-bundled ESM file that embeds its own
    // WASM binary as a base64 data URI. We mark it as external on the server
    // side so Next.js doesn't try to parse its non-standard ESM syntax during
    // SSR, and rely on dynamic import() from the client bundle only.
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }

    return config;
  },
};

export default nextConfig;
