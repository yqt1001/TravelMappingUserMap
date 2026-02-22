# Highway JSON Build Script

This folder contains a utility script that converts TravelMapping `.wpt` files into compact JSON files used by the web app.

## Script

- `build-highway-json.mjs`

## What it does

- Reads highway source data from:
  - `data/hwy-data` (preferred), or
  - `data/hwy_data` (fallback)
- Parses all `.wpt` files it finds.
- Builds compact route JSON files under:
  - `data/routes/<REGION>/<SYSTEM>/<route-file>.json`
- Builds region route indexes under:
  - `data/route-index/<REGION>.json`
- Builds a global route-token index for cross-region stitching:
  - `data/route-index/route-token-index.json`
- Recreates both output folders from scratch on each run.

## Output schema (high level)

- Route file fields:
  - `v` schema version
  - `src` original source path
  - `sys` system code
  - `rg` region
  - `rt` route token
  - `pt` array of `[lat, lon]`
  - `lb` array of label arrays aligned with `pt`
- Region index fields:
  - `v` schema version
  - `region`
  - `routes` map of normalized route key to route JSON path(s)
- Route-token index fields:
  - `v` schema version
  - `tokens` map of normalized route token to route JSON path(s)

## Usage

Run from the project root:

```bash
node scripts/build-highway-json.mjs
```

### Optional arguments

- `--src=<path>`: source directory to read `.wpt` files from
- `--outRoutes=<path>`: output directory for route files (default `data/routes`)
- `--outIndex=<path>`: output directory for region indexes (default `data/route-index`)
- `--regions=R1,R2,...`: only build selected regions

## Examples

Build everything:

```bash
node scripts/build-highway-json.mjs
```

Build only Ontario and Sao Paulo:

```bash
node scripts/build-highway-json.mjs --regions=ON,BRA-SP
```

Use an explicit source directory:

```bash
node scripts/build-highway-json.mjs --src=data/hwy_data
```

## Notes

- The app expects the generated `data/routes` and `data/route-index` folders to exist.
- If source data changes, rerun the script to refresh JSON outputs.
