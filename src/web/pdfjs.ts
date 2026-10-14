/**
 * pdf.js in the browser page (index.html), with its worker embedded in the page. A page opened
 * from disk (file://) cannot start a module worker from a blob, only a classic one: the worker's
 * code (an ES module) is started as a classic script, without its final `export` and with
 * `import.meta.url` (only used to find optional image decoders) replaced by the page's address.
 *
 * Nor can pdf.js fetch its data files from there: its image decoders for JBIG2 and JPEG 2000
 * (WebAssembly, for scanned-looking figures in older papers) are embedded too, and given to it
 * from the page (see openPdf). Its standard fonts and character maps are not (2.5 MB): fonts
 * not embedded in a PDF are shown with the computer's own, as Chrome does.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerCode from 'pdfjs-worker-code';
import jbig2Wasm from 'pdfjs-dist/wasm/jbig2.wasm';
import openjpegWasm from 'pdfjs-dist/wasm/openjpeg.wasm';

/** The worker's code, runnable as a classic script. */
export function classicWorkerCode(code: string, base: string): string {
  return code.replace(/export\s*\{[^}]*\}\s*;?\s*(\/\/[^\n]*\s*)*$/, '').replaceAll('import.meta.url', JSON.stringify(base));
}

let started = false;

/** pdf.js's data files, from the page (see BinaryDataFactory in pdf.js). */
const EMBEDDED: Record<string, Uint8Array> = { 'jbig2.wasm': jbig2Wasm, 'openjpeg.wasm': openjpegWasm };
class EmbeddedData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const data = kind === 'wasmUrl' ? EMBEDDED[filename] : undefined;
    if (!data) throw new Error(`${filename} is not in this page`);
    return data.slice(); // (a copy: it is sent to the worker)
  }
}

/** Open a PDF (always with this: it gives pdf.js its embedded decoders). */
export function openPdf(data: Uint8Array) {
  return pdfjsLib().getDocument({
    data,
    BinaryDataFactory: EmbeddedData as unknown as never,
    useWorkerFetch: false,
    wasmUrl: 'embedded:/', // (unused: the decoders come from EmbeddedData; pdf.js wants a trailing slash)
  } as Parameters<typeof pdfjs.getDocument>[0]);
}

export function pdfjsLib(): typeof pdfjs {
  if (!started) {
    started = true;
    const url = URL.createObjectURL(new Blob([classicWorkerCode(workerCode, location.href)], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url);
  }
  return pdfjs;
}
