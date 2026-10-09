'use strict';

/* =========================================================
   Helpers
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const store = {
  get(k, d) { try { const v = localStorage.getItem('br_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('br_' + k, JSON.stringify(v)); } catch { /* privat-modus */ } },
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = 1400;
    g.gain.value = 0.06;
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.1);
    setTimeout(() => ac.close(), 300);
  } catch { /* egal */ }
}

/* =========================================================
   Datenbank (IndexedDB, lokal auf dem Gerät)
   ========================================================= */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('bluray-sammlung', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode) { return this.db.transaction('items', mode).objectStore('items'); },
  all() { return new Promise((res, rej) => { const r = this.tx('readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  put(item) { return new Promise((res, rej) => { const r = this.tx('readwrite').put(item); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  del(id) { return new Promise((res, rej) => { const r = this.tx('readwrite').delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  clear() { return new Promise((res, rej) => { const r = this.tx('readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
};

const FORMATS = ['Blu-ray', '4K UHD', '3D', 'DVD'];
const FSK = ['0', '6', '12', '16', '18'];

function newItem(p = {}) {
  return {
    id: uid(), status: 'collection',
    title: '', originalTitle: '', year: '', ean: '',
    format: 'Blu-ray', steelbook: false, edition: '',
    genres: [], director: '', cast: [], runtime: '', fsk: '', overview: '',
    poster: '', backdrop: '', image: '', tmdbId: null, mediaType: 'movie',
    rating: 0, watched: false, notes: '', price: '', targetPrice: '',
    amazonUrl: '', rebuyUrl: '', addedAt: Date.now(),
    ...p,
  };
}

/* =========================================================
   State
   ========================================================= */
const state = {
  items: [],
  tab: 'collection',
  search: '',
  formats: new Set(),
  genres: new Set(),
  fsk: new Set(),
  watched: 'all',
  steelbook: false,
  sort: store.get('sort', 'title'),
};

async function saveItem(item) {
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.push(item);
  await DB.put(item);
  render();
}
async function deleteItem(id) {
  state.items = state.items.filter((x) => x.id !== id);
  await DB.del(id);
  render();
}

/* =========================================================
   Online-Dienste: EAN-Datenbank + TMDB
   ========================================================= */
const tmdbKey = () => store.get('tmdbKey', '').trim();
const IMG = 'https://image.tmdb.org/t/p/';

async function tmdb(path, params = {}, lang = 'de-DE') {
  const key = tmdbKey();
  if (!key) throw new Error('Kein TMDB-Key hinterlegt (Einstellungen)');
  const url = new URL('https://api.themoviedb.org/3' + path);
  url.searchParams.set('language', lang);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {};
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // v4 Lese-Token
  else url.searchParams.set('api_key', key); // v3 API-Key
  const r = await fetch(url, { headers });
  if (r.status === 401) throw new Error('TMDB-Key ungültig');
  if (!r.ok) throw new Error('TMDB-Fehler ' + r.status);
  return r.json();
}

async function tmdbSearch(query) {
  const j = await tmdb('/search/multi', { query, include_adult: 'false' });
  return (j.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .slice(0, 12)
    .map((r) => ({
      id: r.id,
      mediaType: r.media_type,
      title: r.title || r.name,
      year: (r.release_date || r.first_air_date || '').slice(0, 4),
      poster: r.poster_path ? IMG + 'w154' + r.poster_path : '',
    }));
}

async function tmdbDetails(mediaType, id) {
  let out;
  if (mediaType === 'tv') {
    const d = await tmdb(`/tv/${id}`, { append_to_response: 'credits,content_ratings' });
    out = {
      title: d.name, originalTitle: d.original_name,
      year: (d.first_air_date || '').slice(0, 4),
      director: (d.created_by || []).map((c) => c.name).join(', '),
      runtime: (d.episode_run_time || [])[0] || '',
      fsk: ((d.content_ratings?.results || []).find((r) => r.iso_3166_1 === 'DE') || {}).rating || '',
      d,
    };
  } else {
    const d = await tmdb(`/movie/${id}`, { append_to_response: 'credits,release_dates' });
    const de = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'DE');
    out = {
      title: d.title, originalTitle: d.original_title,
      year: (d.release_date || '').slice(0, 4),
      director: (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name).join(', '),
      runtime: d.runtime || '',
      fsk: de ? (de.release_dates.map((x) => x.certification).find(Boolean) || '') : '',
      d,
    };
  }
  const d = out.d;
  let overview = d.overview;
  if (!overview) {
    try { overview = (await tmdb(`/${mediaType}/${id}`, {}, 'en-US')).overview; } catch { /* egal */ }
  }
  return {
    title: out.title, originalTitle: out.originalTitle !== out.title ? out.originalTitle : '',
    year: out.year, director: out.director, runtime: String(out.runtime || ''),
    fsk: FSK.includes(String(out.fsk)) ? String(out.fsk) : '',
    genres: (d.genres || []).map((g) => g.name),
    cast: (d.credits?.cast || []).slice(0, 6).map((c) => c.name),
    overview: overview || '',
    poster: d.poster_path ? IMG + 'w500' + d.poster_path : '',
    backdrop: d.backdrop_path ? IMG + 'w780' + d.backdrop_path : '',
    tmdbId: id, mediaType,
  };
}

// EAN → Produkttitel über die freie UPCitemdb (ca. 100 Abfragen/Tag).
// Die API erlaubt keinen direkten Browser-Zugriff (CORS), daher nur über den
// optionalen Cloudflare-Worker aus worker.js (URL in den Einstellungen).
const eanProxy = () => store.get('eanProxy', '').trim().replace(/\/+$/, '');

async function lookupEan(ean) {
  if (!eanProxy()) return null;
  try {
    const r = await fetch(eanProxy() + '/?ean=' + encodeURIComponent(ean));
    if (!r.ok) return null;
    const j = await r.json();
    const it = j.items && j.items[0];
    return it ? { rawTitle: it.title || '', image: (it.images || [])[0] || '' } : null;
  } catch {
    return null;
  }
}

// Aus einem Produkttitel wie "Inception [Blu-ray] (Steelbook)" Format + Filmtitel ableiten
function analyzeTitle(raw) {
  const s = raw || '';
  let format = 'Blu-ray';
  if (/4k|uhd|ultra\s*hd/i.test(s)) format = '4K UHD';
  else if (/\b3d\b/i.test(s)) format = '3D';
  else if (/\bdvd\b/i.test(s) && !/blu-?ray/i.test(s)) format = 'DVD';
  const steelbook = /steel\s*book/i.test(s);
  const query = s
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(blu-?ray|4k|uhd|ultra\s*hd|steel\s*book|3d|2d|dvd|disc|limited|edition|collector'?s|special|exklusiv|digibook|mediabook|uncut|extended|director'?s\s*cut|import|neuauflage)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–|:,+&]+$/, '')
    .trim();
  return { format, steelbook, query };
}

/* =========================================================
   Shop-Links
   ========================================================= */
function shopLinks(it) {
  const fmt = it.format === 'DVD' ? 'DVD' : it.format === '4K UHD' ? '4K UHD Blu-ray' : 'Blu-ray';
  const titleQ = `${it.title} ${fmt}`.trim();
  return {
    amazon: it.amazonUrl || 'https://www.amazon.de/s?k=' + encodeURIComponent(it.ean || titleQ),
    rebuy: it.rebuyUrl || 'https://www.rebuy.de/kaufen/filme?q=' + encodeURIComponent(it.title),
  };
}

/* =========================================================
   Rendering
   ========================================================= */
function coverHTML(it, opts = {}) {
  const src = it.image || it.poster;
  const fmtCls = { '4K UHD': 'uhd', DVD: 'dvd', '3D': 'td' }[it.format] || '';
  const fmtLabel = it.format === '4K UHD' ? '4K ULTRA HD' : it.format.toUpperCase();
  return `<div class="cover">
    ${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : `<div class="ph">${esc(it.title || '?')}</div>`}
    ${opts.badge !== false ? `<div class="fmt ${fmtCls}">${esc(fmtLabel)}${it.steelbook ? ' · STEEL' : ''}</div>` : ''}
    ${opts.seen && it.watched ? '<div class="seen">✓</div>' : ''}
  </div>`;
}

function filtered(status) {
  const q = state.search.trim().toLowerCase();
  let list = state.items.filter((it) => it.status === status);
  if (q) {
    list = list.filter((it) => [it.title, it.originalTitle, it.director, (it.cast || []).join(' '), it.ean, it.notes, it.edition]
      .join(' ').toLowerCase().includes(q));
  }
  if (state.formats.size) list = list.filter((it) => state.formats.has(it.format));
  if (state.steelbook) list = list.filter((it) => it.steelbook);
  if (state.genres.size) list = list.filter((it) => (it.genres || []).some((g) => state.genres.has(g)));
  if (state.fsk.size) list = list.filter((it) => state.fsk.has(String(it.fsk)));
  if (state.watched === 'yes') list = list.filter((it) => it.watched);
  if (state.watched === 'no') list = list.filter((it) => !it.watched);

  const coll = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
  const sorters = {
    title: (a, b) => coll.compare(a.title, b.title),
    year: (a, b) => (b.year || 0) - (a.year || 0) || coll.compare(a.title, b.title),
    added: (a, b) => b.addedAt - a.addedAt,
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || coll.compare(a.title, b.title),
  };
  return list.sort(sorters[state.sort] || sorters.title);
}

function activeFilterCount() {
  return state.genres.size + state.fsk.size + (state.watched !== 'all' ? 1 : 0);
}

function render() {
  $$('.tabbar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const titles = { collection: 'Sammlung', wishlist: 'Wunschliste', settings: 'Einstellungen' };
  $('#pageTitle').textContent = titles[state.tab];
  const view = $('#view');
  if (state.tab === 'settings') view.innerHTML = settingsView();
  else view.innerHTML = listView(state.tab);
}

function toolbarHTML(status) {
  const n = activeFilterCount();
  const fmtChips = FORMATS.map((f) => `<button class="chip ${state.formats.has(f) ? 'on' : ''}" data-action="toggle-format" data-v="${f}">${f}</button>`).join('');
  return `
    <div class="toolbar">
      <input id="search" class="search" type="search" placeholder="Titel, Regie, Schauspieler, EAN …" value="${esc(state.search)}" autocomplete="off">
      <button class="btn" data-action="filters">Filter${n ? ` <span class="badge">${n}</span>` : ''}</button>
    </div>
    <div class="chips">
      <button class="chip ${!state.formats.size && !state.steelbook ? 'on' : ''}" data-action="all-formats">Alle</button>
      ${fmtChips}
      <button class="chip ${state.steelbook ? 'on' : ''}" data-action="toggle-steel">Steelbook</button>
    </div>`;
}

function listView(status) {
  const all = state.items.filter((it) => it.status === status);
  if (!all.length) {
    return status === 'collection'
      ? `<div class="empty"><div class="big">💿</div><h3>Noch keine Filme</h3><p>Scanne den Barcode deiner ersten Blu-ray oder trage sie von Hand ein.</p><button class="btn primary" data-action="add">Erste Blu-ray hinzufügen</button></div>`
      : `<div class="empty"><div class="big">🎁</div><h3>Wunschliste ist leer</h3><p>Füge Filme hinzu, die dir noch fehlen. Von hier aus kommst du direkt zu Amazon und rebuy.</p><button class="btn primary" data-action="add">Wunsch hinzufügen</button></div>`;
  }
  let html = '';
  if (status === 'collection') {
    const uhd = all.filter((i) => i.format === '4K UHD').length;
    const steel = all.filter((i) => i.steelbook).length;
    const seen = all.filter((i) => i.watched).length;
    const value = all.reduce((s, i) => s + (parseFloat(String(i.price).replace(',', '.')) || 0), 0);
    html += `<div class="stats">
      <div class="stat"><b>${all.length}</b><span>Titel</span></div>
      <div class="stat"><b>${uhd}</b><span>4K UHD</span></div>
      <div class="stat"><b>${steel}</b><span>Steelbooks</span></div>
      <div class="stat"><b>${value ? Math.round(value) + ' €' : Math.round((seen / all.length) * 100) + '%'}</b><span>${value ? 'Wert' : 'gesehen'}</span></div>
    </div>`;
  }
  return html + toolbarHTML(status) + `<div id="listArea">${listAreaHTML(status)}</div>`;
}

function listAreaHTML(status) {
  const total = state.items.filter((it) => it.status === status).length;
  const list = filtered(status);
  let html = `<p class="meta">${list.length === total ? `${total} Titel` : `${list.length} von ${total} Titeln`}</p>`;
  if (!list.length) return html + `<div class="empty"><p>Keine Treffer für diese Filter.</p><button class="btn" data-action="reset-filters">Filter zurücksetzen</button></div>`;

  if (status === 'collection') {
    html += '<div class="grid">' + list.map((it) => `
      <button class="card" data-action="detail" data-id="${it.id}">
        ${coverHTML(it, { seen: true })}
        <div class="t">${esc(it.title)}</div>
        <div class="y">${esc(it.year)}</div>
      </button>`).join('') + '</div>';
  } else {
    html += list.map((it) => {
      const l = shopLinks(it);
      return `<div class="wish">
        <button class="card" data-action="detail" data-id="${it.id}" style="width:72px;flex:none">${coverHTML(it)}</button>
        <div class="wish-body">
          <button class="t" data-action="detail" data-id="${it.id}">${esc(it.title)}</button>
          <div class="sub">${[it.year, it.format, it.targetPrice ? `Ziel: ${esc(it.targetPrice)} €` : ''].filter(Boolean).join(' · ')}</div>
          <div class="btn-row">
            <a class="btn small shop-amazon" href="${esc(l.amazon)}" target="_blank" rel="noopener">Amazon</a>
            <a class="btn small shop-rebuy" href="${esc(l.rebuy)}" target="_blank" rel="noopener">rebuy</a>
            <button class="btn small" data-action="bought" data-id="${it.id}">✓ Gekauft</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  return html;
}

function settingsView() {
  const key = tmdbKey();
  const coll = state.items.filter((i) => i.status === 'collection').length;
  const wish = state.items.filter((i) => i.status === 'wishlist').length;
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return `
    <div class="card-box">
      <h3>TMDB API-Key</h3>
      <p>Damit Cover, Genres, Regie und FSK automatisch geladen werden. Kostenlos auf <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org</a> (Konto anlegen → Einstellungen → API). Du kannst den „API-Schlüssel“ oder den „API-Lesezugriffstoken“ einfügen.</p>
      <input id="tmdbKey" class="input" type="password" placeholder="API-Key einfügen" value="${esc(key)}" autocomplete="off">
      <div class="btn-row" style="margin-top:10px">
        <button class="btn primary" data-action="save-key">Speichern & testen</button>
      </div>
      <p id="keyStatus" style="margin:8px 0 0">${key ? '🔑 Key hinterlegt' : '⚠️ Noch kein Key'}</p>
    </div>

    <div class="card-box">
      <h3>Titel automatisch aus Barcode (optional)</h3>
      <p>Ohne diese Einstellung liest der Scanner nur die EAN, den Titel tippst du kurz ein. Mit einem kostenlosen Cloudflare-Worker (siehe <b>worker.js</b> und Anleitung) erkennt die App den Titel direkt. Klappt nicht bei jeder Blu-ray.</p>
      <input id="eanProxy" class="input" type="url" placeholder="https://bluray-ean.DEINNAME.workers.dev" value="${esc(eanProxy())}" autocomplete="off">
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-action="save-proxy">Speichern</button></div>
    </div>

    <div class="card-box">
      <h3>Sicherung</h3>
      <p>Deine Daten liegen nur auf diesem Gerät (${coll} in der Sammlung, ${wish} auf der Wunschliste). Exportiere ab und zu eine Sicherung, z. B. in iCloud Drive.</p>
      <div class="btn-row">
        <button class="btn" data-action="export">⬇︎ Exportieren</button>
        <button class="btn" data-action="import">⬆︎ Importieren</button>
        <button class="btn" data-action="export-csv">CSV (Excel)</button>
      </div>
      <input id="importFile" type="file" accept="application/json,.json" hidden>
    </div>

    ${standalone ? '' : `<div class="card-box">
      <h3>Als App installieren</h3>
      <p>Öffne die Seite in Safari, tippe auf <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>. Danach startet die Sammlung im Vollbild wie eine App, und iOS löscht die Daten nicht automatisch.</p>
    </div>`}

    <div class="card-box">
      <h3>Alles löschen</h3>
      <p>Entfernt alle Filme von diesem Gerät. Mach vorher eine Sicherung.</p>
      <button class="btn danger" data-action="wipe">Alle Daten löschen</button>
    </div>
    <p class="meta" style="text-align:center">Filmdaten & Cover: TMDB. Diese App wird nicht von TMDB unterstützt oder zertifiziert.</p>`;
}

/* =========================================================
   Sheet (Bottom-Sheet Dialog)
   ========================================================= */
let onSheetClose = null;
function openSheet(html, onClose) {
  if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
  $('#sheetBody').innerHTML = html;
  $('#sheetWrap').hidden = false;
  $('.sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  onSheetClose = onClose || null;
}
function setSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('.sheet').scrollTop = 0;
}
function closeSheet() {
  if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
  $('#sheetWrap').hidden = true;
  $('#sheetBody').innerHTML = '';
  document.body.style.overflow = '';
}

/* ---------- Filter ---------- */
function filterSheet() {
  const genres = [...new Set(state.items.filter((i) => i.status === (state.tab === 'wishlist' ? 'wishlist' : 'collection')).flatMap((i) => i.genres || []))].sort((a, b) => a.localeCompare(b, 'de'));
  const sorts = [['title', 'Titel A–Z'], ['year', 'Erscheinungsjahr'], ['added', 'Zuletzt hinzugefügt'], ['rating', 'Meine Bewertung']];
  openSheet(`
    <h2>Filter & Sortierung</h2>
    <div class="section-title">Sortieren nach</div>
    <div class="chips wrap">${sorts.map(([v, l]) => `<button class="chip ${state.sort === v ? 'on' : ''}" data-action="sort" data-v="${v}">${l}</button>`).join('')}</div>
    <div class="section-title">Gesehen</div>
    <div class="chips wrap">${[['all', 'Alle'], ['yes', 'Gesehen'], ['no', 'Noch nicht gesehen']].map(([v, l]) => `<button class="chip ${state.watched === v ? 'on' : ''}" data-action="watched-filter" data-v="${v}">${l}</button>`).join('')}</div>
    <div class="section-title">FSK</div>
    <div class="chips wrap">${FSK.map((f) => `<button class="chip ${state.fsk.has(f) ? 'on' : ''}" data-action="fsk-filter" data-v="${f}">FSK ${f}</button>`).join('')}</div>
    <div class="section-title">Genre</div>
    <div class="chips wrap">${genres.length ? genres.map((g) => `<button class="chip ${state.genres.has(g) ? 'on' : ''}" data-action="genre-filter" data-v="${esc(g)}">${esc(g)}</button>`).join('') : '<span class="meta">Genres kommen automatisch über TMDB dazu.</span>'}</div>
    <div class="btn-row" style="margin-top:18px">
      <button class="btn" data-action="reset-filters">Zurücksetzen</button>
      <button class="btn primary" data-action="close-sheet">Fertig</button>
    </div>`);
}

/* ---------- Detail ---------- */
function detailSheet(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const l = shopLinks(it);
  const sub = [it.year, it.runtime ? it.runtime + ' Min.' : '', it.fsk !== '' ? 'FSK ' + it.fsk : '', it.format + (it.steelbook ? ' Steelbook' : '')].filter(Boolean).join(' · ');
  const kv = [
    ['Originaltitel', it.originalTitle], ['Regie', it.director], ['Darsteller', (it.cast || []).join(', ')],
    ['Edition', it.edition], ['EAN', it.ean],
    [it.status === 'wishlist' ? 'Zielpreis' : 'Kaufpreis', it.status === 'wishlist' ? (it.targetPrice && it.targetPrice + ' €') : (it.price && it.price + ' €')],
    ['Hinzugefügt', new Date(it.addedAt).toLocaleDateString('de-DE')],
  ].filter(([, v]) => v);
  openSheet(`
    ${it.backdrop ? `<div class="hero" style="background-image:url('${esc(it.backdrop)}')"></div>` : ''}
    <div class="detail-head ${it.backdrop ? '' : 'no-hero'}">
      ${coverHTML(it)}
      <div><h2>${esc(it.title)}</h2><div class="sub">${esc(sub)}</div></div>
    </div>
    ${(it.genres || []).length ? `<div class="chips wrap">${it.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
    ${it.status === 'collection' ? `
      <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button class="${n <= (it.rating || 0) ? 'on' : ''}" data-action="rate" data-id="${it.id}" data-v="${n}" aria-label="${n} Sterne">★</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-action="toggle-watched" data-id="${it.id}" ${it.watched ? 'checked' : ''}> Gesehen</label>` : ''}
    ${it.overview ? `<p class="overview">${esc(it.overview)}</p>` : ''}
    ${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    ${it.notes ? `<div class="section-title">Notizen</div><p>${esc(it.notes)}</p>` : ''}
    <div class="section-title">${it.status === 'wishlist' ? 'Kaufen' : 'Shops'}</div>
    <div class="btn-row">
      <a class="btn shop-amazon" href="${esc(l.amazon)}" target="_blank" rel="noopener">Amazon</a>
      <a class="btn shop-rebuy" href="${esc(l.rebuy)}" target="_blank" rel="noopener">rebuy</a>
    </div>
    <div class="btn-row" style="margin-top:10px">
      ${it.status === 'wishlist' ? `<button class="btn primary" data-action="bought" data-id="${it.id}">✓ Gekauft – in Sammlung</button>` : ''}
      <button class="btn" data-action="edit" data-id="${it.id}">Bearbeiten</button>
      <button class="btn danger" data-action="delete" data-id="${it.id}">Löschen</button>
    </div>`);
}

/* =========================================================
   Hinzufügen: Scanner → Suche → Formular
   ========================================================= */
let scanReader = null;

function stopScanner() {
  if (scanReader) { try { scanReader.reset(); } catch { /* egal */ } scanReader = null; }
}

async function startScanner(video, onCode) {
  if (!window.ZXing) throw new Error('Scanner konnte nicht geladen werden (keine Internetverbindung?)');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera nicht verfügbar. Die Seite muss über https:// geöffnet werden.');
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  scanReader = new ZXing.BrowserMultiFormatReader(hints, 250);
  let done = false;
  await scanReader.decodeFromConstraints(
    { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    video,
    (result) => {
      if (result && !done) {
        done = true;
        let code = result.getText();
        if (code.length === 12) code = '0' + code; // UPC-A → EAN-13
        stopScanner();
        beep();
        onCode(code);
      }
    },
  );
}

function addFlow(target) {
  target = target || (state.tab === 'wishlist' ? 'wishlist' : 'collection');
  openSheet(`
    <h2>${target === 'wishlist' ? 'Wunsch hinzufügen' : 'Blu-ray hinzufügen'}</h2>
    <div class="scanner">
      <video id="scanVideo" playsinline muted autoplay></video>
      <div class="scan-frame"></div>
      <p class="scan-hint">Barcode auf der Rückseite in den Rahmen halten</p>
      <div class="scan-error" id="scanError" hidden></div>
    </div>
    <form class="inline-form" id="eanForm">
      <input class="input" name="ean" inputmode="numeric" pattern="[0-9]*" placeholder="EAN von Hand eintippen" autocomplete="off">
      <button class="btn primary">OK</button>
    </form>
    <div class="divider">oder</div>
    <button class="btn block" data-action="title-search" data-target="${target}">🔍 Nach Titel suchen (ohne Barcode)</button>
  `, stopScanner);

  $('#eanForm').onsubmit = (e) => {
    e.preventDefault();
    const ean = e.target.ean.value.replace(/\D/g, '');
    if (ean.length < 8) return toast('EAN hat mindestens 8 Ziffern');
    stopScanner();
    handleEan(ean, target);
  };

  const video = $('#scanVideo');
  startScanner(video, (code) => handleEan(code, target)).catch((err) => {
    const box = $('#scanError');
    if (!box) return;
    box.hidden = false;
    box.textContent = err && err.name === 'NotAllowedError'
      ? 'Kein Kamerazugriff. Erlaube die Kamera in den Safari-Einstellungen für diese Seite oder tippe die EAN ein.'
      : (err && err.message) || 'Kamera konnte nicht gestartet werden.';
  });
}

async function handleEan(ean, target) {
  const dup = state.items.find((i) => i.ean === ean);
  const ctx = { ean, target, query: '', format: 'Blu-ray', steelbook: false, rawTitle: '', eanImage: '', dup };
  let found = null;
  if (eanProxy()) {
    setSheet(`<h2>EAN ${esc(ean)}</h2><div class="spinner"></div><p class="meta" style="text-align:center">Suche Produkt …</p>`);
    found = await lookupEan(ean);
  }
  if (found) {
    const a = analyzeTitle(found.rawTitle);
    Object.assign(ctx, a, { rawTitle: found.rawTitle, eanImage: found.image });
  }
  searchStep(ctx);
}

async function searchStep(ctx) {
  const dupHTML = ctx.dup ? `<div class="notice">⚠️ Diese EAN ist schon ${ctx.dup.status === 'wishlist' ? 'auf deiner Wunschliste' : 'in deiner Sammlung'}: <b>${esc(ctx.dup.title)}</b>
      <div class="btn-row" style="margin-top:8px"><button class="btn small" data-action="detail" data-id="${ctx.dup.id}">Ansehen</button></div></div>` : '';
  const info = ctx.ean
    ? (ctx.rawTitle
      ? `<div class="notice info">EAN ${esc(ctx.ean)} erkannt: „${esc(ctx.rawTitle)}“</div>`
      : `<div class="notice info">✓ EAN ${esc(ctx.ean)} erkannt. Tippe den Titel ein, die EAN wird mitgespeichert.</div>`)
    : '';
  setSheet(`
    <h2>Film auswählen</h2>
    ${dupHTML}${info}
    <form class="inline-form" id="searchForm">
      <input class="input" name="q" placeholder="Filmtitel" value="${esc(ctx.query)}" autocomplete="off">
      <button class="btn primary">Suchen</button>
    </form>
    <div class="results" id="results"></div>
    <button class="btn block" data-action="manual">Ohne Treffer manuell anlegen</button>
  `);
  addFlow.ctx = ctx;
  const form = $('#searchForm');
  form.onsubmit = (e) => { e.preventDefault(); ctx.query = form.q.value.trim(); runSearch(ctx); };
  if (ctx.query) runSearch(ctx); else form.q.focus();
}

async function runSearch(ctx) {
  const box = $('#results');
  if (!ctx.query) return;
  if (!tmdbKey()) {
    box.innerHTML = `<div class="notice">Für die Filmsuche wird ein TMDB-Key gebraucht (Einstellungen). Du kannst den Film aber auch manuell anlegen.</div>`;
    return;
  }
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const res = await tmdbSearch(ctx.query);
    ctx.results = res;
    box.innerHTML = res.length ? res.map((r, i) => `
      <button class="result" data-action="pick" data-i="${i}">
        <div class="cover">${r.poster ? `<img src="${esc(r.poster)}" alt="" loading="lazy">` : '<div class="ph">?</div>'}</div>
        <div><div class="t">${esc(r.title)}</div><div class="sub">${esc(r.year || '–')} · ${r.mediaType === 'tv' ? 'Serie' : 'Film'}</div></div>
      </button>`).join('') : '<p class="meta">Keine Treffer. Versuch es mit einem kürzeren Titel.</p>';
  } catch (err) {
    box.innerHTML = `<div class="notice">${esc(err.message)}</div>`;
  }
}

async function pickResult(i) {
  const ctx = addFlow.ctx;
  const r = ctx.results[i];
  setSheet('<div class="spinner"></div>');
  try {
    const details = await tmdbDetails(r.mediaType, r.id);
    editSheet(newItem({ ...details, ean: ctx.ean, format: ctx.format, steelbook: ctx.steelbook, status: ctx.target }), true);
  } catch (err) {
    toast(err.message);
    searchStep(ctx);
  }
}

function manualFromCtx() {
  const ctx = addFlow.ctx || {};
  editSheet(newItem({ title: ctx.query || '', ean: ctx.ean || '', format: ctx.format || 'Blu-ray', steelbook: !!ctx.steelbook, poster: ctx.eanImage || '', status: ctx.target || 'collection' }), true);
}

/* ---------- Formular ---------- */
function editSheet(item, isNew) {
  const it = { ...item };
  openSheet(`
    <h2>${isNew ? 'Neuer Eintrag' : 'Bearbeiten'}</h2>
    <form id="editForm" class="${it.status === 'wishlist' ? 'is-wish' : ''}">
      <div class="seg">
        <button type="button" class="${it.status === 'collection' ? 'on' : ''}" data-status="collection">Sammlung</button>
        <button type="button" class="${it.status === 'wishlist' ? 'on' : ''}" data-status="wishlist">Wunschliste</button>
      </div>

      <div class="cover-edit">
        <div id="coverPreview">${coverHTML(it, { badge: false })}</div>
        <div class="btn-row">
          <button type="button" class="btn small" data-action="photo">📷 Eigenes Foto</button>
          <button type="button" class="btn small" data-action="remove-photo" ${it.image ? '' : 'hidden'}>Foto entfernen</button>
          <input type="file" id="photoInput" accept="image/*" capture="environment" hidden>
        </div>
      </div>

      <label class="field"><span>Titel *</span><input class="input" name="title" required value="${esc(it.title)}"></label>
      <div class="row2">
        <label class="field"><span>Jahr</span><input class="input" name="year" inputmode="numeric" value="${esc(it.year)}"></label>
        <label class="field"><span>Format</span><select class="input" name="format">${FORMATS.map((f) => `<option ${it.format === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="steelbook" ${it.steelbook ? 'checked' : ''}> Steelbook</label>
      <label class="field"><span>Edition (z. B. Mediabook, Collector's)</span><input class="input" name="edition" value="${esc(it.edition)}"></label>
      <div class="row2">
        <label class="field"><span>FSK</span><select class="input" name="fsk"><option value="">–</option>${FSK.map((f) => `<option value="${f}" ${String(it.fsk) === f ? 'selected' : ''}>FSK ${f}</option>`).join('')}</select></label>
        <label class="field"><span>Laufzeit (Min.)</span><input class="input" name="runtime" inputmode="numeric" value="${esc(it.runtime)}"></label>
      </div>
      <label class="field"><span>Genres (mit Komma getrennt)</span><input class="input" name="genres" value="${esc((it.genres || []).join(', '))}"></label>
      <label class="field"><span>Regie</span><input class="input" name="director" value="${esc(it.director)}"></label>
      <label class="field"><span>EAN</span><input class="input" name="ean" inputmode="numeric" value="${esc(it.ean)}"></label>

      <div class="only-coll">
        <div class="row2">
          <label class="field"><span>Kaufpreis (€)</span><input class="input" name="price" inputmode="decimal" value="${esc(it.price)}"></label>
          <label class="check" style="margin-top:22px"><input type="checkbox" name="watched" ${it.watched ? 'checked' : ''}> Gesehen</label>
        </div>
      </div>
      <div class="only-wish">
        <label class="field"><span>Zielpreis (€)</span><input class="input" name="targetPrice" inputmode="decimal" value="${esc(it.targetPrice)}"></label>
        <label class="field"><span>Amazon-Link (optional, sonst Suche)</span><input class="input" name="amazonUrl" type="url" placeholder="https://www.amazon.de/…" value="${esc(it.amazonUrl)}"></label>
        <label class="field"><span>rebuy-Link (optional, sonst Suche)</span><input class="input" name="rebuyUrl" type="url" placeholder="https://www.rebuy.de/…" value="${esc(it.rebuyUrl)}"></label>
      </div>
      <label class="field"><span>Notizen / Regalplatz</span><textarea class="input" name="notes">${esc(it.notes)}</textarea></label>

      <button class="btn primary block" type="submit">Speichern</button>
      ${isNew ? '<button class="btn block" type="submit" data-next="1" style="margin-top:8px">Speichern & nächsten scannen</button>' : ''}
    </form>`);

  const form = $('#editForm');
  $$('.seg button', form).forEach((b) => b.onclick = () => {
    it.status = b.dataset.status;
    $$('.seg button', form).forEach((x) => x.classList.toggle('on', x === b));
    form.classList.toggle('is-wish', it.status === 'wishlist');
  });

  const photoInput = $('#photoInput');
  photoInput.onchange = async () => {
    const file = photoInput.files[0];
    if (!file) return;
    try {
      it.image = await readImage(file);
      $('#coverPreview').innerHTML = coverHTML(it, { badge: false });
      $('[data-action="remove-photo"]', form).hidden = false;
    } catch { toast('Bild konnte nicht gelesen werden'); }
  };
  form.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'photo') photoInput.click();
    if (a.dataset.action === 'remove-photo') {
      it.image = '';
      $('#coverPreview').innerHTML = coverHTML(it, { badge: false });
      a.hidden = true;
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    Object.assign(it, {
      title: f.title.value.trim(),
      year: f.year.value.trim(),
      format: f.format.value,
      steelbook: f.steelbook.checked,
      edition: f.edition.value.trim(),
      fsk: f.fsk.value,
      runtime: f.runtime.value.trim(),
      genres: f.genres.value.split(',').map((s) => s.trim()).filter(Boolean),
      director: f.director.value.trim(),
      ean: f.ean.value.replace(/\D/g, ''),
      price: f.price.value.trim(),
      watched: f.watched.checked,
      targetPrice: f.targetPrice.value.trim(),
      amazonUrl: f.amazonUrl.value.trim(),
      rebuyUrl: f.rebuyUrl.value.trim(),
      notes: f.notes.value.trim(),
    });
    if (!it.title) return toast('Bitte einen Titel eingeben');
    await saveItem(it);
    toast(`„${it.title}“ gespeichert`);
    if (e.submitter && e.submitter.dataset.next) addFlow(it.status);
    else closeSheet();
  };
}

function readImage(file, maxW = 600) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = rej;
    img.src = url;
  });
}

/* =========================================================
   Export / Import
   ========================================================= */
async function shareOrDownload(filename, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportJSON() {
  const data = { app: 'bluray-sammlung', version: 1, exportedAt: new Date().toISOString(), items: state.items };
  shareOrDownload(`bluray-sammlung-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}

function exportCSV() {
  const cols = [['status', 'Liste'], ['title', 'Titel'], ['originalTitle', 'Originaltitel'], ['year', 'Jahr'], ['format', 'Format'], ['steelbook', 'Steelbook'],
    ['edition', 'Edition'], ['genres', 'Genres'], ['director', 'Regie'], ['fsk', 'FSK'], ['runtime', 'Laufzeit'], ['ean', 'EAN'],
    ['rating', 'Bewertung'], ['watched', 'Gesehen'], ['price', 'Kaufpreis'], ['targetPrice', 'Zielpreis'], ['notes', 'Notizen']];
  const cell = (v) => {
    if (Array.isArray(v)) v = v.join(', ');
    if (typeof v === 'boolean') v = v ? 'ja' : 'nein';
    return '"' + String(v ?? '').replace(/"/g, '""') + '"';
  };
  const rows = [cols.map((c) => cell(c[1])).join(';')].concat(state.items.map((it) =>
    cols.map(([k]) => cell(k === 'status' ? (it.status === 'wishlist' ? 'Wunschliste' : 'Sammlung') : it[k])).join(';')));
  shareOrDownload('bluray-sammlung.csv', '﻿' + rows.join('\r\n'), 'text/csv');
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items)) throw new Error();
    if (!confirm(`${items.length} Einträge importieren? Vorhandene Einträge mit gleicher ID werden überschrieben.`)) return;
    for (const raw of items) {
      if (!raw || !raw.title) continue;
      const it = newItem(raw);
      const i = state.items.findIndex((x) => x.id === it.id);
      if (i >= 0) state.items[i] = it; else state.items.push(it);
      await DB.put(it);
    }
    render();
    toast('Import abgeschlossen');
  } catch {
    toast('Datei konnte nicht gelesen werden');
  }
}

/* =========================================================
   Events
   ========================================================= */
document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('.tabbar [data-tab]');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    state.search = '';
    window.scrollTo(0, 0);
    render();
    return;
  }
  const a = e.target.closest('[data-action]');
  if (!a || a.closest('#editForm')) return;
  const { action, id, v } = a.dataset;

  switch (action) {
    case 'add': addFlow(); break;
    case 'close-sheet': closeSheet(); break;
    case 'filters': filterSheet(); break;
    case 'toggle-format':
      state.formats.has(v) ? state.formats.delete(v) : state.formats.add(v);
      render(); break;
    case 'toggle-steel': state.steelbook = !state.steelbook; render(); break;
    case 'all-formats': state.formats.clear(); state.steelbook = false; render(); break;
    case 'sort': state.sort = v; store.set('sort', v); render(); filterSheet(); break;
    case 'watched-filter': state.watched = v; render(); filterSheet(); break;
    case 'fsk-filter': state.fsk.has(v) ? state.fsk.delete(v) : state.fsk.add(v); render(); filterSheet(); break;
    case 'genre-filter': state.genres.has(v) ? state.genres.delete(v) : state.genres.add(v); render(); filterSheet(); break;
    case 'reset-filters':
      state.formats.clear(); state.genres.clear(); state.fsk.clear(); state.watched = 'all'; state.steelbook = false; state.search = '';
      render();
      if (!$('#sheetWrap').hidden) closeSheet();
      break;
    case 'detail': detailSheet(id); break;
    case 'edit': editSheet(state.items.find((x) => x.id === id), false); break;
    case 'delete': {
      const it = state.items.find((x) => x.id === id);
      if (it && confirm(`„${it.title}“ wirklich löschen?`)) { await deleteItem(id); closeSheet(); toast('Gelöscht'); }
      break;
    }
    case 'rate': {
      const it = state.items.find((x) => x.id === id);
      it.rating = it.rating === +v ? 0 : +v;
      await saveItem(it);
      $$('.stars button').forEach((b) => b.classList.toggle('on', +b.dataset.v <= it.rating));
      break;
    }
    case 'bought': {
      const it = state.items.find((x) => x.id === id);
      it.status = 'collection';
      it.addedAt = Date.now();
      await saveItem(it);
      closeSheet();
      toast(`„${it.title}“ ist jetzt in deiner Sammlung 🎉`);
      break;
    }
    case 'title-search': stopScanner(); searchStep({ ean: '', target: a.dataset.target, query: '', format: 'Blu-ray', steelbook: false }); break;
    case 'pick': pickResult(+a.dataset.i); break;
    case 'manual': manualFromCtx(); break;
    case 'save-key': {
      const key = $('#tmdbKey').value.trim();
      store.set('tmdbKey', key);
      const st = $('#keyStatus');
      if (!key) { st.textContent = '⚠️ Noch kein Key'; break; }
      st.textContent = 'Teste …';
      try { await tmdb('/configuration'); st.textContent = '✅ Key funktioniert'; } catch (err) { st.textContent = '❌ ' + err.message; }
      break;
    }
    case 'save-proxy': store.set('eanProxy', $('#eanProxy').value.trim()); toast('Gespeichert'); break;
    case 'export': exportJSON(); break;
    case 'export-csv': exportCSV(); break;
    case 'import': $('#importFile').click(); break;
    case 'wipe':
      if (confirm('Wirklich ALLE Filme löschen?') && confirm('Sicher? Das kann nicht rückgängig gemacht werden.')) {
        await DB.clear(); state.items = []; render(); toast('Alles gelöscht');
      }
      break;
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.matches('[data-action="toggle-watched"]')) {
    const it = state.items.find((x) => x.id === e.target.dataset.id);
    it.watched = e.target.checked;
    await saveItem(it);
  }
  if (e.target.id === 'importFile' && e.target.files[0]) {
    await importJSON(e.target.files[0]);
    e.target.value = '';
  }
});

let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  state.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const area = $('#listArea');
    if (area) area.innerHTML = listAreaHTML(state.tab);
  }, 150);
});

/* =========================================================
   Start
   ========================================================= */
(async function init() {
  try {
    await DB.open();
    state.items = await DB.all();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty"><p>Speicher nicht verfügbar (${esc(err && err.message)}). Privates Surfen deaktivieren?</p></div>`;
    return;
  }
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
