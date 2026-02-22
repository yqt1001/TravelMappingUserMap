import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const sourceRoot = await resolveSourceRoot(args.src);
const outputRoutesRoot = path.resolve(projectRoot, args.outRoutes || "data/routes");
const outputIndexRoot = path.resolve(projectRoot, args.outIndex || "data/route-index");
const regionFilter = parseRegionFilter(args.regions);

console.log(`Source: ${path.relative(projectRoot, sourceRoot) || "."}`);
console.log(`Output routes: ${path.relative(projectRoot, outputRoutesRoot)}`);
console.log(`Output indexes: ${path.relative(projectRoot, outputIndexRoot)}`);
if (regionFilter) {
  console.log(`Region filter: ${Array.from(regionFilter).join(", ")}`);
}

await fs.rm(outputRoutesRoot, { recursive: true, force: true });
await fs.rm(outputIndexRoot, { recursive: true, force: true });
await fs.mkdir(outputRoutesRoot, { recursive: true });
await fs.mkdir(outputIndexRoot, { recursive: true });

const wptFiles = await listWptFiles(sourceRoot);
const regionIndexes = new Map();
const routeTokenIndex = new Map();
let parsedCount = 0;
let skippedCount = 0;

for (const relFile of wptFiles) {
  const relPosix = toPosix(relFile);
  const parsed = await parseWptFile(sourceRoot, relPosix);
  if (!parsed) {
    skippedCount += 1;
    continue;
  }
  if (regionFilter && !regionFilter.has(parsed.region)) {
    continue;
  }

  const routeOutputRel = `${parsed.region}/${parsed.system}/${parsed.fileStem}.json`;
  const routeOutputAbs = path.join(outputRoutesRoot, ...routeOutputRel.split("/"));
  await fs.mkdir(path.dirname(routeOutputAbs), { recursive: true });
  await fs.writeFile(routeOutputAbs, JSON.stringify(parsed.routeData));

  if (!regionIndexes.has(parsed.region)) {
    regionIndexes.set(parsed.region, { v: 1, region: parsed.region, routes: {} });
  }
  const regionIndex = regionIndexes.get(parsed.region);
  if (!Array.isArray(regionIndex.routes[parsed.routeKey])) {
    regionIndex.routes[parsed.routeKey] = [];
  }
  regionIndex.routes[parsed.routeKey].push(routeOutputRel);

  const normalizedToken = normalizeRoute(parsed.routeData.rt);
  if (normalizedToken) {
    if (!routeTokenIndex.has(normalizedToken)) {
      routeTokenIndex.set(normalizedToken, []);
    }
    routeTokenIndex.get(normalizedToken).push(routeOutputRel);
  }
  parsedCount += 1;
}

for (const [region, indexBody] of regionIndexes.entries()) {
  const outFile = path.join(outputIndexRoot, `${region}.json`);
  await fs.writeFile(outFile, JSON.stringify(indexBody));
}

const tokenIndexBody = { v: 1, tokens: {} };
for (const [token, paths] of routeTokenIndex.entries()) {
  tokenIndexBody.tokens[token] = Array.from(new Set(paths));
}
await fs.writeFile(
  path.join(outputIndexRoot, "route-token-index.json"),
  JSON.stringify(tokenIndexBody)
);

console.log(`Parsed route files: ${parsedCount}`);
console.log(`Skipped invalid .wpt files: ${skippedCount}`);
console.log(`Generated region indexes: ${regionIndexes.size}`);
console.log(`Generated route token index entries: ${routeTokenIndex.size}`);

async function resolveSourceRoot(explicitSrc) {
  if (explicitSrc) {
    const explicitAbs = path.resolve(projectRoot, explicitSrc);
    if (!(await isDirectory(explicitAbs))) {
      throw new Error(`Source directory not found: ${explicitSrc}`);
    }
    return explicitAbs;
  }

  const candidates = ["data/hwy-data", "data/hwy_data"];
  for (const candidate of candidates) {
    const abs = path.resolve(projectRoot, candidate);
    if (await isDirectory(abs)) {
      return abs;
    }
  }

  throw new Error(
    "Could not find source highway data directory. Looked for data/hwy-data and data/hwy_data."
  );
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq < 0) {
      out[arg.slice(2)] = "true";
      continue;
    }
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function parseRegionFilter(value) {
  if (!value) {
    return null;
  }
  const regions = value
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  if (!regions.length) {
    return null;
  }
  return new Set(regions);
}

async function listWptFiles(sourceRootDir) {
  const out = [];
  const queue = [sourceRootDir];

  while (queue.length) {
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wpt")) {
        out.push(path.relative(sourceRootDir, full));
      }
    }
  }

  return out;
}

async function parseWptFile(sourceRootDir, relPath) {
  const absPath = path.resolve(sourceRootDir, relPath);
  const text = await fs.readFile(absPath, "utf8");
  const parts = relPath.split("/");
  const baseName = parts[parts.length - 1];
  const fileStem = baseName.slice(0, -4);
  const dotIdx = fileStem.indexOf(".");
  if (dotIdx <= 0 || dotIdx === fileStem.length - 1) {
    return null;
  }

  const region = normalizeRegion(fileStem.slice(0, dotIdx));
  const routeToken = fileStem.slice(dotIdx + 1);
  const system = parts.length >= 2 ? parts[parts.length - 2] : "unknown";
  const routeKey = makeRouteKey(region, routeToken);

  const pt = [];
  const lb = [];

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }
    const tokens = raw.split(/\s+/);
    const urlIndex = tokens.findIndex((token) => token.startsWith("http"));
    if (urlIndex <= 0) {
      continue;
    }
    const labels = tokens.slice(0, urlIndex);
    const coords = parseLatLon(tokens[urlIndex]);
    if (!coords) {
      continue;
    }
    pt.push([roundCoord(coords.lat), roundCoord(coords.lon)]);
    lb.push(labels);
  }

  if (pt.length < 2) {
    return null;
  }

  return {
    region,
    system,
    fileStem,
    routeKey,
    routeData: {
      v: 1,
      src: `hwy_data/${relPath}`,
      sys: system,
      rg: region,
      rt: routeToken,
      pt,
      lb,
    },
  };
}

function parseLatLon(url) {
  try {
    const parsed = new URL(url);
    const lat = Number(parsed.searchParams.get("lat"));
    const lon = Number(parsed.searchParams.get("lon"));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon };
    }
    return null;
  } catch (_error) {
    const latMatch = url.match(/lat=([-0-9.]+)/i);
    const lonMatch = url.match(/lon=([-0-9.]+)/i);
    if (!latMatch || !lonMatch) {
      return null;
    }
    const lat = Number(latMatch[1]);
    const lon = Number(lonMatch[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon };
    }
    return null;
  }
}

function makeRouteKey(region, routeToken) {
  return `${normalizeRegion(region)}|${normalizeRoute(routeToken)}`;
}

function normalizeRegion(regionToken) {
  return String(regionToken || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeRoute(routeToken) {
  let value = String(routeToken || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  value = value.replace(/\d+/g, (digits) => String(Number(digits)));
  return value;
}

function roundCoord(value) {
  return Number(value.toFixed(6));
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

async function isDirectory(absPath) {
  try {
    const stat = await fs.stat(absPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
