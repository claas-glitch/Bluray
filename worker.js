// Optionaler Cloudflare-Worker: leitet EAN-Abfragen an UPCitemdb weiter und
// erlaubt den Zugriff aus dem Browser (CORS). Kostenlos bei Cloudflare.
// Anleitung: siehe ANLEITUNG.md, Abschnitt "Titel automatisch aus Barcode".

// Trage hier die Adresse deiner App ein, damit nur sie den Worker nutzen kann,
// z. B. 'https://deinname.github.io'. '*' erlaubt jede Seite.
const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request) {
    const headers = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Content-Type': 'application/json; charset=utf-8',
    };
    const ean = (new URL(request.url).searchParams.get('ean') || '').replace(/\D/g, '');
    if (ean.length < 8) return new Response('{"error":"ean fehlt"}', { status: 400, headers });

    const r = await fetch('https://api.upcitemdb.com/prod/trial/lookup?upc=' + ean, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 60 * 60 * 24 * 30, cacheEverything: true },
    });
    return new Response(await r.text(), { status: r.status, headers });
  },
};
