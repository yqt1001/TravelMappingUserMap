# TravelMappingUserMap

Lightweight browser app that renders a Travel Mapping user's traveled highway segments on a Leaflet map.

This is deployed as a GitHub page! Access the app here: https://yqt1001.github.io/TravelMappingUserMap/

## What it does

- Takes a Travel Mapping username.
- Loads compact local per-user JSON generated from the TravelMapping master graph.
- Draws that user's traveled graph.
- Supports shareable links with `?user=<username>`.

## How it works (high level)

1. Generate compact `data/tmg-users/<username>.json` from the traveled TMG file.
2. Enter that username in the app.
3. App decodes and renders polylines in batches (worker-enabled when available).

## Run locally

From the project root:

1. Generate local user data:
   - `node scripts/build-tmg-user-json.mjs --user=<username>`
2. Start a local web server (not `file://`):
   - `python -m http.server 8080`
3. Open:
   - `http://localhost:8080`

Advanced build script details are in `scripts/README.md`.

## Licensing and attribution

- App code (`index.html`, `index.js`, scripts) is licensed under the MIT License. See `LICENSE`.
- Both highway and user data used by this project is from TravelMapping and is redistributed here in transformed JSON outputs.
- Data attribution statement:
  - "This project uses highway data from the TravelMapping project. The data has been modified from its original format for optimization. This work is licensed under CC BY-SA 4.0."
- Change notice:
  - Data is transformed from TravelMapping source formats into `data/tmg-users` JSON outputs.
