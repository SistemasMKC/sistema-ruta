(() => {
  const KEY = 'rutas_driver_token';
  let token = null, orders = [], map, lStops, lRoute, meMarker, me = null;
  let watchId = null, tracking = false, lastPing = 0, wake = null, routeSig = '', pollTimer = null;
  let current = null, photoData = null;

  const getTok = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const setTok = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* sin almacenamiento */ } };

  // ---------------- Sesión ----------------
  function init() {
    token = getTok();
    token ? enter() : showLogin();
  }
  function showLogin() {
    $('#login').classList.remove('hidden'); $('#app').classList.add('hidden');
    stopGps(); clearInterval(pollTimer);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    const { data, error } = await sb.rpc('driver_login', { p_pin: $('#pin').value.trim() });
    if (error || !data) { $('#loginErr').textContent = 'PIN incorrecto'; return; }
    token = data.token; setTok(token); $('#pin').value = '';
    $('#login').classList.add('hidden');
    enter();
  });

  $('#outBtn').addEventListener('click', () => { setTok(null); token = null; location.reload(); });

  async function enter() {
    $('#app').classList.remove('hidden');
    if (!map) {
      map = makeMap('dmap', CFG.DEPOT, 13);
      lStops = L.layerGroup().addTo(map);
      lRoute = L.layerGroup().addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 100);
    const ok = await refresh();
    if (ok) pollTimer = setInterval(refresh, 15000);
  }

  // ---------------- Pedidos ----------------
  async function refresh() {
    const { data, error } = await sb.rpc('driver_orders', { p_token: token });
    if (error) { toast('Sin conexión, reintentando…', true); return true; }
    if (!data) { toast('Tu sesión se cerró. Ingresa de nuevo.', true); setTok(null); token = null; showLogin(); return false; }
    $('#who').textContent = data.driver.name;
    orders = data.orders;
    render();
    return true;
  }

  const pendingStops = () => orders.filter((o) => o.status === 'assigned');

  function render() {
    const pend = pendingStops(), done = orders.filter((o) => o.status !== 'assigned');
    let html = '';
    if (!pend.length) html += '<p class="empty">🎉 No tienes entregas pendientes</p>';
    pend.forEach((o, i) => { html += stopCard(o, i === 0); });
    if (done.length) html += `<h3 style="margin:18px 0 8px;font-size:14px;color:var(--muted)">Cerradas hoy (${done.length})</h3>` + done.map((o) => stopCard(o, false)).join('');
    $('#stopList').innerHTML = html;
    $('#reoptBtn').classList.toggle('hidden', pend.length < 2);
    drawMap();
  }

  function stopCard(o, next) {
    const fin = o.status !== 'assigned';
    const nav = navLinks(o);
    return `<article class="stop ${next ? 'next' : ''} ${fin ? 'done' : ''}" data-id="${o.id}">
      <h3><span class="seq">${fin ? (o.status === 'delivered' ? '✓' : '✕') : (o.seq ?? '·')}</span>${esc(o.customer_name)}</h3>
      <div>${esc(o.address)}</div>
      ${o.notes ? `<div class="hint" style="color:var(--amber)">📝 ${esc(o.notes)}</div>` : ''}
      ${fin ? `<small>${o.status === 'delivered' ? 'Entregado' : 'No entregado: ' + esc(o.fail_reason || '')}${o.finished_at ? ' · ' + hhmm(o.finished_at) : ''}</small>` : `
      <div class="btns">
        <a href="${nav.gmaps}" target="_blank" rel="noopener">📍 Google Maps</a>
        <a href="${nav.waze}" target="_blank" rel="noopener">🚗 Waze</a>
        ${o.phone ? `<a href="tel:${esc(o.phone)}">📞 Llamar</a>` : '<span></span>'}
        <button data-act="focus">🔎 Ver en mapa</button>
        <button class="ok" data-act="done">✔ Entregado</button>
        <button class="bad" data-act="fail">✕ No entregado</button>
      </div>`}
    </article>`;
  }

  async function drawMap() {
    lStops.clearLayers();
    const pend = pendingStops();
    pend.forEach((o) => L.marker([o.lat, o.lng], { icon: pinIcon(o.seq ?? '·') }).bindTooltip(esc(o.customer_name)).addTo(lStops));
    const sig = pend.map((o) => o.id).join(',') + (me ? '1' : '0');
    if (sig === routeSig) return;
    routeSig = sig;
    lRoute.clearLayers();
    if (!pend.length) return;
    const start = me || CFG.DEPOT;
    const r = await osrmRoute([start, ...pend]);
    const line = L.polyline(r.coords.map((c) => [c[1], c[0]]), { weight: 5, opacity: .85, dashArray: r.fallback ? '6 8' : null }).addTo(lRoute);
    map.fitBounds(line.getBounds(), { padding: [30, 30] });
  }

  $('#stopList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const o = orders.find((x) => x.id === b.closest('.stop').dataset.id); if (!o) return;
    if (b.dataset.act === 'focus') { map.setView([o.lat, o.lng], 17); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else openDone(o, b.dataset.act === 'fail');
  });

  // ---------------- Cierre de entrega ----------------
  function openDone(o, failed) {
    current = { o, failed }; photoData = null;
    $('#doneTitle').textContent = failed ? 'Entrega fallida' : 'Confirmar entrega';
    $('#doneAddr').textContent = `${o.customer_name} · ${o.address}`;
    $('#failBox').classList.toggle('hidden', !failed);
    $('#photo').value = ''; $('#preview').classList.add('hidden');
    $('#doneOk').className = failed ? 'bad' : 'ok';
    $('#doneDlg').showModal();
  }
  $('#doneCancel').addEventListener('click', () => $('#doneDlg').close());

  // Reduce la foto (≈30-60 KB) para no gastar datos ni espacio.
  function shrink(file, max = 640, q = 0.6) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', q));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  $('#photo').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { photoData = await shrink(f); $('#preview').src = photoData; $('#preview').classList.remove('hidden'); }
    catch { toast('No se pudo leer la foto', true); }
  });

  $('#doneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!current) return;
    const btn = $('#doneOk'); btn.disabled = true;
    const { data, error } = await sb.rpc('driver_update_order', {
      p_token: token, p_order_id: current.o.id,
      p_status: current.failed ? 'failed' : 'delivered',
      p_reason: current.failed ? $('#reason').value : null,
      p_photo: photoData
    });
    btn.disabled = false;
    if (error || !data) return toast('No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.', true);
    $('#doneDlg').close();
    toast(current.failed ? 'Marcado como no entregado' : '¡Entrega registrada!');
    routeSig = '';
    refresh();
  });

  // ---------------- Reoptimizar ----------------
  $('#reoptBtn').addEventListener('click', async () => {
    const pend = pendingStops();
    if (pend.length < 2) return;
    if (!me) return toast('Activa "Iniciar ruta" para conocer tu ubicación', true);
    $('#reoptBtn').disabled = true;
    const res = await osrmTrip(me, pend);
    const { error } = await sb.rpc('driver_set_route', { p_token: token, p_ids: res.order.map((s) => s.id) });
    $('#reoptBtn').disabled = false;
    if (error) return toast('No se pudo guardar el nuevo orden', true);
    toast(res.fallback ? 'Ordenado por cercanía (el servidor de rutas no respondió)' : 'Ruta reoptimizada');
    routeSig = '';
    refresh();
  });

  // ---------------- GPS ----------------
  async function lockScreen() {
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch { /* opcional */ }
  }
  document.addEventListener('visibilitychange', () => { if (tracking && document.visibilityState === 'visible') lockScreen(); });

  function startGps() {
    if (!('geolocation' in navigator)) return toast('Este dispositivo no tiene GPS', true);
    tracking = true; lastPing = 0;
    $('#gpsBtn').textContent = 'Terminar ruta'; $('#gpsBtn').classList.remove('primary');
    $('#gpsTxt').textContent = 'Buscando señal…';
    watchId = navigator.geolocation.watchPosition(onPos, onGpsErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 25000 });
    lockScreen();
  }
  function stopGps() {
    tracking = false;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    try { wake && wake.release(); } catch { /* nada */ }
    wake = null;
    $('#gpsBtn').textContent = 'Iniciar ruta'; $('#gpsBtn').classList.add('primary');
    $('#gpsDot').classList.remove('live'); $('#gpsTxt').textContent = 'GPS apagado';
  }
  $('#gpsBtn').addEventListener('click', () => (tracking ? stopGps() : startGps()));

  function onPos(p) {
    const first = !me;
    me = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (!meMarker) meMarker = L.marker([me.lat, me.lng], { icon: bikeIcon('Yo'), zIndexOffset: 1000 }).addTo(map);
    else meMarker.setLatLng([me.lat, me.lng]);
    if (first) { routeSig = ''; drawMap(); }
    const now = Date.now();
    if (now - lastPing >= CFG.GPS_INTERVAL_MS) {
      lastPing = now;
      sb.rpc('driver_ping', { p_token: token, p_lat: me.lat, p_lng: me.lng, p_speed: p.coords.speed, p_heading: p.coords.heading })
        .then(({ data, error }) => {
          if (error) { $('#gpsDot').classList.remove('live'); $('#gpsTxt').textContent = 'Sin conexión'; }
          else if (!data) { toast('Sesión vencida', true); setTok(null); showLogin(); }
          else { $('#gpsDot').classList.add('live'); $('#gpsTxt').textContent = 'Compartiendo ubicación'; }
        });
    }
  }
  function onGpsErr(err) {
    $('#gpsDot').classList.remove('live');
    $('#gpsTxt').textContent = err.code === 1 ? 'Permiso de ubicación denegado' : 'Sin señal GPS';
    if (err.code === 1) stopGps();
  }

  init();
})();
