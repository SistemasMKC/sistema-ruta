// Utilidades compartidas por las tres pantallas
const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 5 } }
});

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError = false) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' err' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3500);
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

// ---------- Geometría ----------
function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Respaldo si OSRM no responde: ordena por vecino más cercano.
function nearestNeighbor(origin, stops) {
  const left = [...stops], out = [];
  let cur = origin;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = haversine(cur, s); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

async function fetchJson(url, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const lngLat = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

// Mejor orden de visita (problema del viajante) con OSRM /trip.
// El primer punto es el origen fijo; el recorrido se calcula como circuito.
async function osrmTrip(origin, stops) {
  if (stops.length < 2) return { order: [...stops], fallback: false };
  try {
    const coords = [origin, ...stops].map(lngLat).join(';');
    const j = await fetchJson(`${CFG.OSRM_URL}/trip/v1/driving/${coords}?source=first&roundtrip=true&overview=false`);
    if (j.code !== 'Ok') throw new Error(j.code);
    const order = stops
      .map((s, i) => ({ s, pos: j.waypoints[i + 1].waypoint_index }))
      .sort((a, b) => a.pos - b.pos)
      .map((x) => x.s);
    return { order, fallback: false };
  } catch (e) {
    console.warn('OSRM trip falló, usando vecino más cercano', e);
    return { order: nearestNeighbor(origin, stops), fallback: true };
  }
}

// Geometría y duración de cada tramo siguiendo el orden dado.
async function osrmRoute(points) {
  const straight = { coords: points.map((p) => [p.lng, p.lat]), legs: [], fallback: true };
  if (points.length < 2) return straight;
  try {
    const j = await fetchJson(`${CFG.OSRM_URL}/route/v1/driving/${points.map(lngLat).join(';')}?overview=full&geometries=geojson`);
    if (j.code !== 'Ok') throw new Error(j.code);
    const r = j.routes[0];
    return { coords: r.geometry.coordinates, legs: r.legs.map((l) => l.duration), distance: r.distance, duration: r.duration, fallback: false };
  } catch (e) {
    console.warn('OSRM route falló', e);
    return straight;
  }
}

// ---------- Mapa ----------
function makeMap(elId, center, zoom = 13) {
  const map = L.map(elId, { zoomControl: true }).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  return map;
}

function pinIcon(label, cls = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${cls}"><span>${esc(label)}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 15]
  });
}

function bikeIcon(name) {
  return L.divIcon({
    className: '',
    html: `<div class="bike">🏍️<em>${esc(name)}</em></div>`,
    iconSize: [40, 40], iconAnchor: [20, 20]
  });
}

function navLinks(o) {
  return {
    gmaps: `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${o.lat},${o.lng}&navigate=yes`
  };
}
