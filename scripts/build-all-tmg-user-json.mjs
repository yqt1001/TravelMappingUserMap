import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const sourceFile = path.resolve(projectRoot, args.src || "data/tm-master-traveled.tmg");
const outputDir = path.resolve(projectRoot, args.outDir || "data/tmg-users");
const quantizeScale = parseQuantizeScale(args.q);
const force = parseBool(args.force, false);
const startAt = parseStartAt(args.startAt);
const threads = parseThreads(args.threads);
const skipIfPathCountSame = parseBool(args.skipIfPathCountSame, false);
const maxAgeDays = parseMaxAgeDays(args.maxAgeDays);

const discoveredUsers = await scanTravelerUsernames(sourceFile);
if (!discoveredUsers.length) {
  throw new Error("No travelers found in TMG source file.");
}

const users = startAt
  ? discoveredUsers.filter((name) => String(name).localeCompare(startAt, undefined, { sensitivity: "base" }) >= 0)
  : discoveredUsers;

await fs.mkdir(outputDir, { recursive: true });

console.log(`TMG source: ${path.relative(projectRoot, sourceFile)}`);
console.log(`Output dir: ${path.relative(projectRoot, outputDir)}`);
console.log(`Discovered users: ${discoveredUsers.length}`);
if (startAt) {
  console.log(`Start-at filter: ${startAt} (${users.length} users selected)`);
}
console.log(`Quantize scale: ${quantizeScale}`);
console.log(`Force rebuild: ${force ? "yes" : "no (skip existing files)"}`);
console.log(`Threads: ${threads}`);
console.log(`Skip if path count same: ${skipIfPathCountSame ? "yes" : "no"}`);
console.log(`Max age days for skip check: ${maxAgeDays}`);
console.log("");

let built = 0;
let skipped = 0;
let failed = 0;
let skippedFreshPathCount = 0;
let refreshedStale = 0;
let writtenNormal = 0;
let writtenUnknown = 0;
let nextTaskIndex = 0;
const workerCount = Math.min(threads, Math.max(1, users.length));

const workers = Array.from({ length: workerCount }, (_unused, workerIndex) =>
  runWorker(workerIndex + 1)
);
await Promise.all(workers);

console.log("");
console.log("Build complete.");
console.log(`Built: ${built}`);
console.log(`Skipped: ${skipped}`);
console.log(`Failed: ${failed}`);
console.log(
  `Built details: written=${writtenNormal}, refreshedStale=${refreshedStale}, skippedFreshPathCount=${skippedFreshPathCount}, unknown=${writtenUnknown}`
);

if (failed > 0) {
  process.exitCode = 1;
}

async function runWorker(workerId) {
  while (true) {
    const taskIndex = nextTaskIndex;
    nextTaskIndex += 1;
    if (taskIndex >= users.length) {
      return;
    }

    const username = users[taskIndex];
    const targetFile = path.join(outputDir, `${username}.json`);
    const label = `[${taskIndex + 1}/${users.length}] ${username}`;

    if (!force && (await fileExists(targetFile))) {
      skipped += 1;
      console.log(`${label} - skipped (already exists)`);
      continue;
    }

    console.log(`${label} - building (worker ${workerId})`);
    const result = await buildSingleUser({
      projectRoot,
      username,
      sourceFile,
      outputDir,
      quantizeScale,
      skipIfPathCountSame,
      maxAgeDays,
    });

    if (result.ok) {
      built += 1;
      if (result.status === "skipped_fresh_path_count") {
        skippedFreshPathCount += 1;
      } else if (result.status === "written_stale_refresh") {
        refreshedStale += 1;
      } else if (result.status === "written") {
        writtenNormal += 1;
      } else {
        writtenUnknown += 1;
      }
      console.log(`${label} - done`);
    } else {
      failed += 1;
      console.error(
        `${label} - failed${result.detail ? `: ${result.detail.replace(/\s+/g, " ").trim()}` : ""}`
      );
    }
  }
}

async function scanTravelerUsernames(tmgPath) {
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
  if (travelers.length !== travelerCount) {
    console.warn(
      `Warning: traveler count mismatch (header=${travelerCount}, line=${travelers.length}).`
    );
  }
  return travelers;
}

async function buildSingleUser({
  projectRoot: root,
  username,
  sourceFile: src,
  outputDir: outDir,
  quantizeScale: q,
  skipIfPathCountSame: skipPathCount,
  maxAgeDays: ageDays,
}) {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(root, "scripts/build-tmg-user-json.mjs");
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        `--user=${username}`,
        `--src=${src}`,
        `--outDir=${outDir}`,
        `--q=${q}`,
        `--skipIfPathCountSame=${skipPathCount ? "true" : "false"}`,
        `--maxAgeDays=${ageDays}`,
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        detail: `${username}: spawn error: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          ok: true,
          status: parseResultStatus(stdout),
        });
        return;
      }
      const detail = stderr.trim();
      resolve({
        ok: false,
        detail: `${username}: build exited with code ${code}.${detail ? ` ${detail}` : ""}`,
      });
    });
  });
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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

function parseStartAt(value) {
  if (!value) {
    return "";
  }
  return String(value).trim();
}

function parseThreads(value) {
  if (!value) {
    return 4;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
    throw new Error(`Invalid --threads value: ${value} (expected integer 1-64)`);
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

function parseResultStatus(stdout) {
  const match = String(stdout || "").match(/RESULT_STATUS:\s*([a-z_]+)/);
  if (!match) {
    return "unknown";
  }
  return match[1];
}
