import { BROWSER_BUFFER_PROVISION, BROWSER_SHIM_FILES } from "./src/shims/browser-shim-files.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
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
      config.resolve.fallback = { ...config.resolve.fallback, buffer: "buffer" };
      // The SDK's pure verify chain imports node:crypto, node:util and, for the
      // ClaimReference parser (CORE B.1 CF-2) `domain:` hostname check,
      // node:net and node:url. Swap in the shims (@noble for crypto, the
      // WHATWG subset for net/url) so the SAME verification code runs in the
      // browser (verify-only).
      for (const [specifier, shimFile] of Object.entries(BROWSER_SHIM_FILES)) {
        config.plugins.push(
          new webpack.NormalModuleReplacementPlugin(new RegExp(`^${specifier}$`), (resource) => {
            resource.request = new URL(`./src/shims/${shimFile}`, import.meta.url).pathname;
          }),
        );
      }
      config.plugins.push(
        new webpack.ProvidePlugin({ Buffer: [...BROWSER_BUFFER_PROVISION] }),
      );
    }
    return config;
  },
};
export default nextConfig;
