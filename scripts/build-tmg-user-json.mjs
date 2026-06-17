import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const username = String(args.user || "").trim();
if (!username) {
  throw new Error("Missing required --user=<username> argument.");
}

const sourceFile = path.resolve(projectRoot, args.src || "data/tm-master-traveled.tmg");
const outputDir = path.resolve(projectRoot, args.outDir || "data/tmg-users");
const outputFile = path.join(outputDir, `${username}.json`);
const quantizeScale = parseQuantizeScale(args.q);
const skipIfPathCountSame = parseBool(args.skipIfPathCountSame, false);
const maxAgeDays = parseMaxAgeDays(args.maxAgeDays);

console.log(`TMG source: ${path.relative(projectRoot, sourceFile)}`);
console.log(`Target user: ${username}`);
console.log(`Quantize scale: ${quantizeScale}`);
console.log(`Skip if path count same: ${skipIfPathCountSame ? "yes" : "no"}`);
console.log(`Max age days for skip check: ${maxAgeDays}`);

const meta = await scanMetaAndTraveler(sourceFile, username);
if (!meta.userFound) {
  const firstFew = meta.travelers.slice(0, 12).join(", ");
  throw new Error(
    `User "${username}" not found in traveler list (${meta.travelerCount} users). ` +
      `Sample users: ${firstFew}`
  );
}

console.log(`Traveler index: ${meta.userIndex} (of ${meta.travelerCount})`);
console.log(`Vertices: ${meta.vertexCount}`);
console.log(`Edges: ${meta.edgeCount}`);

const built = await buildCompactUserGeometry(
  sourceFile,
  meta.userIndex,
  meta.vertexCount,
  meta.edgeCount,
  quantizeScale
);

const payload = {
  v: 2,
  fmt: "tmg-user-compact",
  user: username,
  travelerIndex: meta.userIndex,
  q: quantizeScale,
  generated: new Date().toISOString(),
  paths: built.paths,
  stats: built.stats,
};

const existingPayload = await readExistingJson(outputFile);
if (isSameGeneratedData(existingPayload, payload)) {
  console.log("Skipped write: generated data is unchanged.");
  console.log("RESULT_STATUS: skipped_unchanged_data");
  process.exit(0);
}

let refreshedDueToStale = false;
if (skipIfPathCountSame) {
  const existing = existingPayload;
  const stale = isStale(existing ? existing.generated : "", maxAgeDays);
  if (
    existing &&
    Number(existing.v) === 2 &&
    String(existing.fmt || "") === "tmg-user-compact" &&
    String(existing.user || "") === username &&
    Number(existing.q) === quantizeScale &&
    Array.isArray(existing.paths) &&
    existing.paths.length === payload.paths.length &&
    !stale
  ) {
    console.log(
      `Skipped write: same path count (${existing.paths.length}) and file is not stale.`
    );
    console.log("RESULT_STATUS: skipped_fresh_path_count");
    process.exit(0);
  }
  if (
    existing &&
    Number(existing.v) === 2 &&
    String(existing.fmt || "") === "tmg-user-compact" &&
    String(existing.user || "") === username &&
    Number(existing.q) === quantizeScale &&
    Array.isArray(existing.paths) &&
    existing.paths.length === payload.paths.length &&
    stale
  ) {
    console.log(
      `Path count matches (${existing.paths.length}) but file is stale; refreshing output.`
    );
    refreshedDueToStale = true;
  }
}

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputFile, stringifyUserPayload(payload));

console.log(`Wrote: ${path.relative(projectRoot, outputFile)}`);
console.log(`Raw traveled edges: ${built.stats.rawEdgeCount}`);
console.log(`Merged paths: ${built.stats.mergedPathCount}`);
console.log(`Output quantized points: ${built.stats.quantizedPointCount}`);
if (refreshedDueToStale) {
  console.log("RESULT_STATUS: written_stale_refresh");
} else {
  console.log("RESULT_STATUS: written");
}

async function scanMetaAndTraveler(tmgPath, usernameToFind) {
  const stream = createReadStream(tmgPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  let formatLine = "";
  let vertexCount = 0;
  let edgeCount = 0;
  let travelerCount = 0;
  let travelerLineNumber = 0;
  let travelers = [];

  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber === 1) {
      formatLine = line.trim();
      continue;
    }
    if (lineNumber === 2) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        throw new Error(`Invalid TMG counts line: "${line}"`);
      }
      vertexCount = Number(parts[0]);
      edgeCount = Number(parts[1]);
      travelerCount = Number(parts[2]);
      if (
        !Number.isInteger(vertexCount) ||
        !Number.isInteger(edgeCount) ||
        !Number.isInteger(travelerCount)
      ) {
        throw new Error(`Invalid numeric counts in line 2: "${line}"`);
      }
      travelerLineNumber = 3 + vertexCount + edgeCount;
      continue;
    }

    if (lineNumber === travelerLineNumber) {
      travelers = line
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      rl.close();
      break;
    }
  }

  if (!formatLine.startsWith("TMG ")) {
    throw new Error(`Unsupported file header: "${formatLine}"`);
  }
  if (!travelers.length) {
    throw new Error("Could not read traveler usernames line from TMG file.");
  }

  const lower = usernameToFind.toLowerCase();
  const userIndex = travelers.findIndex((name) => String(name).toLowerCase() === lower);
  return {
    vertexCount,
    edgeCount,
    travelerCount,
    travelers,
    userFound: userIndex >= 0,
    userIndex,
  };
}

async function buildCompactUserGeometry(tmgPath, userIndex, vertexCount, edgeCount, quantizeScaleArg) {
  const vertexLats = new Float64Array(vertexCount);
  const vertexLons = new Float64Array(vertexCount);
  const edges = [];

  let lineNumber = 0;
  const firstVertexLine = 3;
  const lastVertexLine = 2 + vertexCount;
  const firstEdgeLine = 3 + vertexCount;
  const lastEdgeLine = 2 + vertexCount + edgeCount;
  const stream = createReadStream(tmgPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let rawEdgeCount = 0;
  let shapingPointCount = 0;

  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber < firstVertexLine) {
      continue;
    }

    if (lineNumber <= lastVertexLine) {
      const idx = lineNumber - firstVertexLine;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      const lat = Number(parts[1]);
      const lon = Number(parts[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      vertexLats[idx] = lat;
      vertexLons[idx] = lon;
      continue;
    }

    if (lineNumber < firstEdgeLine || lineNumber > lastEdgeLine) {
      if (lineNumber > lastEdgeLine) {
        break;
      }
      continue;
    }

    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const v1 = Number(parts[0]);
    const v2 = Number(parts[1]);
    const travelerHex = parts[3];
    if (!Number.isInteger(v1) || !Number.isInteger(v2)) {
      continue;
    }
    if (!isTravelerBitSet(travelerHex, userIndex)) {
      continue;
    }

    const startLat = vertexLats[v1];
    const startLon = vertexLons[v1];
    const endLat = vertexLats[v2];
    const endLon = vertexLons[v2];
    if (
      !Number.isFinite(startLat) ||
      !Number.isFinite(startLon) ||
      !Number.isFinite(endLat) ||
      !Number.isFinite(endLon)
    ) {
      continue;
    }

    const coords = [[startLat, startLon]];
    for (let i = 4; i + 1 < parts.length; i += 2) {
      const lat = Number(parts[i]);
      const lon = Number(parts[i + 1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      coords.push([lat, lon]);
      shapingPointCount += 1;
    }
    coords.push([endLat, endLon]);

    edges.push({ v1, v2, coords });
    rawEdgeCount += 1;
  }

  const mergedPolylines = mergeTraveledEdges(edges, vertexCount);
  const quantizedPaths = [];
  let quantizedPointCount = 0;
  for (const polyline of mergedPolylines) {
    const quantized = quantizePolyline(polyline, quantizeScaleArg);
    if (quantized.length < 4) {
      continue;
    }
    quantizedPaths.push(quantized);
    quantizedPointCount += quantized.length / 2;
  }

  return {
    paths: quantizedPaths,
    stats: {
      rawEdgeCount,
      mergedPathCount: quantizedPaths.length,
      shapingPointCount,
      quantizedPointCount,
    },
  };
}

function mergeTraveledEdges(edges, vertexCount) {
  const adjacency = Array.from({ length: vertexCount }, () => []);
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    adjacency[e.v1].push(i);
    adjacency[e.v2].push(i);
  }

  const degrees = adjacency.map((list) => list.length);
  const used = new Uint8Array(edges.length);
  const out = [];

  for (let v = 0; v < vertexCount; v += 1) {
    if (degrees[v] === 2 || degrees[v] === 0) {
      continue;
    }
    for (const edgeIndex of adjacency[v]) {
      if (used[edgeIndex]) {
        continue;
      }
      const merged = walkPath(v, edgeIndex, edges, adjacency, degrees, used);
      if (merged && merged.length >= 2) {
        out.push(merged);
      }
    }
  }

  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (used[edgeIndex]) {
      continue;
    }
    const edge = edges[edgeIndex];
    const merged = walkCycle(edge.v1, edgeIndex, edges, adjacency, used);
    if (merged && merged.length >= 2) {
      out.push(merged);
    }
  }

  return out;
}

function walkPath(startVertex, firstEdgeIndex, edges, adjacency, degrees, used) {
  let currentVertex = startVertex;
  let currentEdgeIndex = firstEdgeIndex;
  const line = [];
  let safety = 0;

  while (true) {
    if (used[currentEdgeIndex]) {
      break;
    }
    used[currentEdgeIndex] = 1;
    const edge = edges[currentEdgeIndex];
    const nextVertex = edge.v1 === currentVertex ? edge.v2 : edge.v1;
    const oriented = orientCoords(edge.coords, currentVertex === edge.v1);
    appendCoords(line, oriented);
    currentVertex = nextVertex;
    safety += 1;
    if (safety > edges.length + 5) {
      break;
    }
    if (degrees[currentVertex] !== 2) {
      break;
    }
    const nextEdgeIndex = findNextUnusedEdge(adjacency[currentVertex], used);
    if (nextEdgeIndex < 0) {
      break;
    }
    currentEdgeIndex = nextEdgeIndex;
  }

  return line;
}

function walkCycle(startVertex, firstEdgeIndex, edges, adjacency, used) {
  let currentVertex = startVertex;
  let currentEdgeIndex = firstEdgeIndex;
  const line = [];
  let safety = 0;

  while (true) {
    if (used[currentEdgeIndex]) {
      break;
    }
    used[currentEdgeIndex] = 1;
    const edge = edges[currentEdgeIndex];
    const nextVertex = edge.v1 === currentVertex ? edge.v2 : edge.v1;
    const oriented = orientCoords(edge.coords, currentVertex === edge.v1);
    appendCoords(line, oriented);
    currentVertex = nextVertex;
    safety += 1;
    if (safety > edges.length + 5) {
      break;
    }
    const nextEdgeIndex = findNextUnusedEdge(adjacency[currentVertex], used);
    if (nextEdgeIndex < 0) {
      break;
    }
    currentEdgeIndex = nextEdgeIndex;
    if (currentVertex === startVertex && currentEdgeIndex === firstEdgeIndex) {
      break;
    }
  }

  return line;
}

function findNextUnusedEdge(edgeIndexes, used) {
  for (const idx of edgeIndexes) {
    if (!used[idx]) {
      return idx;
    }
  }
  return -1;
}

function orientCoords(coords, forward) {
  return forward ? coords : coords.slice().reverse();
}

function appendCoords(target, source) {
  if (!source.length) {
    return;
  }
  if (!target.length) {
    target.push(...source);
    return;
  }
  const last = target[target.length - 1];
  const first = source[0];
  if (samePoint(last, first)) {
    target.push(...source.slice(1));
    return;
  }
  target.push(...source);
}

function samePoint(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
    return false;
  }
  return a[0] === b[0] && a[1] === b[1];
}

function quantizePolyline(polyline, scale) {
  const flat = [];
  let prevLat = null;
  let prevLon = null;
  for (const pair of polyline) {
    if (!Array.isArray(pair) || pair.length < 2) {
      continue;
    }
    const lat = Number(pair[0]);
    const lon = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    const qLat = Math.round(lat * scale);
    const qLon = Math.round(lon * scale);
    if (qLat === prevLat && qLon === prevLon) {
      continue;
    }
    flat.push(qLat, qLon);
    prevLat = qLat;
    prevLon = qLon;
  }
  return flat;
}

function isTravelerBitSet(hexString, travelerIndex) {
  if (travelerIndex < 0) {
    return false;
  }
  const nibbleIndex = Math.floor(travelerIndex / 4);
  const bitOffset = travelerIndex % 4;
  if (nibbleIndex >= hexString.length) {
    return false;
  }
  const nibble = Number.parseInt(hexString[nibbleIndex], 16);
  if (!Number.isFinite(nibble)) {
    return false;
  }
  return (nibble & (1 << bitOffset)) !== 0;
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

function parseQuantizeScale(value) {
  if (!value) {
    return 100000;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(`Invalid --q value: ${value}`);
  }
  return parsed;
}

function parseMaxAgeDays(value) {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --maxAgeDays value: ${value}`);
  }
  return parsed;
}

async function readExistingJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isStale(generatedValue, maxAgeDaysArg) {
  const text = String(generatedValue || "").trim();
  if (!text) {
    return true;
  }
  const generatedMs = Date.parse(text);
  if (!Number.isFinite(generatedMs)) {
    return true;
  }
  const maxAgeMs = maxAgeDaysArg * 24 * 60 * 60 * 1000;
  return Date.now() - generatedMs > maxAgeMs;
}

function isSameGeneratedData(existing, next) {
  if (!existing || typeof existing !== "object") {
    return false;
  }
  return JSON.stringify(comparablePayload(existing)) === JSON.stringify(comparablePayload(next));
}

function comparablePayload(payload) {
  return {
    v: Number(payload.v),
    fmt: String(payload.fmt || ""),
    user: String(payload.user || ""),
    travelerIndex: Number(payload.travelerIndex),
    q: Number(payload.q),
    paths: Array.isArray(payload.paths) ? payload.paths : [],
    stats: payload.stats || {},
  };
}

function parseBool(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(text)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function stringifyUserPayload(payload) {
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  const pathLines = paths.map((pathEntry) => JSON.stringify(pathEntry)).join(",\n");

  const out =
    `{` +
    `"v":${JSON.stringify(payload.v)},` +
    `"fmt":${JSON.stringify(payload.fmt)},` +
    `"user":${JSON.stringify(payload.user)},` +
    `"travelerIndex":${JSON.stringify(payload.travelerIndex)},` +
    `"q":${JSON.stringify(payload.q)},` +
    `"generated":${JSON.stringify(payload.generated)},` +
    `"paths":[\n` +
    pathLines +
    `\n],` +
    `"stats":${JSON.stringify(payload.stats || {})}` +
    `}`;

  return out;
}
