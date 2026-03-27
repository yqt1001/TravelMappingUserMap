self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== "load") {
    return;
  }

  try {
    const candidates = Array.isArray(msg.candidates) ? msg.candidates : [];
    const chunkSize = Number.isInteger(msg.chunkSize) && msg.chunkSize > 0 ? msg.chunkSize : 200;

    let response = null;
    let sourcePath = "";
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.url !== "string") {
        continue;
      }
      const res = await fetch(candidate.url);
      if (res.status === 404) {
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `TMG user JSON for ${candidate.name || "user"} failed to load (HTTP ${res.status || "unknown"}).`
        );
      }
      response = res;
      sourcePath = candidate.url;
      break;
    }

    if (!response) {
      self.postMessage({ type: "not_found" });
      return;
    }

    const body = await response.json();
    validateCompactPayload(body, sourcePath);

    const q = Number(body.q || 100000);
    const pathsRaw = Array.isArray(body.paths) ? body.paths : [];
    const total = pathsRaw.length;
    const username = String(body.user || "");

    self.postMessage({
      type: "meta",
      username,
      sourcePath,
      travelerIndex: Number.isInteger(body.travelerIndex) ? body.travelerIndex : null,
      stats: body.stats && typeof body.stats === "object" ? body.stats : {},
      totalPaths: total,
      q,
    });

    let processed = 0;
    for (let i = 0; i < pathsRaw.length; i += chunkSize) {
      const chunk = pathsRaw.slice(i, i + chunkSize);
      const decoded = [];
      for (const flat of chunk) {
        if (!Array.isArray(flat) || flat.length < 4) {
          continue;
        }
        decoded.push(decodeFlatPath(flat, q));
      }
      processed += chunk.length;
      self.postMessage({
        type: "chunk",
        paths: decoded,
        processed,
        total,
      });
    }

    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error && error.message ? error.message : "Unknown worker error.",
    });
  }
};

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
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const lat = Number(flat[i]) / q;
    const lon = Number(flat[i + 1]) / q;
    out.push([lat, lon]);
  }
  return out;
}
