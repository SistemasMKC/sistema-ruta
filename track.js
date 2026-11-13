(() => {
  const token = new URLSearchParams(location.search).get('t');
  let map, dest, bike;

  function say(title, sub = '') { $('#title').textContent = title; $('#sub').textContent = sub; }

  async function tick() {
    if (!token) return say('Enlace no válido', 'Pide a la tienda que te reenvíe el enlace de seguimiento.');
    const { data, error } = await sb.rpc('track_order', { p_track: token });
    if (error) return;                       // reintenta en el siguiente ciclo
    if (!data) return say('Pedido no encontrado', 'Verifica que el enlace esté completo.');

    if (!map) {
      map = makeMap('tmap', { lat: data.lat, lng: data.lng }, 15);
      dest = L.marker([data.lat, data.lng], { icon: pinIcon('🏠', 'depot') }).addTo(map).bindTooltip('Tu dirección');
    }
    const name = esc(data.first_name);

    if (data.status === 'delivered') {
      if (bike) { map.removeLayer(bike); bike = null; }
      return say('✅ ¡Pedido entregado!', `Gracias, ${data.first_name}. Entregado a las ${hhmm(data.finished_at)}.`);
    }
    if (data.status === 'failed') {
      return say('No pudimos entregar tu pedido', `Hola ${data.first_name}, comunícate con ${CFG.BUSINESS_NAME} para reprogramar.`);
    }
    if (data.status === 'pending') {
      return say('Pedido recibido', `Hola ${data.first_name}, estamos preparando tu pedido. Aquí verás al repartidor cuando salga.`);
    }

    // assigned
    const ahead = data.stops_ahead;
    let line = ahead === 0 ? 'Eres la próxima entrega.' : `Faltan ${ahead} entrega${ahead === 1 ? '' : 's'} antes de la tuya.`;
    if (data.driver) {
      const d = { lat: data.driver.lat, lng: data.driver.lng };
      if (!bike) bike = L.marker([d.lat, d.lng], { icon: bikeIcon(data.driver_name || 'Repartidor'), zIndexOffset: 1000 }).addTo(map);
      else bike.setLatLng([d.lat, d.lng]);
      map.fitBounds(L.latLngBounds([d.lat, d.lng], [data.lat, data.lng]), { padding: [50, 50], maxZoom: 16 });
      if (ahead === 0) {
        const r = await osrmRoute([d, data]);
        if (!r.fallback && r.duration) line += ` Llega en aprox. ${Math.max(1, Math.round(r.duration / 60))} min.`;
      }
      say(`🏍️ ${data.driver_name || 'Tu repartidor'} va en camino`, `${line} Ubicación actualizada ${ago(data.driver.updated_at)}.`);
    } else {
      say('Tu pedido está asignado', `${line} Verás al repartidor en el mapa cuando inicie su ruta.`);
    }
  }

  tick();
  setInterval(tick, 10000);
})();
