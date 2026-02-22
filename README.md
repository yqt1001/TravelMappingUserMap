# TravelMappingUserMap

Lightweight browser app that renders a Travel Mapping user's traveled highway segments on a Leaflet map.

## What it does

- Takes a Travel Mapping username.
- Fetches that user's `.list` file from `TravelMapping/UserData`.
- Loads only the needed prebuilt highway JSON route files.
- Matches listed waypoint segments and draws them on the map.
- Supports shareable links with `?user=<username>`.

## How it works (high level)

1. Parse username list entries into route/waypoint segment requests.
2. Load region route indexes from `data/route-index`.
3. Load matching compact route files from `data/routes`.
4. Match segments (including cross-region chaining) and render polylines.

## Known limitations

- The app depends on generated JSON in `data/routes` and `data/route-index`; if source highway data changes, you must rebuild before rerunning/deploying.
- Route matching is tolerant but not perfect; some list entries may remain unmatched due to waypoint alias differences or data inconsistencies.

## Run locally

From the project root:

1. (If source highway data changed) rebuild compact JSON:
   - `node scripts/build-highway-json.mjs`
2. Start a local web server (not `file://`):
   - `python -m http.server 8080`
3. Open:
   - `http://localhost:8080`

Advanced build script details are in `scripts/README.md`.

## Licensing and attribution

- App code (`index.html`, `index.js`, scripts) is licensed under the MIT License. See `LICENSE`.
- Highway data used by this project is from TravelMapping and is redistributed here in a transformed compact JSON format.
- Data attribution statement:
  - "This project uses highway data from the TravelMapping project. The data has been modified from its original format for optimization. This work is licensed under CC BY-SA 4.0."
- Change notice:
  - Data is transformed from TravelMapping source formats into `data/routes` and `data/route-index` JSON outputs.
