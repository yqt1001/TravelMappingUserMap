# Data Build Scripts

Scripts in this folder prepare deployable app data from Travel Mapping sources.

## Script index

- `build-tmg-user-json.mjs` - build JSON for one user
- `build-all-tmg-user-json.mjs` - build JSON for all users
- `analyze-tmg-user-diff.mjs` - summarize JSON diffs by category
- `build-highway-json.mjs` - legacy script kept for reference

## `build-tmg-user-json.mjs`

### Purpose

- Reads `data/tm-master-traveled.tmg` (`TMG 2.0 traveled` format).
- Finds one target username in the traveler list.
- Extracts edges traveled by that user only.
- Merges contiguous traveled edges into longer polylines.
- Quantizes coordinates into compact integer arrays.
- Writes JSON with one `paths` entry per line for cleaner git diffs.
- Leaves an existing output untouched when the regenerated data matches, so `generated` only changes when that user's data changes.
- Writes output to `data/tmg-users/<username>.json`.

### Command

Run from project root:

```bash
node scripts/build-tmg-user-json.mjs --user=<username>
```

### Options

- `--src=<path>`: TMG source file (default `data/tm-master-traveled.tmg`)
- `--outDir=<path>`: output directory (default `data/tmg-users`)
- `--q=<integer>`: quantization scale (default `100000`)
- `--skipIfPathCountSame=true|false`: if true, keep existing file when path count is unchanged (default `false`)
- `--maxAgeDays=<number>`: when skip mode is on, refresh stale files older than this age (default `0`)

### Examples

```bash
node scripts/build-tmg-user-json.mjs --user=yqt1001
```

```bash
node scripts/build-tmg-user-json.mjs --user=mapcat --q=100000
```

## `build-all-tmg-user-json.mjs`

### Purpose

- Reads traveler usernames from the TMG traveler line.
- Runs the single-user builder for each traveler.
- Leaves unchanged per-user JSON files untouched, even during forced rebuilds.
- Writes outputs to `data/tmg-users/<username>.json`.

### Command

Run from project root:

```bash
node scripts/build-all-tmg-user-json.mjs
```

### Options

- `--src=<path>`: TMG source file (default `data/tm-master-traveled.tmg`)
- `--outDir=<path>`: output directory (default `data/tmg-users`)
- `--q=<integer>`: quantization scale passed to each build (default `100000`)
- `--threads=<integer>`: parallel worker count (default `4`)
- `--force=true|false`: rebuild existing user files (default `false`)
- `--skipIfPathCountSame=true|false`: pass-through to single-user builder (default `false`)
- `--maxAgeDays=<number>`: pass-through stale threshold used by skip mode (default `0`)
- `--startAt=<username>`: alphabetical resume point (useful after interruption)

### Examples

```bash
node scripts/build-all-tmg-user-json.mjs --startAt=6lane
```

```bash
node scripts/build-all-tmg-user-json.mjs --force=true
```

```bash
node scripts/build-all-tmg-user-json.mjs --threads=4
```

```bash
node scripts/build-all-tmg-user-json.mjs --skipIfPathCountSame=true --maxAgeDays=7
```

