/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value: '</.well-known/dacs.json>; rel="service-desc"; type="application/vnd.dacs.market+json"',
          },
          { key: "DACS-Version", value: "1" },
        ],
      },
    ];
  },
  // Only the vendored SDK's pure canonical/crypto/verify modules are bundled;
  // the substrate client and its multichain tree are not application deps.
  // The same verification code runs in-browser and needs Buffer/node:crypto
  // compatibility shims.
  webpack: (config, { isServer, webpack }) => {
    // src/catalog is shared with the tsx CLI (npm run index), which uses
    // NodeNext-style `./x.js` relative imports; teach webpack to fall back
    // to the .ts source when the .js file doesn't exist.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".js", ".ts", ".tsx"],
    };
    if (!isServer) {
      // Force the app and vendored SDK to share one Buffer instance. Without
      // this alias webpack resolves the SDK's nested copy separately, so the
      // base64url compatibility patch cannot affect SDK module constants.
      const browserBuffer = new URL("./node_modules/buffer/index.js", import.meta.url).pathname;
      config.resolve.alias = { ...config.resolve.alias, buffer: browserBuffer };
      config.resolve.fallback = { ...config.resolve.fallback, buffer: browserBuffer };
      // The SDK's pure verify chain imports node:crypto — swap in the @noble
      // shim so the SAME verification code runs in the browser (verify-only).
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:crypto$/, (resource) => {
          resource.request = new URL("./src/shims/node-crypto.ts", import.meta.url).pathname;
        }),
      );
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:util$/, (resource) => {
          resource.request = new URL("./src/shims/node-util.ts", import.meta.url).pathname;
        }),
      );
      config.plugins.push(
        new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
      );
    }
    return config;
  },
};
export default nextConfig;
