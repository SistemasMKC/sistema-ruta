(() => {
  const LABEL = { pending: 'Sin asignar', assigned: 'En ruta', delivered: 'Entregado', failed: 'No entregado' };
  const COLS = 'id,order_no,customer_name,phone,address,lat,lng,notes,status,driver_id,seq,track_token,fail_reason,has_proof,finished_at,created_at';
  const state = { orders: [], drivers: [], locs: {}, sel: null, etas: {}, routeSig: '', draft: null };
  let map, lOrders, lDrivers, lRoute, depotMarker, draftMarker, started = false;

  // ---------------- Sesión ----------------
  async function init() {
    $('#oCity').innerHTML = CFG.CITIES.map((c) => `<option>${esc(c)}</option>`).join('');
    $('#driverUrl').textContent = new URL('driver.html', location.href).href;
    const { data } = await sb.auth.getSession();
    data.session ? start() : showLogin();
  }
  function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#pass').value });
    if (error) { $('#loginErr').textContent = 'Correo o clave incorrectos'; return; }
    $('#login').classList.add('hidden');
    start();
  });
  $('#logout').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

  async function start() {
    $('#app').classList.remove('hidden');
    if (started) return;
    started = true;
    map = makeMap('map', CFG.DEPOT, 12);
    lOrders = L.layerGroup().addTo(map);
    lDrivers = L.layerGroup().addTo(map);
    lRoute = L.layerGroup().addTo(map);
    depotMarker = L.marker([CFG.DEPOT.lat, CFG.DEPOT.lng], { icon: pinIcon('🏠', 'depot'), title: CFG.DEPOT.name }).addTo(map);
    depotMarker.bindTooltip(CFG.DEPOT.name);
    map.on('click', (e) => { if ($('#newOrderCard').open) setDraft(e.latlng.lat, e.latlng.lng); });

    await load();
    sb.channel('rutas-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, debounce(load, 400))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_locations' }, (p) => {
        if (p.new && p.new.driver_id) { state.locs[p.new.driver_id] = p.new; renderDrivers(); }
      })
      .subscribe();
    setInterval(load, 30000);            // respaldo si el realtime se cae
    setInterval(renderDrivers, 10000);   // refresca "hace X s"
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------------- Datos ----------------
  async function load() {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const [o, d, l] = await Promise.all([
      sb.from('orders').select(COLS).or(`status.in.(pending,assigned),finished_at.gte.${since.toISOString()}`).order('created_at'),
      sb.from('drivers').select('id,name,active').order('name'),
      sb.from('driver_locations').select('*')
    ]);
    const err = o.error || d.error || l.error;
    if (err) return toast('Error al cargar: ' + err.message, true);
    state.orders = o.data; state.drivers = d.data;
    state.locs = Object.fromEntries(l.data.map((x) => [x.driver_id, x]));
    render();
  }

  const assignedOf = (did) => state.orders.filter((o) => o.driver_id === did && o.status === 'assigned').sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9));

  // ---------------- Render ----------------
  function render() { renderList(); renderMap(); renderDrivers(); renderDriverTab(); maybeRedrawRoute(); }

  function rowHtml(o, withCheck) {
    const eta = state.etas[o.id];
    const acts = [];
    if (o.status === 'assigned') acts.push(`<button class="small" data-act="unassign" title="Quitar de la ruta">↩</button>`);
    if (o.has_proof) acts.push(`<button class="small" data-act="proof" title="Ver evidencia">📷</button>`);
    acts.push(`<button class="small" data-act="share" title="Enviar enlace de seguimiento al cliente">🔗</button>`);
    if (o.status === 'pending' || o.status === 'assigned') acts.push(`<button class="small bad" data-act="del" title="Eliminar">✕</button>`);
    return `<li class="order st-${o.status}" data-id="${o.id}">
      ${withCheck ? `<input type="checkbox" class="sel" data-id="${o.id}" aria-label="Seleccionar pedido">` : `<span class="seq">${o.status === 'assigned' ? (o.seq ?? '·') : o.status === 'delivered' ? '✓' : '✕'}</span>`}
      <div class="main">
        <b>#${o.order_no} · ${esc(o.customer_name)}</b>
        <small>${esc(o.address)}</small>
        ${o.notes ? `<small class="note">${esc(o.notes)}</small>` : ''}
        ${o.status === 'failed' && o.fail_reason ? `<small class="note">Motivo: ${esc(o.fail_reason)}</small>` : ''}
        ${o.finished_at ? `<small>${LABEL[o.status]} a las ${hhmm(o.finished_at)}</small>` : ''}
      </div>
      <div class="meta">
        <span class="badge ${o.status}">${LABEL[o.status]}</span>
        ${eta != null && o.status === 'assigned' ? `<small>~${eta} min</small>` : ''}
        <div class="acts">${acts.join('')}</div>
      </div></li>`;
  }

  function renderList() {
    const keepChecked = new Set($$('.sel:checked').map((x) => x.dataset.id));
    const pending = state.orders.filter((o) => o.status === 'pending');
    let html = `<section class="group"><header><h3>Sin asignar (${pending.length})</h3></header>
      ${pending.length ? `<ul class="orders">${pending.map((o) => rowHtml(o, true)).join('')}</ul>` : '<p class="empty">No hay pedidos pendientes</p>'}</section>`;

    for (const d of state.drivers.filter((x) => x.active)) {
      const mine = state.orders.filter((o) => o.driver_id === d.id);
      if (!mine.length) continue;
      const act = assignedOf(d.id);
      const fin = mine.filter((o) => o.status !== 'assigned');
      html += `<section class="group" data-driver="${d.id}"><header>
        <h3>🏍️ ${esc(d.name)} · ${act.length} por entregar${fin.length ? ` · ${fin.length} cerrados` : ''}</h3>
        <div class="acts">
          ${act.length ? `<button class="small" data-gact="route" data-did="${d.id}">Ver ruta</button>
          <button class="small primary" data-gact="opt" data-did="${d.id}">Optimizar</button>` : ''}
        </div></header>
        <ul class="orders">${act.concat(fin).map((o) => rowHtml(o, false)).join('')}</ul></section>`;
    }
    $('#orderList').innerHTML = html;
    $$('.sel').forEach((c) => { if (keepChecked.has(c.dataset.id)) c.checked = true; });
    updateAssignBar();
  }

  function updateAssignBar() {
    const n = $$('.sel:checked').length;
    $('#assignBar').classList.toggle('hidden', n === 0);
    const cur = $('#assignDriver').value;
    $('#assignDriver').innerHTML = state.drivers.filter((d) => d.active)
      .map((d) => `<option value="${d.id}">${esc(d.name)} (${assignedOf(d.id).length} en ruta)</option>`).join('');
    if (cur) $('#assignDriver').value = cur;
    $('#assignBtn').textContent = `Asignar ${n} y optimizar`;
  }

  function renderMap() {
    lOrders.clearLayers();
    for (const o of state.orders) {
      const label = o.status === 'assigned' ? (o.seq ?? '·') : o.status === 'delivered' ? '✓' : o.status === 'failed' ? '✕' : '•';
      const m = L.marker([o.lat, o.lng], { icon: pinIcon(label, o.status === 'assigned' ? '' : o.status) });
      m.bindTooltip(`#${o.order_no} ${esc(o.customer_name)}<br>${esc(o.address)}`);
      m.on('click', () => { const row = $(`.order[data-id="${o.id}"]`); if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
      m.addTo(lOrders);
    }
  }

  function renderDrivers() {
    if (!lDrivers) return;
    lDrivers.clearLayers();
    for (const d of state.drivers) {
      const l = state.locs[d.id];
      if (!l || Date.now() - new Date(l.updated_at).getTime() > 10 * 60000) continue;
      L.marker([l.lat, l.lng], { icon: bikeIcon(d.name.split(' ')[0]), zIndexOffset: 1000 })
        .bindTooltip(`${esc(d.name)} · ${ago(l.updated_at)}`).addTo(lDrivers);
    }
  }

  function renderDriverTab() {
    $('#driverList').innerHTML = state.drivers.map((d) => {
      const l = state.locs[d.id];
      const live = l && Date.now() - new Date(l.updated_at).getTime() < 60000;
      return `<div class="card"><div class="row">
        <div><b>${esc(d.name)}</b><br><small><span class="dot ${live ? 'live' : ''}"></span>${l ? 'Señal ' + ago(l.updated_at) : 'Sin señal'}${d.active ? '' : ' · inactivo'}</small></div>
        <div class="acts"><button class="small" data-dact="pin" data-did="${d.id}">Cambiar PIN</button>
        <button class="small" data-dact="toggle" data-did="${d.id}">${d.active ? 'Desactivar' : 'Activar'}</button></div></div></div>`;
    }).join('') || '<p class="empty">Aún no hay domiciliarios</p>';
  }

  // ---------------- Rutas ----------------
  function maybeRedrawRoute() {
    if (!state.sel) return;
    const sig = assignedOf(state.sel).map((o) => o.id).join(',');
    if (sig !== state.routeSig) drawRoute(state.sel, false);
  }

  async function drawRoute(did, fit = true) {
    state.sel = did;
    const stops = assignedOf(did);
    state.routeSig = stops.map((o) => o.id).join(',');
    lRoute.clearLayers();
    if (!stops.length) return;
    const r = await osrmRoute([CFG.DEPOT, ...stops]);
    const line = L.polyline(r.coords.map((c) => [c[1], c[0]]), { weight: 5, opacity: .85, dashArray: r.fallback ? '6 8' : null }).addTo(lRoute);
    state.etas = {};
    let acc = 0;
    stops.forEach((s, i) => { acc += r.legs[i] || 0; if (r.legs.length) state.etas[s.id] = Math.max(1, Math.round(acc / 60)); });
    renderList();
    if (fit) map.fitBounds(line.getBounds(), { padding: [40, 40] });
    if (!r.fallback) toast(`Ruta: ${(r.distance / 1000).toFixed(1)} km · ~${Math.round(r.duration / 60)} min conduciendo`);
  }

  function busy(on) {
    $('.busy')?.remove();
    if (on) { const d = document.createElement('div'); d.className = 'busy'; d.textContent = 'Calculando mejor ruta…'; document.body.appendChild(d); }
  }

  async function optimize(did) {
    const stops = assignedOf(did);
    if (!stops.length) return;
    busy(true);
    try {
      const res = await osrmTrip(CFG.DEPOT, stops);
      const rs = await Promise.all(res.order.map((s, i) => sb.from('orders').update({ seq: i + 1 }).eq('id', s.id)));
      const bad = rs.find((r) => r.error);
      if (bad) throw bad.error;
      if (res.fallback) toast('El servidor de rutas no respondió: se ordenó por cercanía. Reintenta en un momento.', true);
      await load();
      await drawRoute(did, true);
    } catch (e) { toast('No se pudo optimizar: ' + e.message, true); }
    finally { busy(false); }
  }

  async function assign() {
    const ids = $$('.sel:checked').map((x) => x.dataset.id);
    const did = $('#assignDriver').value;
    if (!ids.length || !did) return toast('Selecciona pedidos y un domiciliario', true);
    const base = Math.max(0, ...assignedOf(did).map((o) => o.seq || 0));
    const rs = await Promise.all(ids.map((id, i) => sb.from('orders').update({ driver_id: did, status: 'assigned', seq: base + i + 1 }).eq('id', id)));
    const bad = rs.find((r) => r.error);
    if (bad) return toast('Error al asignar: ' + bad.error.message, true);
    await load();
    await optimize(did);
  }
  $('#assignBtn').addEventListener('click', assign);

  // ---------------- Acciones sobre pedidos ----------------
  function phoneIntl(p) {
    const d = String(p || '').replace(/\D/g, '');
    if (!d) return '';
    return d.length === 10 ? '57' + d : d;
  }
  const trackUrl = (o) => new URL('track.html?t=' + o.track_token, location.href).href;

  $('#orderList').addEventListener('click', async (e) => {
    const g = e.target.closest('[data-gact]');
    if (g) {
      if (g.dataset.gact === 'route') return drawRoute(g.dataset.did, true);
      if (g.dataset.gact === 'opt') return optimize(g.dataset.did);
    }
    const btn = e.target.closest('[data-act]');
    const li = e.target.closest('.order');
    if (!li) return;
    const o = state.orders.find((x) => x.id === li.dataset.id);
    if (!o) return;
    if (e.target.classList.contains('sel')) return updateAssignBar();
    if (!btn) { map.setView([o.lat, o.lng], 16); return; }

    const act = btn.dataset.act;
    if (act === 'share') {
      const msg = `Hola ${o.customer_name.split(' ')[0]}, sigue tu pedido de ${CFG.BUSINESS_NAME} aquí: ${trackUrl(o)}`;
      const ph = phoneIntl(o.phone);
      if (ph) window.open(`https://wa.me/${ph}?text=${encodeURIComponent(msg)}`, '_blank');
      else { try { await navigator.clipboard.writeText(trackUrl(o)); toast('Enlace copiado'); } catch { prompt('Copia el enlace:', trackUrl(o)); } }
    } else if (act === 'del') {
      if (!confirm(`¿Eliminar el pedido #${o.order_no} de ${o.customer_name}?`)) return;
      const { error } = await sb.from('orders').delete().eq('id', o.id);
      if (error) return toast(error.message, true);
      load();
    } else if (act === 'unassign') {
      const { error } = await sb.from('orders').update({ status: 'pending', driver_id: null, seq: null }).eq('id', o.id);
      if (error) return toast(error.message, true);
      load();
    } else if (act === 'proof') {
      const { data, error } = await sb.from('order_proofs').select('photo').eq('order_id', o.id).maybeSingle();
      if (error || !data) return toast('No se encontró la evidencia', true);
      $('#proofTitle').textContent = `Pedido #${o.order_no} · ${o.customer_name}`;
      $('#proofInfo').textContent = `${LABEL[o.status]} a las ${hhmm(o.finished_at)}`;
      $('#proofImg').src = data.photo;
      $('#proofDlg').showModal();
    }
  });
  $('#orderList').addEventListener('change', (e) => { if (e.target.classList.contains('sel')) updateAssignBar(); });

  // ---------------- Nuevo pedido ----------------
  function setDraft(lat, lng) {
    state.draft = { lat, lng };
    if (!draftMarker) {
      draftMarker = L.marker([lat, lng], { draggable: true, icon: pinIcon('＋', 'draft'), zIndexOffset: 2000 }).addTo(map);
      draftMarker.on('dragend', () => { const p = draftMarker.getLatLng(); state.draft = { lat: p.lat, lng: p.lng }; });
    } else draftMarker.setLatLng([lat, lng]);
    $('#pinHint').textContent = '📍 Punto colocado. Arrástralo si necesitas ajustarlo y guarda el pedido.';
  }
  function clearDraft() { if (draftMarker) { map.removeLayer(draftMarker); draftMarker = null; } state.draft = null; }

  $('#geoBtn').addEventListener('click', async () => {
    const q = $('#oAddr').value.trim();
    if (!q) return;
    const ul = $('#geoResults');
    ul.innerHTML = '<li>Buscando…</li>';
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=co&viewbox=-75.75,6.50,-75.30,6.05&q='
        + encodeURIComponent(`${q}, ${$('#oCity').value}, Antioquia`);
      const res = await fetchJson(url);
      if (!res.length) { ul.innerHTML = '<li>Sin resultados. Haz clic en el mapa para colocar el punto manualmente.</li>'; return; }
      ul.innerHTML = res.map((r, i) => `<li data-i="${i}">${esc(r.display_name)}</li>`).join('');
      ul.onclick = (e) => {
        const li = e.target.closest('li[data-i]'); if (!li) return;
        const r = res[+li.dataset.i];
        setDraft(+r.lat, +r.lon); map.setView([+r.lat, +r.lon], 17); ul.innerHTML = '';
      };
    } catch { ul.innerHTML = '<li>No se pudo buscar. Haz clic en el mapa para colocar el punto.</li>'; }
  });

  $('#orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.draft) return toast('Ubica la dirección en el mapa primero', true);
    const row = {
      customer_name: $('#oName').value.trim(),
      phone: $('#oPhone').value.trim() || null,
      address: `${$('#oAddr').value.trim()}, ${$('#oCity').value}`,
      notes: $('#oNotes').value.trim() || null,
      lat: state.draft.lat, lng: state.draft.lng
    };
    const { error } = await sb.from('orders').insert(row);
    if (error) return toast('Error: ' + error.message, true);
    toast('Pedido guardado');
    $('#orderForm').reset(); $('#geoResults').innerHTML = '';
    clearDraft();
    $('#pinHint').textContent = 'Busca la dirección o haz clic en el mapa para colocar el punto.';
    load();
  });

  // ---------------- Domiciliarios ----------------
  $('#driverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc('create_driver', { p_name: $('#dName').value, p_pin: $('#dPin').value });
    if (error) return toast(error.message, true);
    toast('Domiciliario creado'); $('#driverForm').reset(); load();
  });
  $('#driverList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dact]'); if (!b) return;
    const id = b.dataset.did;
    if (b.dataset.dact === 'pin') {
      const pin = prompt('Nuevo PIN (mínimo 6 caracteres):');
      if (!pin) return;
      const { error } = await sb.rpc('reset_driver_pin', { p_id: id, p_pin: pin });
      return error ? toast(error.message, true) : toast('PIN actualizado');
    }
    const d = state.drivers.find((x) => x.id === id);
    const { error } = await sb.from('drivers').update({ active: !d.active }).eq('id', id);
    error ? toast(error.message, true) : load();
  });
  $('#purgeBtn').addEventListener('click', async () => {
    if (!confirm('¿Borrar las fotos de evidencia de más de 60 días?')) return;
    const { data, error } = await sb.rpc('purge_old_proofs', { p_days: 60 });
    error ? toast(error.message, true) : toast(`${data} fotos borradas`);
  });

  // ---------------- Pestañas ----------------
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#tab-orders').classList.toggle('hidden', b.dataset.tab !== 'orders');
    $('#tab-drivers').classList.toggle('hidden', b.dataset.tab !== 'drivers');
  }));

  init();
})();
