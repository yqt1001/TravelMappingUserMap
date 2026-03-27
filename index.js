/* global L */

(function main() {
  const LOCAL_TMG_USER_BASE_URL = "data/tmg-users";
  const LOADER_WORKER_URL = "./tmg-user-loader-worker.js";
  const URL_USER_PARAM = "user";

  const state = {
    traveledLayer: null,
    lastOutputReport: "",
    isBusy: false,
    lastLoadedUser: "",
    activeLoadToken: 0,
    activeLoadedMeta: null,
  };

  const els = {
    usernameInput: document.getElementById("usernameInput"),
    processBtn: document.getElementById("processBtn"),
    reloadHighwayBtn: document.getElementById("reloadHighwayBtn"),
    copyDebugBtn: document.getElementById("copyDebugBtn"),
    summary: document.getElementById("summary"),
    outputLog: document.getElementById("outputLog"),
    mapStatusOverlay: document.getElementById("mapStatusOverlay"),
  };

  const lineRenderer = L.canvas({ padding: 0.25 });
  const map = L.map("map").setView([35, -95], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);

  if (els.usernameInput) {
    els.usernameInput.value = "";
  }

  let overlayHideTimer = null;

  if (els.reloadHighwayBtn) {
    els.reloadHighwayBtn.addEventListener("click", async () => {
      const username = (els.usernameInput && els.usernameInput.value
        ? els.usernameInput.value
        : state.lastLoadedUser
      ).trim();
      if (!username) {
        setHighwayStatus("Enter a username first.");
        return;
      }
      if (els.processBtn) {
        els.processBtn.click();
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

  if (els.processBtn) {
    els.processBtn.addEventListener("click", async () => {
      try {
        setUiBusy(true);
        renderOutput([], "");

        const username = (els.usernameInput && els.usernameInput.value
          ? els.usernameInput.value
          : ""
        ).trim();
        if (!username) {
          if (els.summary) {
            els.summary.textContent = "Please enter a Travel Mapping username.";
          }
          renderOutput([{ severity: "error", message: "Username is required." }], "");
          return;
        }

        const loaded = await loadAndRenderUser(username);
        if (!loaded) {
          const message = `No local TMG user JSON found for "${username}".`;
          if (els.summary) {
            els.summary.textContent = message;
          }
          renderOutput([{ severity: "error", message }], "");
          setHighwayStatus(`No local TMG user JSON found for ${username}.`);
          return;
        }

        renderSuccessOutput(loaded.username);

        if (els.summary) {
          els.summary.textContent =
            `Username: ${loaded.username}\n` +
            `Rendered paths: ${loaded.renderedPaths}\n` +
            `Raw merged paths: ${loaded.totalPaths}`;
        }

        state.lastLoadedUser = loaded.username;
        state.activeLoadedMeta = loaded;
        updateUrlUserParam(loaded.username);
        setHighwayStatus(`Ready: ${loaded.renderedPaths} paths mapped`);
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

  async function loadAndRenderUser(username) {
    state.activeLoadToken += 1;
    const loadToken = state.activeLoadToken;
    clearDrawnLayer();

    const candidates = buildUserCandidates(username);
    if (window.Worker) {
      return loadViaWorker(candidates, loadToken);
    }
    return loadOnMainThread(candidates, loadToken);
  }

  function buildUserCandidates(username) {
    const names = [String(username || "").trim(), String(username || "").trim().toLowerCase()];
    const seen = new Set();
    const out = [];
    for (const name of names) {
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      out.push({
        name,
        url: `${LOCAL_TMG_USER_BASE_URL}/${encodeURIComponent(name)}.json`,
      });
    }
    return out;
  }

  async function loadViaWorker(candidates, loadToken) {
    setHighwayStatus("Loading user data (worker)...");
    const worker = new Worker(LOADER_WORKER_URL);
    const layer = L.layerGroup().addTo(map);
    state.traveledLayer = layer;

    let bounds = null;
    let renderedPaths = 0;
    let meta = null;

    return new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (loadToken !== state.activeLoadToken) {
          worker.terminate();
          resolve(null);
          return;
        }

        if (msg.type === "not_found") {
          worker.terminate();
          clearDrawnLayer();
          resolve(null);
          return;
        }

        if (msg.type === "error") {
          worker.terminate();
          clearDrawnLayer();
          reject(new Error(String(msg.message || "Worker load failed.")));
          return;
        }

        if (msg.type === "meta") {
          meta = {
            username: String(msg.username || ""),
            sourcePath: String(msg.sourcePath || ""),
            travelerIndex: Number.isInteger(msg.travelerIndex) ? msg.travelerIndex : null,
            stats: msg.stats && typeof msg.stats === "object" ? msg.stats : {},
            totalPaths: Number(msg.totalPaths || 0),
            q: Number(msg.q || 100000),
          };
          setHighwayStatus(`Decoding geometry: 0/${meta.totalPaths}`);
          return;
        }

        if (msg.type === "chunk") {
          const paths = Array.isArray(msg.paths) ? msg.paths : [];
          for (const coords of paths) {
            if (!Array.isArray(coords) || coords.length < 2) {
              continue;
            }
            const polyline = L.polyline(coords, {
              renderer: lineRenderer,
              color: "#0077ff",
              weight: 3,
              opacity: 0.9,
            });
            polyline.addTo(layer);
            const polyBounds = polyline.getBounds();
            bounds = bounds ? bounds.extend(polyBounds) : polyBounds;
            renderedPaths += 1;
          }
          setHighwayStatus(`Decoding geometry: ${msg.processed}/${msg.total}`);
          return;
        }

        if (msg.type === "done") {
          worker.terminate();
          if (bounds && bounds.isValid()) {
            map.fitBounds(bounds.pad(0.1));
          }
          resolve({
            username: (meta && meta.username) || candidates[0].name,
            sourcePath: (meta && meta.sourcePath) || candidates[0].url,
            travelerIndex: meta ? meta.travelerIndex : null,
            stats: meta ? meta.stats : {},
            totalPaths: meta ? meta.totalPaths : renderedPaths,
            renderedPaths,
          });
        }
      };

      worker.onerror = (error) => {
        worker.terminate();
        clearDrawnLayer();
        reject(new Error(error && error.message ? error.message : "Worker crashed."));
      };

      worker.postMessage({
        type: "load",
        candidates,
        chunkSize: 250,
      });
    });
  }

  async function loadOnMainThread(candidates, loadToken) {
    setHighwayStatus("Loading user data...");
    let response = null;
    let sourcePath = "";
    let username = "";

    for (const candidate of candidates) {
      const res = await fetch(candidate.url);
      if (res.status === 404) {
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `TMG user JSON for ${candidate.name} failed to load (HTTP ${res.status || "unknown"}).`
        );
      }
      response = res;
      sourcePath = candidate.url;
      username = candidate.name;
      break;
    }
    if (!response) {
      return null;
    }

    const body = await response.json();
    validateCompactPayload(body, sourcePath);

    if (loadToken !== state.activeLoadToken) {
      return null;
    }

    const q = Number(body.q || 100000);
    const rawPaths = Array.isArray(body.paths) ? body.paths : [];
    const layer = L.layerGroup().addTo(map);
    state.traveledLayer = layer;
    let bounds = null;
    let renderedPaths = 0;

    const batchSize = 200;
    for (let i = 0; i < rawPaths.length; i += batchSize) {
      if (loadToken !== state.activeLoadToken) {
        return null;
      }
      const chunk = rawPaths.slice(i, i + batchSize);
      for (const flat of chunk) {
        const coords = decodeFlatPath(flat, q);
        if (coords.length < 2) {
          continue;
        }
        const polyline = L.polyline(coords, {
          renderer: lineRenderer,
          color: "#0077ff",
          weight: 3,
          opacity: 0.9,
        });
        polyline.addTo(layer);
        const polyBounds = polyline.getBounds();
        bounds = bounds ? bounds.extend(polyBounds) : polyBounds;
        renderedPaths += 1;
      }
      setHighwayStatus(`Decoding geometry: ${Math.min(i + batchSize, rawPaths.length)}/${rawPaths.length}`);
      await nextFrame();
    }

    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.1));
    }

    return {
      username: String(body.user || username),
      sourcePath,
      travelerIndex: Number.isInteger(body.travelerIndex) ? body.travelerIndex : null,
      stats: body.stats && typeof body.stats === "object" ? body.stats : {},
      totalPaths: rawPaths.length,
      renderedPaths,
    };
  }

  function validateCompactPayload(body, sourcePath) {
    if (!body || typeof body !== "object") {
      throw new Error(`Invalid JSON object in ${sourcePath}`);
    }
    if (Number(body.v) !== 2 || String(body.fmt || "") !== "tmg-user-compact") {
      throw new Error(
        `Unsupported TMG user JSON format in ${sourcePath}. Regenerate with build-tmg-user-json.mjs.`
      );
    }
    if (!Array.isArray(body.paths)) {
      throw new Error(`Missing paths array in ${sourcePath}`);
    }
  }

  function decodeFlatPath(flat, q) {
    if (!Array.isArray(flat) || flat.length < 4) {
      return [];
    }
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out.push([Number(flat[i]) / q, Number(flat[i + 1]) / q]);
    }
    return out;
  }

  function clearDrawnLayer() {
    if (state.traveledLayer) {
      map.removeLayer(state.traveledLayer);
      state.traveledLayer = null;
    }
  }

  function nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
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
    if (!els.mapStatusOverlay) {
      return;
    }
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

  function setUiBusy(isBusy) {
    state.isBusy = isBusy;
    if (!els.processBtn) {
      return;
    }
    els.processBtn.disabled = isBusy;
    els.processBtn.textContent = isBusy ? "Building Map..." : "Build Map";
  }

  function renderOutput(diagnostics) {
    const lines = ["Diagnostics", "-----------"];
    if (diagnostics.length) {
      for (const item of diagnostics) {
        lines.push(`[${item.severity}] ${item.message}`);
      }
    } else {
      lines.push("No issues found.");
    }

    const text = lines.join("\n");
    state.lastOutputReport = text;
    if (els.outputLog) {
      els.outputLog.textContent = text;
    }
  }

  function renderSuccessOutput(username) {
    const safeUser = String(username || "").trim() || "unknown";
    const encodedUser = encodeURIComponent(safeUser);
    const logUrl = `https://travelmapping.net/logs/users/${encodedUser}.log`;
    const reportText =
      "All good! :)\n" +
      "Data is pulled from TravelMapping processed graph file. " +
      `Issues generating that file can be found in ${safeUser}.log (${logUrl})`;
    state.lastOutputReport = reportText;

    if (els.outputLog) {
      els.outputLog.textContent = "";
      els.outputLog.append("All good! :)");
      els.outputLog.append(document.createElement("br"));
      els.outputLog.append(
        "Data is pulled from the TravelMapping master graph file which is generated daily. Errors generating that file can be found in "
      );
      const anchor = document.createElement("a");
      anchor.href = logUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = `${safeUser}.log`;
      els.outputLog.append(anchor);
      els.outputLog.append(".");
    }
  }

  const urlUsername = getUrlUserParam();
  if (urlUsername && els.usernameInput) {
    els.usernameInput.value = urlUsername;
    if (els.processBtn) {
      setTimeout(() => {
        els.processBtn.click();
      }, 0);
    }
  }
})();
