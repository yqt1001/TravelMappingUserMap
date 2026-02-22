/* global L */

(function main() {
  const USER_LIST_BASE_URL =
    "https://cdn.jsdelivr.net/gh/TravelMapping/UserData@master/list_files";
  const LOCAL_ROUTE_INDEX_BASE_URL = "data/route-index";
  const LOCAL_ROUTE_DATA_BASE_URL = "data/routes";
  const LOCAL_ROUTE_TOKEN_INDEX_URL = "data/route-index/route-token-index.json";
  const URL_USER_PARAM = "user";

  const state = {
    highwayIndex: new Map(),
    routeTokenIndex: new Map(),
    allRoutes: [],
    diagnostics: [],
    traveledLayer: null,
    highwayLoadedFromGithub: false,
    routePathIndex: new Map(),
    indexedRegions: new Set(),
    missingRegions: new Set(),
    loadedRoutePaths: new Set(),
    routeTokenPathIndex: null,
    routeTokenPathIndexLoadError: false,
    lastOutputReport: "",
    detailedDebugEnabled: false,
    isBusy: false,
  };

  const els = {
    usernameInput: document.getElementById("usernameInput"),
    processBtn: document.getElementById("processBtn"),
    reloadHighwayBtn: document.getElementById("reloadHighwayBtn"),
    copyDebugBtn: document.getElementById("copyDebugBtn"),
    enableDetailedDebug: document.getElementById("enableDetailedDebug"),
    summary: document.getElementById("summary"),
    outputLog: document.getElementById("outputLog"),
    mapStatusOverlay: document.getElementById("mapStatusOverlay"),
  };

  const map = L.map("map").setView([35, -95], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);
  els.usernameInput.value = "";
  let overlayHideTimer = null;

  if (els.reloadHighwayBtn) {
    els.reloadHighwayBtn.addEventListener("click", async () => {
      state.diagnostics = [];
      renderOutput([], "");
      resetHighwayData();
      state.routePathIndex = new Map();
      state.indexedRegions = new Set();
      state.missingRegions = new Set();
      state.loadedRoutePaths = new Set();
      state.routeTokenPathIndex = null;
      state.routeTokenPathIndexLoadError = false;
      setHighwayStatus("Reloading local highway JSON cache...");
      try {
        state.highwayLoadedFromGithub = false;
        setHighwayStatus(
          "Route cache cleared. Enter a username to load needed highways."
        );
        if (els.summary) {
          els.summary.textContent = "Highway route cache cleared.";
        }
      } catch (error) {
        setHighwayStatus(`Highway data load failed: ${error.message}`);
      }
    });
  }

  if (els.copyDebugBtn) {
    els.copyDebugBtn.addEventListener("click", async () => {
      const text = state.lastOutputReport || "No output generated yet.";
      try {
        await navigator.clipboard.writeText(text);
        setHighwayStatus("Output copied to clipboard.");
      } catch (_error) {
        setHighwayStatus("Could not copy output automatically.");
      }
    });
  }

  if (els.enableDetailedDebug) {
    els.enableDetailedDebug.addEventListener("change", () => {
      state.detailedDebugEnabled = !!els.enableDetailedDebug.checked;
      setHighwayStatus(
        state.detailedDebugEnabled
          ? "Detailed debug report enabled."
          : "Detailed debug report disabled."
      );
    });
  }

  if (els.processBtn) {
    els.processBtn.addEventListener("click", async () => {
      try {
        setUiBusy(true);
        state.diagnostics = [];
        renderOutput([], "");

        const username = (els.usernameInput.value || "").trim();
        if (!username) {
          if (els.summary) {
            els.summary.textContent = "Please enter a Travel Mapping username.";
          }
          renderOutput([{ severity: "error", message: "Username is required." }], "");
          return;
        }

        let listText;
        try {
          setHighwayStatus(`Fetching list file for ${username}...`);
          listText = await fetchUserList(username);
        } catch (error) {
          if (els.summary) {
            els.summary.textContent = `Could not load list file for "${username}".`;
          }
          renderOutput([{ severity: "error", message: error.message }], "");
          return;
        }

        const routeKeys = collectRouteKeysFromList(listText);
        const chainRouteTokens = collectChainRouteTokensFromList(listText);
        let loadMeta;
        try {
          loadMeta = await ensureHighwayDataLoaded(routeKeys, chainRouteTokens, false);
        } catch (error) {
          if (els.summary) {
            els.summary.textContent = "Could not load local highway JSON data.";
          }
          renderOutput([{ severity: "error", message: error.message }], "");
          return;
        }

        const result = processUserList(listText);
        drawSegments(result.segments);
        const debugReport = state.detailedDebugEnabled
          ? buildDebugReport(username, routeKeys, loadMeta, result)
          : "";
        renderOutput(result.diagnostics, debugReport);

        if (els.summary) {
          els.summary.textContent =
            `Username: ${username}\n` +
            `Unique routes requested: ${routeKeys.size}\n` +
            `Route files in memory: ${state.allRoutes.length}\n` +
            `List lines parsed: ${result.stats.parsedLines}\n` +
            `Matched travel segments: ${result.segments.length}\n` +
            `Unmatched lines: ${result.stats.unmatchedLines}\n` +
            `Warnings/Errors: ${result.diagnostics.length}`;
        }

        setHighwayStatus(
          `Ready: ${result.segments.length} sections mapped`
        );
        updateUrlUserParam(username);
      } catch (error) {
        renderOutput(
          [{ severity: "error", message: `Unexpected error: ${error.message}` }],
          ""
        );
        setHighwayStatus("Build failed unexpectedly. See output panel.");
      } finally {
        setUiBusy(false);
      }
    });
  }

  function resetHighwayData() {
    state.highwayIndex = new Map();
    state.routeTokenIndex = new Map();
    state.allRoutes = [];
  }

  function getUrlUserParam() {
    const params = new URLSearchParams(window.location.search);
    return (params.get(URL_USER_PARAM) || "").trim();
  }

  function updateUrlUserParam(username) {
    const value = String(username || "").trim();
    if (!value) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set(URL_USER_PARAM, value);
    window.history.replaceState({}, "", url.toString());
  }

  function setHighwayStatus(text) {
    if (els.mapStatusOverlay) {
      if (overlayHideTimer) {
        clearTimeout(overlayHideTimer);
        overlayHideTimer = null;
      }
      els.mapStatusOverlay.textContent = text;
      els.mapStatusOverlay.classList.remove("hidden");
      if (String(text || "").startsWith("Ready:")) {
        overlayHideTimer = setTimeout(() => {
          if (els.mapStatusOverlay) {
            els.mapStatusOverlay.classList.add("hidden");
          }
          overlayHideTimer = null;
        }, 3500);
      }
    }
  }

  function setUiBusy(isBusy) {
    state.isBusy = isBusy;
    if (els.processBtn) {
      els.processBtn.disabled = isBusy;
      els.processBtn.textContent = isBusy
        ? "Building Map..."
        : "Build Map";
    }
  }

  async function ensureHighwayDataLoaded(routeKeys, chainRouteTokens, forceReload) {
    if (forceReload) {
      resetHighwayData();
      state.routePathIndex = new Map();
      state.indexedRegions = new Set();
      state.missingRegions = new Set();
      state.loadedRoutePaths = new Set();
      state.routeTokenPathIndex = null;
      state.routeTokenPathIndexLoadError = false;
      state.highwayLoadedFromGithub = false;
    }

    const keys = Array.from(routeKeys || []);
    const regionsToIndex = new Set(keys.map((key) => key.split("|")[0]));
    let indexedNow = 0;
    for (const region of regionsToIndex) {
      const wasIndexed = state.indexedRegions.has(region);
      await ensureRegionIndexed(region);
      if (!wasIndexed && state.indexedRegions.has(region)) {
        indexedNow += 1;
      }
    }

    const targetPaths = new Set();

    for (const key of keys) {
      const paths = state.routePathIndex.get(key) || [];
      for (const path of paths) {
        targetPaths.add(path);
      }
    }

    let chainExpansionPathCount = 0;
    const tokenSet = new Set(chainRouteTokens || []);
    if (tokenSet.size) {
      const tokenPathIndex = await ensureRouteTokenPathIndexLoaded();
      if (tokenPathIndex) {
        for (const token of tokenSet) {
          const extraPaths = tokenPathIndex.get(token) || [];
          for (const path of extraPaths) {
            const before = targetPaths.size;
            targetPaths.add(path);
            if (targetPaths.size > before) {
              chainExpansionPathCount += 1;
            }
          }
        }
      }
    }

    const missingPaths = Array.from(targetPaths).filter(
      (path) => !state.loadedRoutePaths.has(path)
    );

    if (!missingPaths.length) {
      setHighwayStatus(
        `Using cached route data (${state.allRoutes.length} routes in memory) for requested list.`
      );
      const unresolvedRouteKeys = keys.filter(
        (key) => !(state.routePathIndex.get(key) || []).length
      );
      return {
        requestedRouteKeys: keys.length,
        resolvedRouteKeys: keys.length - unresolvedRouteKeys.length,
        unresolvedRouteKeys,
        targetPathCount: targetPaths.size,
        chainExpansionPathCount,
        fetchedPathCount: 0,
        indexedRegionCount: regionsToIndex.size,
        newlyIndexedRegions: indexedNow,
        missingRegions: Array.from(state.missingRegions),
      };
    }

    for (let i = 0; i < missingPaths.length; i += 1) {
      if (i % 25 === 0 || i === missingPaths.length - 1) {
        setHighwayStatus(
          `Fetching/parsing route shards: ${i + 1}/${missingPaths.length}`
        );
      }

      const path = missingPaths[i];
      const url = `${LOCAL_ROUTE_DATA_BASE_URL}/${path}`;
      const response = await fetch(url);
      if (!response.ok) {
        state.diagnostics.push({
          severity: "warning",
          message: `Could not fetch route data JSON file: ${path}`,
        });
        continue;
      }

      const body = await response.json();
      let parsedThisFile = 0;
      if (body && typeof body === "object" && Array.isArray(body.routes)) {
        for (let routeIdx = 0; routeIdx < body.routes.length; routeIdx += 1) {
          const parsed = parseCompactRouteJson(
            `${path}#${routeIdx + 1}`,
            body.routes[routeIdx]
          );
          if (!parsed) {
            continue;
          }
          addParsedRouteObject(parsed);
          parsedThisFile += 1;
        }
      } else {
        const parsed = parseCompactRouteJson(path, body);
        if (parsed) {
          addParsedRouteObject(parsed);
          parsedThisFile += 1;
        }
      }
      if (!parsedThisFile) {
        state.diagnostics.push({
          severity: "warning",
          message: `No valid routes parsed from ${path}`,
        });
      }
      state.loadedRoutePaths.add(path);
    }

    state.highwayLoadedFromGithub = true;
    setHighwayStatus(
      `Loaded ${state.allRoutes.length} local route(s) needed by this user list.`
    );

    const unresolvedRouteKeys = keys.filter(
      (key) => !(state.routePathIndex.get(key) || []).length
    );
    return {
      requestedRouteKeys: keys.length,
      resolvedRouteKeys: keys.length - unresolvedRouteKeys.length,
      unresolvedRouteKeys,
      targetPathCount: targetPaths.size,
      chainExpansionPathCount,
      fetchedPathCount: missingPaths.length,
      indexedRegionCount: regionsToIndex.size,
      newlyIndexedRegions: indexedNow,
      missingRegions: Array.from(state.missingRegions),
    };
  }

  async function ensureRegionIndexed(region) {
    if (state.indexedRegions.has(region) || state.missingRegions.has(region)) {
      return;
    }

    setHighwayStatus(`Indexing region ${region} via local JSON index...`);
    const regionIndex = await fetchRegionRouteIndex(region);

    if (!regionIndex || !regionIndex.routes || !Object.keys(regionIndex.routes).length) {
      state.missingRegions.add(region);
      return;
    }

    for (const [rawRouteKey, paths] of Object.entries(regionIndex.routes)) {
      if (!Array.isArray(paths) || !paths.length) {
        continue;
      }
      const routeKey = normalizeRouteKey(rawRouteKey);
      const existing = state.routePathIndex.get(routeKey) || [];
      for (const path of paths) {
        if (typeof path === "string") {
          existing.push(path);
        }
      }
      state.routePathIndex.set(routeKey, existing);
    }

    state.indexedRegions.add(region);
  }

  async function fetchRegionRouteIndex(region) {
    const normalizedRegion = normalizeRegion(region);
    if (!normalizedRegion) {
      return null;
    }
    const url = `${LOCAL_ROUTE_INDEX_BASE_URL}/${normalizedRegion}.json`;
    const response = await fetch(url);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed loading route index for region ${normalizedRegion}.`);
    }

    const body = await response.json();
    return body && typeof body === "object" ? body : null;
  }

  async function fetchUserList(username) {
    const preferred = username.trim();
    const candidates = [preferred, preferred.toLowerCase()];
    const attempted = [];

    for (const name of candidates) {
      if (!name || attempted.includes(name)) {
        continue;
      }
      attempted.push(name);

      const url = `${USER_LIST_BASE_URL}/${encodeURIComponent(name)}.list`;
      const response = await fetch(url);
      if (response.ok) {
        return response.text();
      }
    }

    throw new Error(
      `No list file found for username "${username}" in TravelMapping/UserData.`
    );
  }

  function addParsedRouteObject(parsed) {
    state.allRoutes.push(parsed);
    const routeKey = makeRouteKey(parsed.region, parsed.routeToken);
    const existing = state.highwayIndex.get(routeKey) || [];
    existing.push(parsed);
    state.highwayIndex.set(routeKey, existing);

    const normalizedRouteToken = normalizeRoute(parsed.routeToken);
    const byToken = state.routeTokenIndex.get(normalizedRouteToken) || [];
    byToken.push(parsed);
    state.routeTokenIndex.set(normalizedRouteToken, byToken);
  }

  function collectRouteKeysFromList(listText) {
    const routeKeys = new Set();
    const lines = listText.split(/\r?\n/);
    for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
      const originalLine = lines[lineNumber - 1];
      const noComment = originalLine.split("#")[0].trim();
      if (!noComment) {
        continue;
      }

      const tokens = noComment.split(/\s+/);
      if (tokens.length < 4) {
        continue;
      }

      if (looksLikeRegionRouteWaypointChain(tokens)) {
        for (let i = 0; i < tokens.length; i += 3) {
          const region = normalizeRegion(tokens[i]);
          const routeToken = tokens[i + 1];
          routeKeys.add(makeRouteKey(region, routeToken));
        }
        continue;
      }

      const region = normalizeRegion(tokens[0]);
      const routeToken = tokens[1];
      routeKeys.add(makeRouteKey(region, routeToken));
    }
    return routeKeys;
  }

  function collectChainRouteTokensFromList(listText) {
    const out = new Set();
    const lines = listText.split(/\r?\n/);
    for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
      const originalLine = lines[lineNumber - 1];
      const noComment = originalLine.split("#")[0].trim();
      if (!noComment) {
        continue;
      }
      const tokens = noComment.split(/\s+/);
      if (!looksLikeRegionRouteWaypointChain(tokens)) {
        continue;
      }
      for (let i = 0; i < tokens.length - 3; i += 3) {
        const startRouteToken = tokens[i + 1];
        const endRouteToken = tokens[i + 4];
        if (normalizeRoute(startRouteToken) === normalizeRoute(endRouteToken)) {
          out.add(normalizeRoute(startRouteToken));
        }
      }
    }
    return out;
  }

  async function ensureRouteTokenPathIndexLoaded() {
    if (state.routeTokenPathIndexLoadError) {
      return null;
    }
    if (state.routeTokenPathIndex instanceof Map) {
      return state.routeTokenPathIndex;
    }

    const response = await fetch(LOCAL_ROUTE_TOKEN_INDEX_URL);
    if (response.status === 404) {
      state.routeTokenPathIndexLoadError = true;
      state.diagnostics.push({
        severity: "warning",
        message:
          "route-token-index.json not found; cross-region chain loading may miss intermediate routes. Rebuild highway JSON data.",
      });
      return null;
    }
    if (!response.ok) {
      throw new Error("Failed loading route token index for cross-region stitching.");
    }

    const body = await response.json();
    const tokenEntries = body && typeof body === "object" && body.tokens && typeof body.tokens === "object"
      ? body.tokens
      : null;
    if (!tokenEntries) {
      state.routeTokenPathIndexLoadError = true;
      state.diagnostics.push({
        severity: "warning",
        message: "Invalid route-token-index.json format.",
      });
      return null;
    }

    const tokenMap = new Map();
    for (const [token, paths] of Object.entries(tokenEntries)) {
      if (!Array.isArray(paths) || !paths.length) {
        continue;
      }
      tokenMap.set(normalizeRoute(token), paths.filter((p) => typeof p === "string"));
    }
    state.routeTokenPathIndex = tokenMap;
    return state.routeTokenPathIndex;
  }

  function parseCompactRouteJson(sourcePath, body) {
    if (!body || typeof body !== "object") {
      state.diagnostics.push({
        severity: "warning",
        message: `Invalid route JSON object in ${sourcePath}`,
      });
      return null;
    }

    const sourceName = typeof body.src === "string" && body.src ? body.src : sourcePath;
    const system = typeof body.sys === "string" && body.sys ? body.sys : "unknown";
    const region = String(body.rg || "").toUpperCase();
    const routeToken = String(body.rt || "");
    const pointsRaw = Array.isArray(body.pt) ? body.pt : [];
    const labelsRaw = Array.isArray(body.lb) ? body.lb : [];

    if (!region || !routeToken) {
      state.diagnostics.push({
        severity: "warning",
        message: `Missing region/route token in ${sourcePath}`,
      });
      return null;
    }

    const points = [];
    const waypointIndex = new Map();

    for (let i = 0; i < pointsRaw.length; i += 1) {
      const pair = pointsRaw[i];
      if (!Array.isArray(pair) || pair.length < 2) {
        continue;
      }
      const lat = Number(pair[0]);
      const lon = Number(pair[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }

      const labels = Array.isArray(labelsRaw[i])
        ? labelsRaw[i].filter((label) => typeof label === "string" && label.trim())
        : [];
      const point = { lat, lon, labels };
      points.push(point);
      const pointIdx = points.length - 1;

      for (const label of labels) {
        const aliases = buildWaypointAliases(label);
        for (const alias of aliases) {
          if (!waypointIndex.has(alias)) {
            waypointIndex.set(alias, pointIdx);
          }
        }
      }
    }

    if (points.length < 2) {
      state.diagnostics.push({
        severity: "warning",
        message: `Not enough mappable points in ${sourcePath}`,
      });
      return null;
    }

    return {
      sourceName,
      system,
      region,
      routeToken,
      points,
      waypointIndex,
    };
  }

  function processUserList(listText) {
    const diagnostics = [];
    const segments = [];
    const stats = {
      parsedLines: 0,
      unmatchedLines: 0,
      reasonCounts: {},
      sampleFailures: [],
      debug: {
        chainLines: 0,
        standardLines: 0,
        parsedSegments: 0,
        stitchAttempts: 0,
        stitchSuccesses: 0,
        stitchFailureCounts: {},
        chainLineSamples: [],
        segmentRequestSamples: [],
        stitchSamples: [],
        chainGraphSamples: [],
        chainGeometryFailureSamples: [],
      },
    };

    const lines = listText.split(/\r?\n/);
    for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
      const originalLine = lines[lineNumber - 1];
      const noComment = originalLine.split("#")[0].trim();
      if (!noComment) {
        continue;
      }

      const tokens = noComment.split(/\s+/);
      if (tokens.length < 4) {
        incrementCount(stats.reasonCounts, "short_line");
        diagnostics.push({
          severity: "warning",
          message: `Line ${lineNumber}: expected at least 4 tokens, got "${noComment}"`,
        });
        stats.unmatchedLines += 1;
        continue;
      }

      stats.parsedLines += 1;
      const isChainLine = looksLikeRegionRouteWaypointChain(tokens);
      if (isChainLine) {
        stats.debug.chainLines += 1;
        pushLimited(stats.debug.chainLineSamples, `line ${lineNumber}: ${noComment}`, 12);
      } else {
        stats.debug.standardLines += 1;
      }

      const parsedSegments = parseLineIntoSegments(tokens, isChainLine);
      stats.debug.parsedSegments += parsedSegments.length;
      for (const segmentReq of parsedSegments) {
        pushLimited(
          stats.debug.segmentRequestSamples,
          `line ${lineNumber}: ${segmentReq.routeRef} ${segmentReq.startLabel}->${segmentReq.endLabel} ` +
            `(end ${segmentReq.endRegionToken} ${segmentReq.endRouteToken})`,
          20
        );
      }

      let matchedAny = false;
      for (const segmentReq of parsedSegments) {
        const matched = matchRequestedSegment(segmentReq, stats.debug);
        if (!matched) {
          incrementCount(stats.reasonCounts, "unknown_match_error");
          diagnostics.push({
            severity: "warning",
            message:
              `Line ${lineNumber}: could not match segment ${segmentReq.routeRef} ` +
              `${segmentReq.startLabel} -> ${segmentReq.endLabel}`,
          });
          continue;
        }

        if (!matched.matched) {
          const reason = matched.reason || "segment_unmatched";
          incrementCount(stats.reasonCounts, reason);
          pushSampleFailure(stats.sampleFailures, {
            lineNumber,
            routeRef: segmentReq.routeRef,
            startLabel: segmentReq.startLabel,
            endLabel: segmentReq.endLabel,
            reason,
          });
          diagnostics.push({
            severity: "warning",
            message:
              `Line ${lineNumber}: could not match segment ${segmentReq.routeRef} ` +
              `${segmentReq.startLabel} -> ${segmentReq.endLabel} (${reason})`,
          });
          continue;
        }

        matchedAny = true;
        segments.push({
          lineNumber,
          routeRef: segmentReq.routeRef,
          routeSource: matched.routeSource || matched.route.sourceName,
          coords: matched.coords,
          startLabel: segmentReq.startLabel,
          endLabel: segmentReq.endLabel,
        });
      }

      if (!matchedAny) {
        stats.unmatchedLines += 1;
      }
    }

    return { segments, diagnostics, stats };
  }

  function matchSegmentDetailed(candidates, startLabel, endLabel) {
    const startAliases = buildWaypointAliases(startLabel);
    const endAliases = buildWaypointAliases(endLabel);
    if (!startAliases.length || !endAliases.length) {
      return { matched: false, reason: "invalid_waypoint_token" };
    }

    let anyStart = false;
    let anyEnd = false;

    for (const route of candidates) {
      const startIndex = findFirstWaypointIndex(route.waypointIndex, startAliases);
      const endIndex = findFirstWaypointIndex(route.waypointIndex, endAliases);

      if (Number.isInteger(startIndex)) {
        anyStart = true;
      }
      if (Number.isInteger(endIndex)) {
        anyEnd = true;
      }

      if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
        continue;
      }

      const coords = buildCoordsBetweenIndices(route.points, startIndex, endIndex);
      if (!coords || coords.length < 2) {
        continue;
      }
      return { matched: true, route, coords };
    }

    if (!anyStart && !anyEnd) {
      return { matched: false, reason: "both_waypoints_missing" };
    }
    if (!anyStart) {
      return { matched: false, reason: "start_waypoint_missing" };
    }
    if (!anyEnd) {
      return { matched: false, reason: "end_waypoint_missing" };
    }
    return { matched: false, reason: "waypoints_not_on_same_route_variant" };
  }

  function matchRequestedSegment(segmentReq, debugStats) {
    const startKey = makeRouteKey(segmentReq.startRegion, segmentReq.startRouteToken);
    const startCandidates = state.highwayIndex.get(startKey) || [];
    const isCrossRegion = segmentReq.startRegion !== segmentReq.endRegion;
    if (!startCandidates.length) {
      if (debugStats) {
        pushLimited(
          debugStats.stitchSamples,
          `no start candidates for ${segmentReq.routeRef} (${startKey})`,
          20
        );
      }
      return { matched: false, reason: "route_not_loaded" };
    }

    const direct = matchSegmentDetailed(
      startCandidates,
      segmentReq.startLabel,
      segmentReq.endLabel
    );
    if (direct && direct.matched && !isCrossRegion) {
      return direct;
    }
    if (direct && direct.matched && isCrossRegion && debugStats) {
      pushLimited(
        debugStats.stitchSamples,
        `ignored direct match for cross-region ${segmentReq.routeRef} ` +
          `${segmentReq.startLabel}->${segmentReq.endLabel}`,
        20
      );
    }

    const routeTokenMatch =
      normalizeRoute(segmentReq.startRouteToken) === normalizeRoute(segmentReq.endRouteToken);
    if (!routeTokenMatch) {
      if (segmentReq.fromChain) {
        const endKey = makeRouteKey(segmentReq.endRegion, segmentReq.endRouteToken);
        const endCandidates = state.highwayIndex.get(endKey) || [];
        if (!endCandidates.length) {
          if (debugStats) {
            incrementCount(debugStats.stitchFailureCounts, "end_route_not_loaded");
            pushLimited(
              debugStats.stitchSamples,
              `no end candidates for ${segmentReq.endRegionToken} ${segmentReq.endRouteToken} (${endKey})`,
              20
            );
          }
          return { matched: false, reason: "route_not_loaded" };
        }
        if (debugStats) {
          debugStats.stitchAttempts += 1;
        }
        const bridged = matchSegmentAcrossExplicitRoutePair(
          startCandidates,
          endCandidates,
          segmentReq.startLabel,
          segmentReq.endLabel
        );
        if (bridged && bridged.matched) {
          if (debugStats) {
            debugStats.stitchSuccesses += 1;
            pushLimited(
              debugStats.stitchSamples,
              `bridged token mismatch ${segmentReq.routeRef} ${segmentReq.startLabel}->${segmentReq.endLabel} via ${bridged.routeSource}`,
              20
            );
          }
          return bridged;
        }
        if (debugStats) {
          const reason = (bridged && bridged.reason) || "token_mismatch_no_bridge";
          incrementCount(debugStats.stitchFailureCounts, reason);
          pushLimited(
            debugStats.stitchSamples,
            `bridge failed ${segmentReq.routeRef} -> ${segmentReq.endRegionToken} ${segmentReq.endRouteToken}: ${reason}`,
            20
          );
        }
        return direct || { matched: false, reason: "segment_unmatched" };
      }
      if (debugStats && segmentReq.startRegion !== segmentReq.endRegion) {
        incrementCount(debugStats.stitchFailureCounts, "route_token_mismatch");
        pushLimited(
          debugStats.stitchSamples,
          `token mismatch ${segmentReq.routeRef} -> ${segmentReq.endRegionToken} ${segmentReq.endRouteToken}`,
          20
        );
      }
      return direct || { matched: false, reason: "segment_unmatched" };
    }

    const endKey = makeRouteKey(segmentReq.endRegion, segmentReq.endRouteToken);
    const endCandidates = state.highwayIndex.get(endKey) || [];
    if (!endCandidates.length) {
      if (debugStats) {
        incrementCount(debugStats.stitchFailureCounts, "end_route_not_loaded");
        pushLimited(
          debugStats.stitchSamples,
          `no end candidates for ${segmentReq.endRegionToken} ${segmentReq.endRouteToken} (${endKey})`,
          20
        );
      }
      return { matched: false, reason: "route_not_loaded" };
    }

    if (debugStats) {
      debugStats.stitchAttempts += 1;
    }
    const stitched = matchSegmentAcrossRegionsSameRouteToken(
      normalizeRoute(segmentReq.startRouteToken),
      segmentReq.startLabel,
      segmentReq.endLabel,
      debugStats,
      segmentReq,
      startCandidates,
      endCandidates
    );
    if (stitched && stitched.matched) {
      if (debugStats) {
        debugStats.stitchSuccesses += 1;
        pushLimited(
          debugStats.stitchSamples,
          `stitched ${segmentReq.routeRef} ${segmentReq.startLabel}->${segmentReq.endLabel} via ${stitched.routeSource}`,
          20
        );
      }
      return stitched;
    }
    if (debugStats && stitched && stitched.reason) {
      incrementCount(debugStats.stitchFailureCounts, stitched.reason);
      pushLimited(
        debugStats.stitchSamples,
        `stitch failed ${segmentReq.routeRef} ${segmentReq.startLabel}->${segmentReq.endLabel}: ` +
          `${stitched.reason}${stitched.debugMessage ? ` [${stitched.debugMessage}]` : ""}`,
        20
      );
      if (stitched.reason === "chain_segment_geometry_not_found") {
        pushLimited(
          debugStats.chainGeometryFailureSamples,
          `${segmentReq.routeRef} ${segmentReq.startLabel}->${segmentReq.endLabel}: ` +
            `${stitched.debugMessage || "no debugMessage"}`,
          20
        );
      }
      if (direct && !direct.matched && direct.reason) {
        pushLimited(
          debugStats.stitchSamples,
          `fallback direct reason for ${segmentReq.routeRef} ${segmentReq.startLabel}->${segmentReq.endLabel}: ` +
            `${direct.reason}`,
          20
        );
      }
    }

    return direct || { matched: false, reason: "segment_unmatched" };
  }

  function matchSegmentAcrossExplicitRoutePair(
    startCandidates,
    endCandidates,
    startLabel,
    endLabel
  ) {
    const startAliases = buildWaypointAliases(startLabel);
    const endAliases = buildWaypointAliases(endLabel);
    if (!startAliases.length || !endAliases.length) {
      return { matched: false, reason: "invalid_waypoint_aliases" };
    }

    for (const startRoute of startCandidates) {
      const startAlias = findFirstAliasPresent(startRoute.waypointIndex, startAliases);
      if (!startAlias) {
        continue;
      }
      for (const endRoute of endCandidates) {
        const endAlias = findFirstAliasPresent(endRoute.waypointIndex, endAliases);
        if (!endAlias) {
          continue;
        }
        const connector = findConnectorBetweenRoutes(startRoute, endRoute);
        const sharedAlias = connector.alias;
        if (!sharedAlias) {
          continue;
        }
        const first = extractSegmentCoordsByAlias(startRoute, startAlias, sharedAlias);
        const second = extractSegmentCoordsByAlias(endRoute, sharedAlias, endAlias);
        if (!first || !second) {
          continue;
        }
        return {
          matched: true,
          route: startRoute,
          routeSource: `${startRoute.sourceName} -> ${endRoute.sourceName}`,
          coords: first.concat(second.slice(1)),
        };
      }
    }

    return { matched: false, reason: "no_shared_alias_between_explicit_routes" };
  }

  function matchSegmentAcrossRegionsSameRouteToken(
    normalizedRouteToken,
    startLabel,
    endLabel,
    _debugStats,
    _segmentReq,
    preferredStartCandidates,
    preferredEndCandidates
  ) {
    const tokenCandidates = state.routeTokenIndex.get(normalizedRouteToken) || [];
    if (!tokenCandidates.length) {
      return { matched: false, reason: "no_candidates_for_route_token" };
    }

    const startAliases = buildWaypointAliases(startLabel);
    const endAliases = buildWaypointAliases(endLabel);
    if (!startAliases.length || !endAliases.length) {
      return { matched: false, reason: "invalid_waypoint_aliases" };
    }

    const routeEntries = tokenCandidates.map((route, routeIdx) => ({
      route,
      routeIdx,
      aliases: new Set(route.waypointIndex.keys()),
    }));
    const preferredStartSet = new Set(preferredStartCandidates || []);
    const preferredEndSet = new Set(preferredEndCandidates || []);
    const routeCount = routeEntries.length;
    const adjacency = Array.from({ length: routeCount }, () => []);
    const rejectedConnectorCounts = {};
    const rejectedConnectorSamples = [];
    let connectorEdgeCount = 0;

    for (let i = 0; i < routeCount; i += 1) {
      for (let j = i + 1; j < routeCount; j += 1) {
        const connector = findConnectorBetweenRoutes(
          routeEntries[i].route,
          routeEntries[j].route
        );
        const sharedAlias = connector.alias;
        if (!sharedAlias) {
          incrementCount(rejectedConnectorCounts, connector.reason || "connector_rejected");
          pushLimited(
            rejectedConnectorSamples,
            `${shortRouteSource(routeEntries[i].route.sourceName)} x ` +
              `${shortRouteSource(routeEntries[j].route.sourceName)} => ${connector.reason || "connector_rejected"}`,
            10
          );
          continue;
        }
        adjacency[i].push({ next: j, viaAlias: sharedAlias });
        adjacency[j].push({ next: i, viaAlias: sharedAlias });
        connectorEdgeCount += 1;
      }
    }

    const startRoutes = [];
    const endRouteSet = new Set();
    for (const entry of routeEntries) {
      const startAllowed =
        !preferredStartSet.size || preferredStartSet.has(entry.route);
      const endAllowed = !preferredEndSet.size || preferredEndSet.has(entry.route);
      if (
        startAllowed &&
        findFirstWaypointIndex(entry.route.waypointIndex, startAliases) !== null
      ) {
        startRoutes.push(entry.routeIdx);
      }
      if (
        endAllowed &&
        findFirstWaypointIndex(entry.route.waypointIndex, endAliases) !== null
      ) {
        endRouteSet.add(entry.routeIdx);
      }
    }
    if (!startRoutes.length || !endRouteSet.size) {
      return {
        matched: false,
        reason: !startRoutes.length ? "start_alias_not_found_any_route" : "end_alias_not_found_any_route",
        debugMessage:
          `tokenCandidates=${tokenCandidates.length}, startRoutes=${startRoutes.length}, ` +
          `endRoutes=${endRouteSet.size}, edges=${connectorEdgeCount}`,
      };
    }

    const queue = [];
    const seen = new Set();
    const parentByRoute = new Map();
    for (const routeIdx of startRoutes) {
      queue.push(routeIdx);
      seen.add(routeIdx);
      parentByRoute.set(routeIdx, null);
    }

    let goalRoute = null;
    while (queue.length) {
      const current = queue.shift();
      if (endRouteSet.has(current)) {
        goalRoute = current;
        break;
      }
      for (const edge of adjacency[current]) {
        if (seen.has(edge.next)) {
          continue;
        }
        seen.add(edge.next);
        parentByRoute.set(edge.next, { prev: current, viaAlias: edge.viaAlias });
        queue.push(edge.next);
      }
    }

    if (goalRoute === null) {
      const rejectionSummary = Object.entries(rejectedConnectorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(", ");
      const debugMessage =
        `token=${normalizedRouteToken}, candidates=${tokenCandidates.length}, edges=${connectorEdgeCount}, ` +
        `startRoutes=${startRoutes.length}, endRoutes=${endRouteSet.size}, ` +
        `preferredStart=${preferredStartSet.size}, preferredEnd=${preferredEndSet.size}, ` +
        `rejected=${rejectionSummary || "none"}`;
      if (_debugStats) {
        pushLimited(
          _debugStats.chainGraphSamples,
          `${_segmentReq ? `${_segmentReq.routeRef} ${_segmentReq.startLabel}->${_segmentReq.endLabel}` : normalizedRouteToken} ` +
            `| ${debugMessage} | sampleRejected: ${rejectedConnectorSamples.join(" ; ") || "none"}`,
          12
        );
      }
      return { matched: false, reason: "no_route_chain_found", debugMessage };
    }

    const routePath = [];
    const junctionAliases = [];
    let cursor = goalRoute;
    while (cursor !== null) {
      routePath.push(cursor);
      const parent = parentByRoute.get(cursor);
      if (!parent) {
        break;
      }
      junctionAliases.push(parent.viaAlias);
      cursor = parent.prev;
    }
    routePath.reverse();
    junctionAliases.reverse();

    let currentStartAlias = findFirstAliasPresent(
      routeEntries[routePath[0]].route.waypointIndex,
      startAliases
    );
    if (!currentStartAlias) {
      return { matched: false, reason: "start_alias_missing_on_chain_start" };
    }

    const allCoords = [];
    const routeSourceParts = [];
    for (let i = 0; i < routePath.length; i += 1) {
      const route = routeEntries[routePath[i]].route;
      const targetAlias =
        i === routePath.length - 1
          ? findFirstAliasPresent(route.waypointIndex, endAliases)
          : junctionAliases[i];
      if (!targetAlias) {
        return { matched: false, reason: "target_alias_missing_on_chain_route" };
      }
      const segmentCoords = extractSegmentCoordsByAlias(route, currentStartAlias, targetAlias);
      if (!segmentCoords || segmentCoords.length < 2) {
        const startIndex = route.waypointIndex.get(currentStartAlias);
        const endIndex = route.waypointIndex.get(targetAlias);
        const debugMessage =
          `route=${shortRouteSource(route.sourceName)}, startAlias=${currentStartAlias}, ` +
          `endAlias=${targetAlias}, startIndex=${String(startIndex)}, endIndex=${String(endIndex)}`;
        return { matched: false, reason: "chain_segment_geometry_not_found", debugMessage };
      }
      if (!allCoords.length) {
        allCoords.push(...segmentCoords);
      } else {
        allCoords.push(...segmentCoords.slice(1));
      }
      routeSourceParts.push(route.sourceName);
      currentStartAlias = targetAlias;
    }

    return {
      matched: true,
      route: routeEntries[routePath[0]].route,
      routeSource: routeSourceParts.join(" -> "),
      coords: allCoords,
    };
  }

  function extractSegmentCoordsByAlias(route, startAlias, endAlias) {
    const startIndex = route.waypointIndex.get(startAlias);
    const endIndex = route.waypointIndex.get(endAlias);
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
      return null;
    }
    return buildCoordsBetweenIndices(route.points, startIndex, endIndex);
  }

  function buildCoordsBetweenIndices(points, startIndex, endIndex) {
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    const slice = points.slice(minIndex, maxIndex + 1);
    if (slice.length < 2) {
      return null;
    }
    const ordered = startIndex <= endIndex ? slice : slice.slice().reverse();
    return ordered.map((p) => [p.lat, p.lon]);
  }

  function findSharedAlias(aliasesA, aliasesB) {
    const [small, large] =
      aliasesA.size <= aliasesB.size ? [aliasesA, aliasesB] : [aliasesB, aliasesA];

    for (const alias of small) {
      if (!large.has(alias)) {
        continue;
      }
      if (isHiddenWaypointAlias(alias)) {
        continue;
      }
      if (alias.includes("/")) {
        return alias;
      }
    }

    for (const alias of small) {
      if (large.has(alias) && !isHiddenWaypointAlias(alias)) {
        return alias;
      }
    }
    return null;
  }

  function findSharedAliasBetweenRoutes(routeA, routeB) {
    return findConnectorBetweenRoutes(routeA, routeB).alias;
  }

  function findConnectorBetweenRoutes(routeA, routeB) {
    const aliasesA = new Set(routeA.waypointIndex.keys());
    const aliasesB = new Set(routeB.waypointIndex.keys());
    let rawShared = 0;
    let nonHiddenShared = 0;
    for (const alias of aliasesA) {
      if (!aliasesB.has(alias)) {
        continue;
      }
      rawShared += 1;
      if (!isHiddenWaypointAlias(alias)) {
        nonHiddenShared += 1;
      }
    }
    if (!rawShared) {
      return { alias: null, reason: "no_shared_alias_text" };
    }
    if (!nonHiddenShared) {
      return { alias: null, reason: "only_hidden_shared_aliases" };
    }

    const sharedAlias = findSharedAlias(aliasesA, aliasesB);
    if (!sharedAlias) {
      return { alias: null, reason: "no_preferred_shared_alias" };
    }

    const aIdx = routeA.waypointIndex.get(sharedAlias);
    const bIdx = routeB.waypointIndex.get(sharedAlias);
    if (!Number.isInteger(aIdx) || !Number.isInteger(bIdx)) {
      return { alias: null, reason: "connector_alias_not_indexed" };
    }
    const aPt = routeA.points[aIdx];
    const bPt = routeB.points[bIdx];
    if (!aPt || !bPt) {
      return { alias: null, reason: "connector_point_missing" };
    }

    // Reject false joins where identical alias text is geographically distant.
    const dx = aPt.lat - bPt.lat;
    const dy = aPt.lon - bPt.lon;
    const distSquared = dx * dx + dy * dy;
    if (distSquared > 0.25) {
      return { alias: null, reason: "shared_alias_too_far" };
    }

    return { alias: sharedAlias, reason: null };
  }

  function findFirstAliasPresent(waypointIndex, aliases) {
    for (const alias of aliases) {
      const match = resolveAliasMatch(waypointIndex, alias);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function isHiddenWaypointAlias(alias) {
    return /^X\d+$/i.test(String(alias || "").trim());
  }

  function parseLineIntoSegments(tokens) {
    if (looksLikeRegionRouteWaypointChain(tokens)) {
      const points = [];
      for (let i = 0; i < tokens.length; i += 3) {
        const regionToken = String(tokens[i] || "").toUpperCase();
        points.push({
          regionToken,
          region: normalizeRegion(regionToken),
          routeToken: tokens[i + 1],
          waypoint: tokens[i + 2],
        });
      }

      const segments = [];
      for (let i = 0; i < points.length - 1; i += 1) {
        const start = points[i];
        const end = points[i + 1];
        segments.push({
          routeRef: `${start.regionToken} ${start.routeToken}`,
          startRegion: start.region,
          startRegionToken: start.regionToken,
          startRouteToken: start.routeToken,
          endRegion: end.region,
          endRegionToken: end.regionToken,
          endRouteToken: end.routeToken,
          startLabel: start.waypoint,
          endLabel: end.waypoint,
          fromChain: true,
        });
      }
      return segments;
    }

    const regionToken = String(tokens[0] || "").toUpperCase();
    const region = normalizeRegion(regionToken);
    const routeToken = tokens[1];
    const waypoints = tokens.slice(2);
    const segments = [];
    for (let i = 0; i < waypoints.length - 1; i += 1) {
      segments.push({
        routeRef: `${regionToken} ${routeToken}`,
        startRegion: region,
        startRegionToken: regionToken,
        startRouteToken: routeToken,
        endRegion: region,
        endRegionToken: regionToken,
        endRouteToken: routeToken,
        startLabel: waypoints[i],
        endLabel: waypoints[i + 1],
        fromChain: false,
      });
    }
    return segments;
  }

  function looksLikeRegionRouteWaypointChain(tokens) {
    if (!Array.isArray(tokens) || tokens.length < 6 || tokens.length % 3 !== 0) {
      return false;
    }
    for (let i = 0; i < tokens.length; i += 3) {
      const regionToken = String(tokens[i] || "").trim();
      if (!isLikelyRegionToken(regionToken) || !normalizeRegion(regionToken)) {
        return false;
      }
      if (!String(tokens[i + 1] || "").trim()) {
        return false;
      }
      if (!String(tokens[i + 2] || "").trim()) {
        return false;
      }
    }
    return true;
  }

  function isLikelyRegionToken(token) {
    return /^[A-Z]{2,4}(?:-[A-Z0-9]{2,5})?$/.test(String(token || "").trim().toUpperCase());
  }

  function drawSegments(segments) {
    if (state.traveledLayer) {
      map.removeLayer(state.traveledLayer);
      state.traveledLayer = null;
    }

    const layer = L.layerGroup();
    let bounds = null;

    for (const segment of segments) {
      const polyline = L.polyline(segment.coords, {
        color: "#0077ff",
        weight: 4,
        opacity: 0.9,
      }).bindPopup(
        `${segment.routeRef}<br>${segment.startLabel} -> ${segment.endLabel}<br>${segment.routeSource}`
      );

      polyline.addTo(layer);

      const polyBounds = polyline.getBounds();
      bounds = bounds ? bounds.extend(polyBounds) : polyBounds;
    }

    layer.addTo(map);
    state.traveledLayer = layer;

    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.1));
    }
  }

  function renderOutput(diagnostics, debugReport) {
    const lines = ["Diagnostics", "-----------"];

    if (diagnostics.length) {
      for (const item of diagnostics) {
        lines.push(`[${item.severity}] ${item.message}`);
      }
    } else {
      lines.push("No issues found.");
    }

    if (state.detailedDebugEnabled) {
      lines.push("");
      lines.push("Detailed Debug");
      lines.push("--------------");
      lines.push(debugReport || "No debug report generated yet.");
    }

    const text = lines.join("\n");
    state.lastOutputReport = text;
    if (els.outputLog) {
      els.outputLog.textContent = text;
    }
  }

  function buildDebugReport(username, routeKeys, loadMeta, result) {
    const lines = [];
    lines.push("=== TravelMappingUserMap Debug Report ===");
    lines.push(`username: ${username}`);
    lines.push(`requestedRouteKeys: ${routeKeys.size}`);
    if (loadMeta) {
      lines.push(`resolvedRouteKeys: ${loadMeta.resolvedRouteKeys}/${loadMeta.requestedRouteKeys}`);
      lines.push(`targetPathCount: ${loadMeta.targetPathCount}`);
      lines.push(`chainExpansionPathCount: ${loadMeta.chainExpansionPathCount || 0}`);
      lines.push(`fetchedPathCountThisRun: ${loadMeta.fetchedPathCount}`);
      lines.push(`indexedRegionsRequested: ${loadMeta.indexedRegionCount}`);
      lines.push(`newlyIndexedRegions: ${loadMeta.newlyIndexedRegions}`);
      if (loadMeta.missingRegions.length) {
        lines.push(`missingRegions: ${loadMeta.missingRegions.join(", ")}`);
      }
      if (loadMeta.unresolvedRouteKeys.length) {
        lines.push("unresolvedRouteKeys(sample):");
        for (const key of loadMeta.unresolvedRouteKeys.slice(0, 20)) {
          lines.push(`  - ${key}`);
        }
      }
    }
    lines.push(`routeFilesInMemory: ${state.allRoutes.length}`);
    lines.push(`parsedLines: ${result.stats.parsedLines}`);
    lines.push(`matchedSegments: ${result.segments.length}`);
    lines.push(`unmatchedLines: ${result.stats.unmatchedLines}`);
    lines.push(`parsedChainLines: ${result.stats.debug.chainLines}`);
    lines.push(`parsedStandardLines: ${result.stats.debug.standardLines}`);
    lines.push(`parsedSegmentRequests: ${result.stats.debug.parsedSegments}`);
    lines.push(
      `stitchAttempts: ${result.stats.debug.stitchAttempts}, stitchSuccesses: ${result.stats.debug.stitchSuccesses}`
    );
    lines.push("stitchFailureCounts:");
    const stitchFailureEntries = Object.entries(result.stats.debug.stitchFailureCounts).sort(
      (a, b) => b[1] - a[1]
    );
    if (!stitchFailureEntries.length) {
      lines.push("  - none");
    } else {
      for (const [reason, count] of stitchFailureEntries) {
        lines.push(`  - ${reason}: ${count}`);
      }
    }
    lines.push("chainLineSamples:");
    if (!result.stats.debug.chainLineSamples.length) {
      lines.push("  - none");
    } else {
      for (const sample of result.stats.debug.chainLineSamples) {
        lines.push(`  - ${sample}`);
      }
    }
    lines.push("segmentRequestSamples:");
    if (!result.stats.debug.segmentRequestSamples.length) {
      lines.push("  - none");
    } else {
      for (const sample of result.stats.debug.segmentRequestSamples) {
        lines.push(`  - ${sample}`);
      }
    }
    lines.push("stitchSamples:");
    if (!result.stats.debug.stitchSamples.length) {
      lines.push("  - none");
    } else {
      for (const sample of result.stats.debug.stitchSamples) {
        lines.push(`  - ${sample}`);
      }
    }
    lines.push("chainGraphSamples:");
    if (!result.stats.debug.chainGraphSamples.length) {
      lines.push("  - none");
    } else {
      for (const sample of result.stats.debug.chainGraphSamples) {
        lines.push(`  - ${sample}`);
      }
    }
    lines.push("chainGeometryFailureSamples:");
    if (!result.stats.debug.chainGeometryFailureSamples.length) {
      lines.push("  - none");
    } else {
      for (const sample of result.stats.debug.chainGeometryFailureSamples) {
        lines.push(`  - ${sample}`);
      }
    }
    lines.push("reasonCounts:");
    const reasonEntries = Object.entries(result.stats.reasonCounts).sort((a, b) => b[1] - a[1]);
    if (!reasonEntries.length) {
      lines.push("  - none");
    } else {
      for (const [reason, count] of reasonEntries) {
        lines.push(`  - ${reason}: ${count}`);
      }
    }
    lines.push("sampleFailures:");
    if (!result.stats.sampleFailures.length) {
      lines.push("  - none");
    } else {
      for (const failure of result.stats.sampleFailures) {
        lines.push(
          `  - line ${failure.lineNumber} ${failure.routeRef} ${failure.startLabel}->${failure.endLabel} (${failure.reason})`
        );
      }
    }
    return lines.join("\n");
  }

  function makeRouteKey(region, routeToken) {
    return `${normalizeRegion(region)}|${normalizeRoute(routeToken)}`;
  }

  function normalizeRouteKey(routeKey) {
    const [region = "", routeToken = ""] = String(routeKey || "").split("|");
    return makeRouteKey(region, routeToken);
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

    // Canonicalize all numeric runs so list tokens and route filenames align.
    value = value.replace(/\d+/g, (digits) => String(Number(digits)));
    return value;
  }

  function normalizeWaypoint(waypoint) {
    return String(waypoint || "")
      .trim()
      .replace(/^[+*]+/, "")
      .toUpperCase();
  }

  function buildWaypointAliases(label) {
    const raw = String(label || "").trim();
    if (!raw) {
      return [];
    }

    const aliases = new Set();
    const base = normalizeWaypoint(raw);
    if (!base) {
      return [];
    }
    aliases.add(base);

    const parenMatch = base.match(/^(.+)\(([^)]+)\)$/);
    if (parenMatch) {
      const outside = normalizeWaypoint(parenMatch[1]);
      const inside = normalizeWaypoint(parenMatch[2]);
      if (outside) {
        aliases.add(outside);
      }
      if (inside) {
        aliases.add(inside);
      }
    }

    if (base.includes("/")) {
      aliases.add(base.replace(/\//g, ""));
    }

    if (base.includes("_")) {
      const beforeUnderscore = normalizeWaypoint(base.split("_")[0]);
      if (beforeUnderscore) {
        aliases.add(beforeUnderscore);
      }
    }

    return Array.from(aliases);
  }

  function findFirstWaypointIndex(waypointIndex, aliases) {
    for (const alias of aliases) {
      const match = resolveAliasMatch(waypointIndex, alias);
      if (!match) {
        continue;
      }
      const idx = waypointIndex.get(match);
      if (Number.isInteger(idx)) {
        return idx;
      }
    }
    return null;
  }

  function resolveAliasMatch(waypointIndex, alias) {
    if (Number.isInteger(waypointIndex.get(alias))) {
      return alias;
    }
    if (String(alias || "").includes("/")) {
      const reciprocal = reciprocalSlashAlias(alias);
      if (reciprocal && Number.isInteger(waypointIndex.get(reciprocal))) {
        return reciprocal;
      }
    }
    return null;
  }

  function reciprocalSlashAlias(alias) {
    const parts = String(alias || "")
      .split("/")
      .map((part) => normalizeWaypoint(part))
      .filter(Boolean);
    if (parts.length !== 2) {
      return "";
    }
    return `${parts[1]}/${parts[0]}`;
  }

  function incrementCount(counter, key) {
    counter[key] = (counter[key] || 0) + 1;
  }

  function pushSampleFailure(sampleFailures, entry) {
    const limit = 40;
    if (sampleFailures.length < limit) {
      sampleFailures.push(entry);
    }
  }

  function pushLimited(target, value, limit) {
    if (target.length < limit) {
      target.push(value);
    }
  }

  function shortRouteSource(sourceName) {
    const parts = String(sourceName || "").split("/");
    return parts.slice(-2).join("/");
  }

  const urlUsername = getUrlUserParam();
  if (urlUsername) {
    if (els.usernameInput) {
      els.usernameInput.value = urlUsername;
    }
    if (els.processBtn) {
      setTimeout(() => {
        els.processBtn.click();
      }, 0);
    }
  }
})();
