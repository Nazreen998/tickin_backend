// src/modules/slot/geoMerge.helper.js

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;

  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function resolveMergeKeyByRadius(existingMergeSlots, newLat, newLng, radiusKm = 25) {
  if (newLat == null || newLng == null) {
    return { mergeKey: "UNKNOWN", blink: false };
  }

  let best = null;
  let bestDist = 999999;

  for (const m of existingMergeSlots || []) {
    const lat = Number(m.lat);
    const lng = Number(m.lng);

    if (!lat || !lng) continue;

    const d = haversineKm(newLat, newLng, lat, lng);
    if (d <= radiusKm && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }

  if (!best) {
    // new merge slot group
    return {
      mergeKey: `GEO_${newLat.toFixed(4)}_${newLng.toFixed(4)}`,
      blink: false,
    };
  }

  return {
    mergeKey: best.mergeKey || best.locationBucket || "UNKNOWN",
    blink: true,
  };
}
