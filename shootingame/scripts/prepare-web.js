const fs = require("fs");
const path = require("path");

const root = process.cwd();
const src = path.join(root, "Jujufighter.html");
const outDir = path.join(root, "www");
const outFile = path.join(outDir, "index.html");

if (!fs.existsSync(src)) {
  throw new Error(`Source file not found: ${src}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, outFile);
console.log(`Prepared web assets: ${outFile}`);
