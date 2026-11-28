// Puts the OCR engine (Tesseract, as WebAssembly) and its English and
// Japanese language files into public/ocr, so the built app reads text on
// comic pages with nothing fetched from the internet. Run before vite build.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const out = "public/ocr";
const nm = "node_modules";
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

const worker = join(nm, "tesseract.js/dist/worker.min.js");
if (!existsSync(worker)) {
  console.warn("copy-ocr: tesseract.js is not installed; the OCR translator will be unavailable.");
  process.exit(0);
}
cpSync(worker, join(out, "worker.min.js"));

// The LSTM builds of the engine (with and without SIMD); FicShelf only uses
// the LSTM recogniser.
const core = [join(nm, "tesseract.js-core"), join(nm, "tesseract.js/node_modules/tesseract.js-core")].find(existsSync);
let n = 0;
for (const f of readdirSync(core)) {
  if (/^tesseract-core.*lstm.*\.(js|wasm)$/.test(f)) {
    cpSync(join(core, f), join(out, "core", f));
    n++;
  }
}
console.log(`copy-ocr: ${n} engine files`);

function find(dir, name) {
  const hits = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === name) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  // The integer "best" models are the ones tesseract.js uses for LSTM.
  hits.sort((a, b) => Number(b.includes("best_int")) - Number(a.includes("best_int")));
  return hits[0];
}

for (const lang of ["eng", "jpn", "jpn_vert"]) {
  const file = find(join(nm, "@tesseract.js-data", lang), `${lang}.traineddata.gz`);
  if (file) {
    cpSync(file, join(out, "lang", `${lang}.traineddata.gz`));
    console.log(`copy-ocr: ${lang} from ${file}`);
  } else {
    console.warn(`copy-ocr: no ${lang} language data; that language will be unavailable.`);
  }
}
