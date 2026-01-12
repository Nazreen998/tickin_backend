// src/slot/geoMerge.helper.js

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;

  const lat1N = Number(lat1);
  const lng1N = Number(lng1);
  const lat2N = Number(lat2);
  const lng2N = Number(lng2);

  // If invalid numbers, return Infinity so callers can treat it as "too far/invalid"
  if (
    !Number.isFinite(lat1N) ||
    !Number.isFinite(lng1N) ||
    !Number.isFinite(lat2N) ||
    !Number.isFinite(lng2N)
  ) {
    return Infinity;
  }

  const dLat = toRad(lat2N - lat1N);
  const dLng = toRad(lng2N - lng1N);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1N)) *
      Math.cos(toRad(lat2N)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Basic validation for lat/lng */
export function validateLatLng(lat, lng) {
  const latN = Number(lat);
  const lngN = Number(lng);

  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return { ok: false, lat: null, lng: null };
  if (latN === 0 || lngN === 0) return { ok: false, lat: null, lng: null };

  // Optional: strict range check
  if (latN < -90 || latN > 90) return { ok: false, lat: null, lng: null };
  if (lngN < -180 || lngN > 180) return { ok: false, lat: null, lng: null };

  return { ok: true, lat: latN, lng: lngN };
}

/**
 * Driver reached check:
 * - returns { ok:true, reached:true/false, distanceKm, message }
 * - if distributor location missing => ok:false with message
 */
export function checkReachedByRadius(
  driverLat,
  driverLng,
  distributorLat,
  distributorLng,
  radiusKm = 50
) {
  const d = validateLatLng(driverLat, driverLng);
  if (!d.ok) {
    return { ok: false, reached: false, distanceKm: null, message: "Driver location missing or invalid" };
  }

  const s = validateLatLng(distributorLat, distributorLng);
  if (!s.ok) {
    return { ok: false, reached: false, distanceKm: null, message: "Distributor location missing or invalid" };
  }

  const dist = haversineKm(d.lat, d.lng, s.lat, s.lng);

  // Infinity safety
  if (!Number.isFinite(dist)) {
    return { ok: false, reached: false, distanceKm: null, message: "Distance calculation failed" };
  }

  const distanceKm = Number(dist.toFixed(2));
  const reached = dist <= Number(radiusKm);

  return {
    ok: true,
    reached,
    distanceKm,
    message: reached ? "Reached" : "Try again",
  };
}

function extractMergeKey(m) {
  if (!m) return null;
  if (m.mergeKey) return String(m.mergeKey);

  const sk = String(m.sk || "");
  const parts = sk.split("#KEY#");
  if (parts.length > 1) return parts[1];
  return null;
}

export function resolveMergeKeyByRadius(existingMergeSlots, newLat, newLng, radiusKm = 25) {
  const v = validateLatLng(newLat, newLng);
  if (!v.ok) return { mergeKey: "UNKNOWN", distanceKm: null };

  const { lat: latN, lng: lngN } = v;

  let best = null;
  let bestDist = Infinity;

  for (const m of existingMergeSlots || []) {
    const mm = validateLatLng(m.lat, m.lng);
    if (!mm.ok) continue;

    const d = haversineKm(latN, lngN, mm.lat, mm.lng);
    if (d <= radiusKm && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }

  if (!best) {
    return {
      mergeKey: `GEO_${latN.toFixed(4)}_${lngN.toFixed(4)}`,
      distanceKm: null,
    };
  }

  const mk =
    extractMergeKey(best) || `GEO_${Number(best.lat).toFixed(4)}_${Number(best.lng).toFixed(4)}`;

  return {
    mergeKey: mk,
    distanceKm: Number(bestDist.toFixed(2)),
  };
}
