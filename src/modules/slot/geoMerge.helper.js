// src/modules/slot/geoMerge.helper.js

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function validNum(n) {
  return Number.isFinite(n) && n !== 0;
}
export function resolveMergeKeyByRadius(existingMergeSlots, newLat, newLng, radiusKm = 25) {
  const latN = Number(newLat);
  const lngN = Number(newLng);

  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return { mergeKey: "UNKNOWN", blink: false };
  }

  // ✅ ignore (0,0)
  if (Math.abs(latN) < 0.0001 && Math.abs(lngN) < 0.0001) {
    return { mergeKey: "UNKNOWN", blink: false };
  }

  let best = null;
  let bestDist = Infinity;

  for (const m of existingMergeSlots || []) {
    const lat = Number(m.lat);
    const lng = Number(m.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) continue;

    const d = haversineKm(latN, lngN, lat, lng);
    if (d <= radiusKm && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }

  if (!best) {
    return {
      mergeKey: `GEO_${latN.toFixed(4)}_${lngN.toFixed(4)}`,
      blink: false,
    };
  }

  return {
    mergeKey: best.mergeKey || `GEO_${Number(best.lat).toFixed(4)}_${Number(best.lng).toFixed(4)}`,
    blink: true,
    distanceKm: Number(bestDist.toFixed(2)),
  };
}
