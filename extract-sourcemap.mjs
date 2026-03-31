#!/usr/bin/env node

/**
 * Extract original source code from a JavaScript source map file.
 *
 * Usage:
 *   node extract-sourcemap.mjs <path-to-.map-file> [output-dir]
 *
 * Example:
 *   node extract-sourcemap.mjs cli.js.map ./src-extracted
 *
 * The script reads the .map file (standard v3 source map JSON),
 * iterates over `sources` and `sourcesContent`, skips node_modules,
 * and writes each original source file to the output directory.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, basename } from "path";

const mapFile = process.argv[2];
const outDir = process.argv[3] || "./src-extracted";

if (!mapFile) {
  console.error("Usage: node extract-sourcemap.mjs <source-map-file> [output-dir]");
  process.exit(1);
}

console.log(`Parsing ${mapFile} ...`);
const map = JSON.parse(readFileSync(mapFile, "utf8"));

if (!map.sources || !map.sourcesContent) {
  console.error("Error: .map file missing sources or sourcesContent.");
  process.exit(1);
}

console.log(`Found ${map.sources.length} sources, ${map.sourcesContent.length} sourcesContent entries.`);

let written = 0;
let skipped = 0;

for (let i = 0; i < map.sources.length; i++) {
  const src = map.sources[i];
  const content = map.sourcesContent[i];

  // Skip node_modules
  if (src.includes("node_modules")) {
    skipped++;
    continue;
  }

  // Skip if no content
  if (content == null) {
    skipped++;
    continue;
  }

  // Resolve path: strip leading ../ so files land inside outDir
  const cleaned = src.replace(/^(\.\.\/)+(\.\/)?/, "");
  const outPath = resolve(outDir, cleaned);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
  written++;
}

console.log(`Done. Wrote ${written} files to ${outDir} (skipped ${skipped}).`);