/** The code of pdf.js's worker, as text (embedded in index.html by the build: see scripts/build.mjs). */
declare module 'pdfjs-worker-code' {
  const code: string;
  export default code;
}

/** Images, embedded in index.html as data: URLs (see scripts/build.mjs). */
declare module "*.png" {
  const url: string;
  export default url;
}

/** WebAssembly modules, embedded in index.html as bytes (see scripts/build.mjs). */
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
