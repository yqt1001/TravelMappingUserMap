# Data Build Scripts

Scripts in this folder prepare deployable app data from Travel Mapping sources.

## Script index

- `build-tmg-user-json.mjs` - build JSON for one user
- `build-all-tmg-user-json.mjs` - build JSON for all users
- `build-highway-json.mjs` - legacy script kept for reference

## `build-tmg-user-json.mjs`

### Purpose

- Reads `data/tm-master-traveled.tmg` (`TMG 2.0 traveled` format).
- Finds one target username in the traveler list.
- Extracts edges traveled by that user only.
- Merges contiguous traveled edges into longer polylines.
- Quantizes coordinates into compact integer arrays.
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

## Legacy script

- `build-highway-json.mjs` remains in the repo for historical/reference purposes.
- The app no longer loads `data/routes` or `data/route-index`.
