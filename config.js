// ============ CONFIGURACIÓN (edita solo este archivo) ============
window.APP_CONFIG = {
  // Supabase > Project Settings > API
  SUPABASE_URL: 'https://mjpafujakhuwmgfrvzus.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_sqh2Nz2szZqfqYnIrKTMfQ_GJxVe293',

  // Punto de salida de los domiciliarios (ajusta las coordenadas a tu sede)
  DEPOT: { name: 'Sede principal', lat: 6.321455447402893, lng: -75.56188660551861 },

  // Motor de rutas. El servidor demo de OSRM es gratis pero de uso moderado
  // y sin garantía de disponibilidad; ver README para alternativas.
  OSRM_URL: 'https://router.project-osrm.org',

  // Municipios para afinar la búsqueda de direcciones
  CITIES: ['Medellín', 'Bello', 'Envigado', 'Itagüí', 'Sabaneta', 'La Estrella', 'Copacabana', 'Caldas', 'Girardota'],

  // Cada cuánto envía su ubicación el domiciliario (ms)
  GPS_INTERVAL_MS: 10000,

  BUSINESS_NAME: 'Market Cerdo'
};