import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * The wasm decompress modules (@foxglove/wasm-zstd etc.) locate their .wasm
 * next to the bundle via `__dirname + "/<name>.wasm"`, so the files must be
 * emitted unhashed into the output directory: loader "file" + assetNames
 * "[name]". Validated by `npm run smoke` against a real compressed file.
 */
/** @type {import("esbuild").BuildOptions} */
const extensionConfig = {
  entryPoints: { extension: "src/extension/extension.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  loader: { ".wasm": "file" },
  assetNames: "[name]",
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const webviewConfig = {
  entryPoints: { webview: "src/webview/main.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
