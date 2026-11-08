(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const main = $('#main');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

  // ---------- Etat ----------
  let recettes = ls.get('recettes', []), planning = ls.get('planning', {}), courses = ls.get('courses', { items: [] });
  let loaded = false, syncState = 'local'; // local | on | off
  let route = { view: 'liste' };
  let filter = ls.get('filtre', { q: '', tag: '' });
  let weekStart;

  // ---------- Stockage : local (telephone) ou Supabase (partage famille) ----------
  const CFG = window.RECETTES_CONFIG || {};
  const online = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  // Le carnet = la famille. Son identifiant secret est dans le lien de partage.
  let carnet = ls.get('carnet', null);
  const store = {
    // Cle "publishable" (sb_publishable_...) : apikey suffit ; ancienne cle JWT (eyJ...) : aussi en Authorization
    headers(extra) { const h = { apikey: CFG.SUPABASE_ANON_KEY, 'x-carnet': carnet }; if (/^eyJ/.test(CFG.SUPABASE_ANON_KEY)) h.Authorization = 'Bearer ' + CFG.SUPABASE_ANON_KEY; return Object.assign(h, extra || {}); },
    async rest(path, opts) {
      const res = await fetch(CFG.SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, opts, { headers: this.headers(Object.assign({ 'Content-Type': 'application/json' }, opts && opts.headers)) }));
      if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 120)); }
      return res.status === 204 ? null : res.json();
    },
    async refresh() {
      if (!online) { loaded = true; return; }
      try {
        const [r, p, c] = await Promise.all([
          this.rest('recettes?select=data&order=updated_at'), this.rest('planning?select=date,data'), this.rest('courses?select=data')]);
        recettes = r.map(x => x.data); planning = {}; p.forEach(x => { planning[x.date] = x.data; }); courses = c[0] ? c[0].data : { items: [] };
        ls.set('recettes', recettes); ls.set('planning', planning); ls.set('courses', courses);
        syncState = 'on'; loaded = true; await this.flush();
      } catch (e) { syncState = 'off'; loaded = true; }
      // Ne pas ecraser un formulaire en cours de saisie ni une feuille ouverte
      if (!['ajout', 'edit'].includes(route.view) && !$('#sheet')) render();
    },
    // Ecriture : locale tout de suite, puis envoyee ; en cas d'echec elle attend dans une file et repart au prochain refresh
    queue: ls.get('file-attente', []),
    async send(op) {
      if (!online) return true;
      try {
        if (op.t === 'recette') await this.rest('recettes', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: op.id, carnet, data: op.data, updated_at: new Date().toISOString() }) });
        else if (op.t === 'recette-del') await this.rest('recettes?id=eq.' + encodeURIComponent(op.id), { method: 'DELETE' });
        else if (op.t === 'jour') await this.rest('planning', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: carnet + '_' + op.id, carnet, date: op.id, data: op.data, updated_at: new Date().toISOString() }) });
        else if (op.t === 'courses') await this.rest('courses', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ carnet, data: op.data, updated_at: new Date().toISOString() }) });
        syncState = 'on'; return true;
      } catch (e) { syncState = 'off'; this.queue.push(op); ls.set('file-attente', this.queue); return false; }
    },
    async flush() { const q = this.queue; this.queue = []; ls.set('file-attente', []); for (const op of q) await this.send(op); },
    async uploadPhoto(blob, id) {
      if (!online) return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      const path = carnet + '/' + id + '-' + Date.now().toString(36) + '.jpg';
      const res = await fetch(CFG.SUPABASE_URL + '/storage/v1/object/photos/' + path, { method: 'POST', headers: this.headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }), body: blob });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return path;
    },
    async deletePhoto(p) { if (!online || !p || p.startsWith('data:')) return; try { await fetch(CFG.SUPABASE_URL + '/storage/v1/object/photos/' + p, { method: 'DELETE', headers: this.headers() }); } catch (e) {} }
  };
  const photoUrl = p => p.startsWith('data:') ? p : CFG.SUPABASE_URL + '/storage/v1/object/public/photos/' + p;
  function shareLink() { const u = new URL(location.href); u.search = ''; u.hash = 'carnet=' + carnet; return u.toString(); }

  async function saveRecette(rec, msg) {
    const i = recettes.findIndex(x => x.id === rec.id); if (i >= 0) recettes[i] = rec; else recettes.push(rec);
    ls.set('recettes', recettes); render(); if (msg) toast(msg);
    const ok = await store.send({ t: 'recette', id: rec.id, data: rec }); if (!ok) toast('Hors ligne : sera envoyé plus tard'); return true;
  }
  async function deleteRecette(r) {
    recettes = recettes.filter(x => x.id !== r.id); ls.set('recettes', recettes);
    await store.send({ t: 'recette-del', id: r.id }); if (r.photo) store.deletePhoto(r.photo);
  }
  async function savePlanDay(k, body) { planning[k] = body; ls.set('planning', planning); await store.send({ t: 'jour', id: k, data: body }); return true; }
  async function saveCourses() { ls.set('courses', courses); await store.send({ t: 'courses', data: courses }); return true; }

  // Reduit la photo (max 1400 px, JPEG) avant envoi : une photo d'iPhone fait 3-5 Mo
  function shrink(file, max) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { const k = Math.min(1, (max || 1400) / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob(b => b ? res(b) : rej(new Error('canvas')), 'image/jpeg', 0.82); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
      img.src = url;
    });
  }

  // ---------- Dates / planning ----------
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function monday(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  weekStart = monday(new Date());
  const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const dayLabel = d => d.getDate() + ' ' + MOIS[d.getMonth()];
  const dayOf = k => planning[k] || { date: k, midi: [], soir: [] };
  const norm = s => s.toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/(\w)s\b/g, '$1').replace(/\s+/g, ' ').trim();
  // Agrege les ingredients des repas de la semaine (meme nom + meme unite = une ligne)
  function buildShopping(start) {
    const acc = new Map();
    for (let i = 0; i < 7; i++) {
      const d = dayOf(iso(addDays(start, i)));
      for (const e of [...(d.midi || []), ...(d.soir || [])]) {
        const r = recettes.find(x => x.id === e.id); if (!r) continue;
        const f = r.portions && e.portions ? e.portions / r.portions : 1;
        for (const ing of r.ingredients || []) {
          if (ing.header) continue;
          const k = norm(ing.name) + '|' + (ing.unit || '').toLowerCase();
          const cur = acc.get(k) || { k, name: ing.name, unit: ing.unit || '', qty: 0, from: new Set() };
          if (ing.qty != null) cur.qty += ing.qty * f;
          cur.from.add(r.titre); acc.set(k, cur);
        }
      }
    }
    return [...acc.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')).map(c => ({ k: c.k, texte: [c.qty ? fmtQty(c.qty) : '', c.qty ? c.unit : '', c.name].filter(Boolean).join(' '), done: false, manuel: false, pour: [...c.from].join(', ') }));
  }

  // ---------- Analyse d'une legende TikTok / texte colle ----------
  const UNITS = ['kg', 'g', 'mg', 'l', 'cl', 'ml', 'dl', 'c\\.? ?à ?s\\.?', 'c\\.? ?à ?c\\.?', 'càs', 'càc', 'cas', 'cac', 'cs', 'cc', 'cuill[eè]res? à (?:soupe|café)', 'cuill[eè]res?', 'tasses?', 'verres?', 'pinc[ée]es?', 'sachets?', 'tranches?', 'gousses?', 'bo[iî]tes?', 'bottes?', 'branches?', 'brins?', 'feuilles?', 'pots?', 'paquets?', 'rouleaux?', 'filets?', 'poign[ée]es?', 'morceaux?', 'cubes?', 'zestes?', 'pièces?', 'pcs?', 'oz', 'lb', 'tbsp', 'tsp', 'cups?'];
  const UNIT_RE = new RegExp('^(' + UNITS.join('|') + ')\\b\\.?', 'i');
  const FRAC = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅕': 0.2, '⅛': 0.125 };
  const QTY_RE = /^((?:\d+[.,]?\d*\s*(?:[½⅓⅔¼¾⅕⅛]|\/\s*\d+)?)|[½⅓⅔¼¾⅕⅛])\s*/;
  const STEP_VERBS = /\b(m[ée]lang|ajout|vers|cui|fai|laiss|pr[ée]chauff|enfourn|incorpor|bat|fouett|coup|[ée]pluch|hach|r[ée]serv|sal|poivr|servi|d[ée]pos|[ée]tal|retir|remu|porter|chauff|mettre|mets|mettez|disposer|dispose|m[ée]langer|couvr|[ée]goutt|rinc|assaisonn|d[ée]gust|saupoudr|napp|garni|dorer|dor[ée]|griller|frire|mijot|bouill|pétri|p[ée]trir|former|façonn|rouler|placer|plac|laver|lav|tailler|émincer|[ée]minc|verser|cuire|refroidir|d[ée]mouler|r[ée]p[ée]ter|mixer|mix|presser|press|r[ée]duire|goûter|go[uû]t)/i;

  function parseQty(s) {
    s = s.trim();
    if (FRAC[s] != null) return FRAC[s];
    const m = s.match(/^(\d+)\s*\/\s*(\d+)$/); if (m) return +m[1] / +m[2];
    const m2 = s.match(/^(\d+)\s*([½⅓⅔¼¾⅕⅛])$/); if (m2) return +m2[1] + FRAC[m2[2]];
    const m3 = s.match(/^(\d+)\s*(\d+)\s*\/\s*(\d+)$/); if (m3) return +m3[1] + (+m3[2] / +m3[3]);
    const n = parseFloat(s.replace(',', '.')); return isNaN(n) ? null : n;
  }
  function parseIngredient(line) {
    let raw = line.replace(/^[\s\-–•*▪️◦●✅☑️✔️🔸🔹👉]+/, '').trim();
    let qty = null, unit = '', name = raw;
    const qm = raw.match(QTY_RE);
    if (qm) {
      qty = parseQty(qm[1]); let rest = raw.slice(qm[0].length).trim();
      const um = rest.match(UNIT_RE);
      if (um) { unit = um[1].replace(/\s+/g, ' '); rest = rest.slice(um[0].length).trim().replace(/^(de |d'|d’|d )/i, ''); }
      name = rest;
    } else {
      const m = raw.match(/^(.+?)\s*[:\-–]\s*(\d[\d.,]*)\s*([a-zA-Zàâçéèêëîïôûùüÿ.]*)\s*$/);
      if (m) { name = m[1].trim(); qty = parseQty(m[2]); unit = m[3]; }
    }
    return { qty, unit, name: name || raw, raw };
  }
  function parseText(text) {
    const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const out = { titre: '', portions: null, ingredients: [], etapes: [], tags: [], source: '', notes: [] };
    let mode = 'auto';
    const urlRe = /https?:\/\/\S+/i;
    for (const l0 of lines) {
      let l = l0;
      const u = l.match(urlRe); if (u && !out.source) { out.source = u[0]; l = l.replace(urlRe, '').trim(); if (!l) continue; }
      const tags = l.match(/#[\p{L}\p{N}_]+/gu); if (tags) { out.tags.push(...tags.map(t => t.slice(1).toLowerCase())); l = l.replace(/#[\p{L}\p{N}_]+/gu, '').trim(); if (!l) continue; }
      const p = l.match(/(?:pour|x)\s*(\d+)\s*(?:personnes?|pers\.?|parts?|portions?|gourmands?)/i) || l.match(/(\d+)\s*(?:personnes?|pers\.?|parts?|portions?)/i);
      if (p && !out.portions) { out.portions = +p[1]; if (/^(pour|x)?\s*\d+\s*(personnes?|pers\.?|parts?|portions?)\s*:?$/i.test(l)) continue; }
      const low = l.toLowerCase().replace(/[:\s*_📝🥣🍳👩‍🍳🧑‍🍳📋✨🔥👇]+$/g, '');
      if (/^(ingr[ée]dients?|il te faut|il vous faut|il faut|liste des courses|pour la (p[âa]te|sauce|garniture|cr[èe]me))/.test(low)) { mode = 'ingr'; if (/^(ingr[ée]dients?|il te faut|il vous faut|il faut|liste des courses)$/.test(low)) continue; if (/^pour la/.test(low)) { out.ingredients.push({ qty: null, unit: '', name: l.replace(/[:\s]+$/, ''), raw: l, header: true }); continue; } }
      if (/^(pr[ée]paration|[ée]tapes?|recette|instructions?|r[ée]alisation|m[ée]thode|la recette|comment faire|d[ée]roul[ée])$/.test(low)) { mode = 'step'; continue; }
      if (/^(astuce|conseil|note|bon app|abonne|suis-moi|n'oublie|n'h[ée]site|lien en bio|like|commente|enregistre|partage|tag|dis-moi|et toi|vous aimez|si tu aimes)/i.test(low)) { mode = 'notes'; out.notes.push(l); continue; }
      if (!out.titre && mode === 'auto' && !QTY_RE.test(l) && l.length < 70) { out.titre = l.replace(/[🍝🍰🥗🍲🥘🍜🍛🍕🧁🍪🥞🍞🥐🍮😍🤤❤️✨🔥💛👇⬇️]/gu, '').replace(/\s*[-–:,(]*\s*(?:pour|x)?\s*\d+\s*(?:personnes?|pers\.?|parts?|portions?|gourmands?)\s*\)?\s*$/i, '').replace(/\s*[!.]+$/, '').trim(); continue; }
      const numbered = l.match(/^(?:[ée]tape\s*)?(\d{1,2})\s*[.)\-:]\s*(.+)$/i);
      const looksIngr = QTY_RE.test(l) && l.length < 90 && !(numbered && numbered[2].length > 45 && STEP_VERBS.test(numbered[2]));
      let kind;
      if (mode === 'ingr') kind = (numbered && numbered[2].length > 45 && STEP_VERBS.test(numbered[2])) ? 'step' : 'ingr';
      else if (mode === 'step') kind = looksIngr && !STEP_VERBS.test(l) ? 'ingr' : 'step';
      else if (mode === 'notes') kind = 'notes';
      else kind = looksIngr ? 'ingr' : (STEP_VERBS.test(l) || numbered || l.length > 60 ? 'step' : (l.length < 40 ? 'ingr' : 'step'));
      if (kind === 'ingr') { out.ingredients.push(parseIngredient(l)); mode = mode === 'auto' ? 'ingr' : mode; }
      else if (kind === 'step') { out.etapes.push(numbered ? numbered[2] : l.replace(/^[\-–•*]+\s*/, '')); mode = mode === 'auto' ? 'step' : mode; }
      else out.notes.push(l);
    }
    out.tags = [...new Set(out.tags)].filter(t => !/^(fyp|pourtoi|foryou|viral|recette|recettes|recipe|food|cuisine|tiktokfood|foodtiktok|easyrecipe|cooking|foodie|pourtoipage|tiktok)$/.test(t)).slice(0, 6);
    return out;
  }

  // ---------- Quantites & portions ----------
  function fmtQty(q) {
    if (q == null) return '';
    const whole = Math.floor(q + 1e-9), frac = q - whole;
    const near = [[0, ''], [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾'], [1, '']];
    for (const [v, s] of near) if (Math.abs(frac - v) < 0.04) { const w = whole + (v === 1 ? 1 : 0); return (w || !s ? w : '') + s; }
    return (Math.round(q * 10) / 10).toString().replace('.', ',');
  }
  function ingrToText(list) { return list.map(i => i.header ? i.name + ' :' : [fmtQty(i.qty), i.unit, i.name].filter(Boolean).join(' ')).join('\n'); }
  function textToIngr(t) { return t.split('\n').map(l => l.trim()).filter(Boolean).map(l => /:\s*$/.test(l) ? { qty: null, unit: '', name: l.replace(/\s*:\s*$/, ''), raw: l, header: true } : parseIngredient(l)); }

  // ---------- Routing (hash) ----------
  function go(view, id) { route = { view, id }; const h = id ? view + '-' + id : view; if (location.hash !== '#' + h) history.replaceState(null, '', '#' + h); render(); window.scrollTo(0, 0); }
  function readHash() { const h = (location.hash || '#liste').slice(1); const m = h.match(/^(liste|ajout|favoris|planning|courses|reglages|r|edit)(?:-(.+))?$/); route = m ? { view: m[1], id: m[2] } : { view: 'liste' }; }
  window.addEventListener('hashchange', () => { if (!handleEntry()) { readHash(); render(); } });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

  // ---------- Rendu ----------
  const EMOJI = [['gateau|cake|cookie|brownie|muffin|tarte|crêpe|crepe|dessert|chocolat|mousse|tiramisu|flan|biscuit', '🍰'], ['pâtes|pates|pasta|spaghetti|lasagne|gnocchi', '🍝'], ['salade|bowl|poke', '🥗'], ['soupe|velouté|veloute|bouillon|ramen|pho', '🍲'], ['poulet|chicken|dinde', '🍗'], ['boeuf|bœuf|steak|burger', '🍔'], ['saumon|poisson|crevette|thon|cabillaud', '🐟'], ['pizza|focaccia', '🍕'], ['riz|risotto|curry|wok', '🍛'], ['pain|brioche|baguette|bun', '🍞'], ['oeuf|œuf|omelette', '🍳'], ['smoothie|jus|boisson|cocktail|latte', '🥤'], ['pancake|gaufre|waffle', '🥞'], ['légume|legume|courgette|aubergine|ratatouille|vegan|végé', '🥦']];
  function emojiFor(r) { const s = ((r.titre || '') + ' ' + (r.tags || []).join(' ')).toLowerCase(); for (const [re, e] of EMOJI) if (new RegExp(re).test(s)) return e; return '🍽️'; }
  const syncBadge = () => online ? `<button type="button" class="sync ${syncState}" id="sync-btn" data-go="reglages">${syncState === 'on' ? 'Synchronisé' : syncState === 'off' ? 'Hors ligne' : '…'}</button>` : `<button type="button" class="sync" data-go="reglages">Juste moi</button>`;

  function render() {
    document.querySelectorAll('.tabs button').forEach(b => b.toggleAttribute('aria-current', false));
    const tab = ['ajout', 'planning', 'courses'].includes(route.view) ? route.view : 'liste';
    $('#tab-' + tab).setAttribute('aria-current', 'page');
    closeSheet();
    if (route.view === 'r') return renderFiche(route.id);
    if (route.view === 'planning') return renderPlanning();
    if (route.view === 'courses') return renderCourses();
    if (route.view === 'reglages') return renderReglages();
    if (route.view === 'ajout' || route.view === 'edit') return renderForm(route.view === 'edit' ? recettes.find(r => r.id === route.id) : null);
    renderListe(route.view === 'favoris');
  }

  function renderListe(favOnly) {
    const allTags = [...new Set(recettes.flatMap(r => r.tags || []))].sort();
    let list = recettes.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (favOnly) list = list.filter(r => r.favori);
    const q = filter.q.trim().toLowerCase();
    if (q) list = list.filter(r => (r.titre + ' ' + (r.tags || []).join(' ') + ' ' + (r.ingredients || []).map(i => i.name).join(' ')).toLowerCase().includes(q));
    if (filter.tag) list = list.filter(r => (r.tags || []).includes(filter.tag));
    main.innerHTML = `<section class="view">
      <div class="topbar"><div><div class="eyebrow">${favOnly ? 'Mes favoris' : 'Carnet de recettes'}</div><h1>${favOnly ? 'Favoris' : 'Mes Recettes'}</h1></div>
        <div class="kv" style="align-items:flex-end"><span class="eyebrow">${recettes.length} recette${recettes.length > 1 ? 's' : ''}</span>${syncBadge()}</div></div>
      <div class="search"><input type="search" id="q" placeholder="Rechercher un plat, un ingrédient…" value="${esc(filter.q)}" aria-label="Rechercher"></div>
      <div class="chips" id="chips"><button type="button" class="chip ${favOnly ? 'on' : ''}" id="chip-fav">★ Favoris</button>${allTags.map(t => `<button type="button" class="chip ${filter.tag === t ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>
      <div class="list" id="list">${list.length ? list.map(r => `<button type="button" class="card" data-id="${esc(r.id)}">
          <span class="thumb" aria-hidden="true">${r.photo ? `<img src="${esc(photoUrl(r.photo))}" alt="">` : emojiFor(r)}</span>
          <span><span class="title">${esc(r.titre)}</span><span class="meta">${r.portions ? `<span>${r.portions} pers.</span>` : ''}${(r.ingredients || []).length ? `<span>${r.ingredients.filter(i => !i.header).length} ingrédients</span>` : ''}${r.source ? `<span>${sourceName(r.source)}</span>` : ''}</span></span>
          <span class="star">${r.favori ? '★' : ''}</span></button>`).join('') :
        `<div class="empty"><span class="big">${favOnly ? '☆' : '🥘'}</span>${!loaded && online ? '<span>Chargement…</span>' : favOnly ? '<span>Aucun favori pour l’instant. Ouvre une recette et touche l’étoile.</span>' : (q || filter.tag ? '<span>Rien ne correspond à cette recherche.</span>' : `<span>Ton carnet est vide.</span><button type="button" class="btn primary" data-go="ajout">Ajouter ma première recette</button>`)}</div>`}</div>
    </section>`;
    $('#q').addEventListener('input', e => { filter.q = e.target.value; ls.set('filtre', filter); const pos = e.target.selectionStart; render(); const q2 = $('#q'); q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (err) {} });
    $('#chip-fav').addEventListener('click', () => go(favOnly ? 'liste' : 'favoris'));
    main.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => { filter.tag = filter.tag === b.dataset.tag ? '' : b.dataset.tag; ls.set('filtre', filter); render(); }));
    bindCards();
  }
  function bindCards() { main.querySelectorAll('.card').forEach(b => b.addEventListener('click', () => go('r', b.dataset.id))); main.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go))); }
  function sourceName(u) { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h.includes('tiktok') ? 'TikTok' : h.includes('instagram') ? 'Instagram' : h.split('.')[0]; } catch (e) { return 'lien'; } }

  function renderFiche(id) {
    const r = recettes.find(x => x.id === id);
    if (!r) { main.innerHTML = `<section class="view"><div class="topbar"><button type="button" class="icon-btn" data-go="liste" aria-label="Retour">${backSvg}</button><h1>Recette introuvable</h1></div><div class="empty">${loaded ? 'Elle a peut-être été supprimée.' : 'Chargement…'}</div></section>`; bindCards(); return; }
    const base = r.portions || 0;
    const key = 'portions-' + r.id; let target = ls.get(key, base) || base;
    const doneKey = 'done-' + r.id; const done = new Set(ls.get(doneKey, []));
    const draw = () => {
      const f = base && target ? target / base : 1;
      main.innerHTML = `<section class="view">
        <div class="topbar"><button type="button" class="icon-btn" data-go="liste" aria-label="Retour">${backSvg}</button><div class="grow"></div>
          <button type="button" class="icon-btn ${r.favori ? 'on' : ''}" id="fav" aria-label="Favori" aria-pressed="${!!r.favori}">${r.favori ? starFull : starSvg}</button>
          <button type="button" class="icon-btn" id="edit" aria-label="Modifier">${editSvg}</button></div>
        <div class="hero ${r.photo ? 'has-photo' : ''}">${r.photo ? `<img class="photo" src="${esc(photoUrl(r.photo))}" alt="">` : ''}<div class="hero-body">${r.photo ? '' : `<span class="emoji" aria-hidden="true">${emojiFor(r)}</span>`}<h1>${esc(r.titre)}</h1>
          <div class="chips">${(r.tags || []).map(t => `<span class="chip">#${esc(t)}</span>`).join('')}</div>
          ${r.source ? `<a href="${esc(r.source)}" target="_blank" rel="noopener">Voir la vidéo d’origine (${sourceName(r.source)}) ↗</a>` : ''}</div></div>
        ${base ? `<div class="portions"><span>Pour <b class="n">${target}</b> personne${target > 1 ? 's' : ''}${target !== base ? ` <span class="eyebrow">(recette : ${base})</span>` : ''}</span>
          <span class="stepper"><button type="button" id="minus" aria-label="Moins">−</button><button type="button" id="plus" aria-label="Plus">+</button></span></div>` : ''}
        ${(r.ingredients || []).length ? `<div class="section"><div class="section-head"><h2>Ingrédients</h2>${target !== base ? '<button type="button" class="btn small" id="reset">Quantités d’origine</button>' : ''}</div>
          <ul class="ingr">${r.ingredients.map(i => i.header ? `<li style="grid-template-columns:1fr"><b>${esc(i.name)}</b></li>` : `<li><span class="q ${i.qty != null && f !== 1 ? 'scaled' : ''}">${i.qty != null ? fmtQty(i.qty * f) + (i.unit ? ' ' + esc(i.unit) : '') : (i.unit ? esc(i.unit) : '')}</span><span>${esc(i.name)}</span></li>`).join('')}</ul></div>` : ''}
        ${(r.etapes || []).length ? `<div class="section"><div class="section-head"><h2>Préparation</h2>${done.size ? '<button type="button" class="btn small" id="uncheck">Tout décocher</button>' : ''}</div>
          <ol class="steps">${r.etapes.map((s, i) => `<li class="${done.has(i) ? 'done' : ''}" data-i="${i}"><button type="button" class="num" aria-label="Étape ${i + 1} ${done.has(i) ? 'faite' : ''}"></button><span class="txt">${esc(s)}</span></li>`).join('')}</ol></div>` : ''}
        ${r.notes ? `<div class="section"><h2>Notes</h2><div class="notes">${esc(r.notes)}</div></div>` : ''}
        <div class="section" id="plan-zone"><button type="button" class="btn" id="plan">Ajouter au planning</button></div>
        <div class="section" id="del-zone"><button type="button" class="btn danger" id="del">Supprimer cette recette</button></div>
      </section>`;
      bindCards();
      $('#plan').addEventListener('click', () => {
        const today = new Date(); today.setHours(0, 0, 0, 0); let slot = 'soir';
        $('#plan-zone').innerHTML = `<div class="plan-panel"><b>Ajouter au planning</b>
          <div class="field"><label for="plan-day">Quel jour ?</label><select id="plan-day">${Array.from({ length: 14 }, (_, i) => { const d = addDays(today, i); return `<option value="${iso(d)}">${i === 0 ? 'Aujourd’hui' : i === 1 ? 'Demain' : JOURS[(d.getDay() + 6) % 7]} ${dayLabel(d)}</option>`; }).join('')}</select></div>
          <div class="seg" id="plan-slot"><button type="button" data-s="midi">Midi</button><button type="button" data-s="soir" class="on">Soir</button></div>
          <div class="field"><label for="plan-p">Pour combien de personnes ?</label><input type="number" id="plan-p" min="1" inputmode="numeric" value="${target || base || 2}"></div>
          <div class="row"><button type="button" class="btn primary" id="plan-ok">Ajouter</button><button type="button" class="btn" id="plan-no">Annuler</button></div></div>`;
        main.querySelectorAll('#plan-slot button').forEach(b => b.addEventListener('click', () => { slot = b.dataset.s; main.querySelectorAll('#plan-slot button').forEach(x => x.classList.toggle('on', x === b)); }));
        $('#plan-no').addEventListener('click', draw);
        $('#plan-ok').addEventListener('click', async () => {
          const k = $('#plan-day').value, body = { ...dayOf(k), date: k }; body[slot] = [...(body[slot] || []), { id: r.id, portions: +$('#plan-p').value || null }];
          await savePlanDay(k, body); toast('Ajouté au planning'); draw();
        });
      });
      $('#fav').addEventListener('click', () => saveRecette({ ...r, favori: !r.favori }, 'Favori ' + (r.favori ? 'retiré' : 'ajouté')));
      $('#edit').addEventListener('click', () => go('edit', r.id));
      const mi = $('#minus'), pl = $('#plus'), rs = $('#reset');
      if (mi) mi.addEventListener('click', () => { if (target > 1) { target--; ls.set(key, target); draw(); } });
      if (pl) pl.addEventListener('click', () => { target++; ls.set(key, target); draw(); });
      if (rs) rs.addEventListener('click', () => { target = base; ls.set(key, target); draw(); });
      main.querySelectorAll('.steps li').forEach(li => li.addEventListener('click', () => { const i = +li.dataset.i; done.has(i) ? done.delete(i) : done.add(i); ls.set(doneKey, [...done]); draw(); }));
      const un = $('#uncheck'); if (un) un.addEventListener('click', () => { done.clear(); ls.set(doneKey, []); draw(); });
      $('#del').addEventListener('click', () => {
        $('#del-zone').innerHTML = `<div class="confirm"><b>Supprimer « ${esc(r.titre)} » ?</b><span class="hint">Cette action est définitive.</span><div class="row"><button type="button" class="btn danger" id="del-ok">Oui, supprimer</button><button type="button" class="btn" id="del-no">Annuler</button></div></div>`;
        $('#del-no').addEventListener('click', draw);
        $('#del-ok').addEventListener('click', async () => { await deleteRecette(r); toast('Recette supprimée'); go('liste'); });
      });
    };
    draw();
  }

  function renderForm(r, prefill) {
    const draft = r ? null : ls.get('brouillon', null);
    const d = r || draft || { titre: '', portions: '', ingredients: [], etapes: [], tags: [], source: '', notes: '' };
    main.innerHTML = `<section class="view">
      <div class="topbar">${r ? `<button type="button" class="icon-btn" data-go="r" data-id="${esc(r.id)}" aria-label="Retour">${backSvg}</button>` : ''}<h1>${r ? 'Modifier' : 'Nouvelle recette'}</h1></div>
      ${r ? '' : `<div class="field"><label for="paste">Colle la légende TikTok (ou n’importe quel texte de recette)</label>
        <textarea id="paste" placeholder="Partage la vidéo TikTok → raccourci « Recette » → tout arrive ici automatiquement. Sinon, colle le texte.">${esc(prefill || '')}</textarea>
        <span class="hint">J’en extrais le titre, les ingrédients, les étapes et le nombre de personnes. Tu corriges ensuite si besoin.</span>
        <div class="row"><button type="button" class="btn primary" id="analyse">Analyser le texte</button></div><div id="apercu"></div></div>`}
      <div class="field"><label for="titre">Titre</label><input type="text" id="titre" value="${esc(d.titre)}" placeholder="Pâtes au pesto de brocoli"></div>
      <div class="field" id="photo-zone"><label for="photo">Photo</label>
        <div class="photo-field"><span class="pv" id="pv">${d.photo ? `<img src="${esc(photoUrl(d.photo))}" alt="">` : '📷'}</span>
          <div class="row"><label class="btn small" for="photo">${d.photo ? 'Changer la photo' : 'Ajouter une photo'}</label><input type="file" id="photo" accept="image/*"><button type="button" class="btn small" id="photo-rm" ${d.photo ? '' : 'hidden'}>Retirer</button></div></div></div>
      <div class="row"><div class="field grow"><label for="portions">Nombre de personnes</label><input type="number" id="portions" min="1" inputmode="numeric" value="${esc(d.portions || '')}" placeholder="4"></div>
        <div class="field grow"><label for="tags">Tags (séparés par des virgules)</label><input type="text" id="tags" value="${esc((d.tags || []).join(', '))}" placeholder="rapide, végé, dessert"></div></div>
      <div class="field"><label for="ingr">Ingrédients <span class="hint">(un par ligne : quantité, unité, nom)</span></label><textarea id="ingr" placeholder="200 g farine&#10;2 œufs&#10;1 c. à soupe huile d'olive">${esc(ingrToText(d.ingredients || []))}</textarea></div>
      <div class="field"><label for="etapes">Préparation <span class="hint">(une étape par ligne)</span></label><textarea id="etapes" placeholder="Préchauffer le four à 180°C.&#10;Mélanger la farine et les œufs.">${esc((d.etapes || []).join('\n'))}</textarea></div>
      <div class="field"><label for="source">Lien de la vidéo / de la recette</label><input type="url" id="source" inputmode="url" value="${esc(d.source || '')}" placeholder="https://www.tiktok.com/…"></div>
      <div class="field"><label for="notes">Notes</label><textarea id="notes" style="min-height:70px" placeholder="Astuces, variantes, ce que j'ai changé…">${esc(d.notes || '')}</textarea></div>
      <div class="row"><button type="button" class="btn primary" id="save">${r ? 'Enregistrer les modifications' : 'Ajouter au carnet'}</button>${r ? '' : '<button type="button" class="btn" id="clear">Vider</button>'}</div>
    </section>`;
    const back = main.querySelector('[data-go="r"]'); if (back) back.addEventListener('click', () => go('r', back.dataset.id));
    const fields = ['titre', 'portions', 'tags', 'ingr', 'etapes', 'source', 'notes'];
    const read = () => ({ titre: $('#titre').value.trim(), portions: +$('#portions').value || null, tags: $('#tags').value.split(/[,;]/).map(t => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean), ingredients: textToIngr($('#ingr').value), etapes: $('#etapes').value.split('\n').map(s => s.trim()).filter(Boolean), source: $('#source').value.trim(), notes: $('#notes').value.trim() });
    if (!r) fields.forEach(f => $('#' + f).addEventListener('input', () => ls.set('brouillon', read())));
    const pasteEl = $('#paste');
    if (pasteEl) {
      const analyse = () => {
        const t = pasteEl.value.trim(); if (!t) return;
        const p = parseText(t);
        if (p.titre) $('#titre').value = p.titre; if (p.portions) $('#portions').value = p.portions;
        if (p.ingredients.length) $('#ingr').value = ingrToText(p.ingredients);
        if (p.etapes.length) $('#etapes').value = p.etapes.join('\n');
        if (p.tags.length) $('#tags').value = p.tags.join(', ');
        if (p.source) $('#source').value = p.source;
        if (p.notes.length) $('#notes').value = p.notes.join('\n');
        ls.set('brouillon', read());
        $('#apercu').innerHTML = `<div class="preview"><b>Trouvé :</b><span>${p.ingredients.filter(i => !i.header).length} ingrédient(s), ${p.etapes.length} étape(s)${p.portions ? ', ' + p.portions + ' personnes' : ''}${p.source ? ', lien ' + sourceName(p.source) : ''}</span><span class="hint">Vérifie les champs ci-dessous avant d’ajouter.</span></div>`;
        $('#titre').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      $('#analyse').addEventListener('click', analyse);
      pasteEl.addEventListener('paste', () => setTimeout(analyse, 50));
      if (prefill) analyse();
    }
    // Photo : fichier choisi garde en memoire, envoye seulement a l'enregistrement
    let newPhoto = null, removePhoto = false;
    $('#photo').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      try { newPhoto = await shrink(f, online ? 1400 : 800); removePhoto = false; $('#pv').innerHTML = `<img src="${URL.createObjectURL(newPhoto)}" alt="">`; $('#photo-rm').hidden = false; }
      catch (err) { toast('Photo illisible'); }
    });
    $('#photo-rm').addEventListener('click', () => { newPhoto = null; removePhoto = true; $('#pv').textContent = '📷'; $('#photo-rm').hidden = true; $('#photo').value = ''; });
    $('#save').addEventListener('click', async () => {
      const v = read();
      if (!v.titre) { toast('Il manque un titre'); $('#titre').focus(); return; }
      const rec = r ? { ...r, ...v, updatedAt: Date.now() } : { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...v, favori: false, createdAt: Date.now(), updatedAt: Date.now() };
      $('#save').disabled = true;
      const oldPhoto = r && r.photo;
      if (newPhoto) {
        if (online) toast('Envoi de la photo…');
        try { rec.photo = await store.uploadPhoto(newPhoto, rec.id); }
        catch (err) { toast('Envoi de la photo impossible (pas de réseau ?)'); $('#save').disabled = false; return; }
      } else if (removePhoto) delete rec.photo;
      await saveRecette(rec, r ? 'Modifications enregistrées' : 'Recette ajoutée');
      if (oldPhoto && oldPhoto !== rec.photo) store.deletePhoto(oldPhoto);
      if (!r) ls.set('brouillon', null); go('r', rec.id);
    });
    const cl = $('#clear'); if (cl) cl.addEventListener('click', () => { ls.set('brouillon', null); renderForm(null); });
  }

  // ---------- Planning ----------
  function renderPlanning() {
    const today = iso(new Date());
    const end = addDays(weekStart, 6);
    const total = Array.from({ length: 7 }, (_, i) => dayOf(iso(addDays(weekStart, i)))).reduce((n, d) => n + (d.midi || []).length + (d.soir || []).length, 0);
    main.innerHTML = `<section class="view">
      <div class="topbar"><div><div class="eyebrow">Repas de la semaine</div><h1>Planning</h1></div>${syncBadge()}</div>
      <div class="weeknav"><button type="button" id="wk-prev" aria-label="Semaine précédente">‹</button><span class="wk">Du ${dayLabel(weekStart)} au ${dayLabel(end)}</span><button type="button" id="wk-next" aria-label="Semaine suivante">›</button></div>
      ${!recettes.length && loaded ? '<div class="banner">Ajoute d’abord des recettes, puis planifie-les ici.</div>' : ''}
      ${Array.from({ length: 7 }, (_, i) => { const d = addDays(weekStart, i), k = iso(d), day = dayOf(k);
        const slot = s => `<div class="slot"><span class="slot-label">${s}</span><div class="slot-items">${(day[s] || []).map((e, j) => { const r = recettes.find(x => x.id === e.id); return `<span class="meal"><button type="button" class="meal-title" data-id="${esc(e.id)}">${esc(r ? r.titre : 'Recette supprimée')}</button>${e.portions ? `<span class="meal-p">${e.portions} p.</span>` : ''}<button type="button" class="meal-rm" data-k="${k}" data-s="${s}" data-j="${j}" aria-label="Retirer">×</button></span>`; }).join('')}<button type="button" class="add-slot" data-k="${k}" data-s="${s}" aria-label="Ajouter un repas ${s} ${JOURS[i]}">+</button></div></div>`;
        return `<div class="day ${k === today ? 'today' : ''}"><div class="day-head"><b>${JOURS[i]}</b><span>${dayLabel(d)}</span></div>${slot('midi')}${slot('soir')}</div>`; }).join('')}
      ${total ? `<button type="button" class="btn primary" id="gen">Faire la liste de courses de cette semaine</button>` : ''}
    </section>`;
    bindCards();
    $('#wk-prev').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderPlanning(); });
    $('#wk-next').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderPlanning(); });
    main.querySelectorAll('.meal-title').forEach(b => b.addEventListener('click', () => go('r', b.dataset.id)));
    main.querySelectorAll('.meal-rm').forEach(b => b.addEventListener('click', async () => { const { k, s, j } = b.dataset; const body = { ...dayOf(k), date: k }; body[s] = (body[s] || []).filter((_, i) => i !== +j); await savePlanDay(k, body); renderPlanning(); }));
    main.querySelectorAll('.add-slot').forEach(b => b.addEventListener('click', () => openPicker(b.dataset.k, b.dataset.s)));
    const g = $('#gen'); if (g) g.addEventListener('click', async () => { if (await generateCourses()) go('courses'); });
  }
  function openPicker(k, s) {
    closeSheet();
    const d = new Date(k + 'T00:00:00');
    const scrim = document.createElement('button'); scrim.className = 'scrim'; scrim.setAttribute('aria-label', 'Fermer'); scrim.addEventListener('click', closeSheet);
    const sh = document.createElement('div'); sh.className = 'sheet'; sh.id = 'sheet';
    let q = '', portions = '';
    const draw = () => {
      const list = recettes.filter(r => !q || r.titre.toLowerCase().includes(q)).sort((a, b) => (b.favori - a.favori) || a.titre.localeCompare(b.titre, 'fr'));
      sh.innerHTML = `<div class="section-head"><h2>${JOURS[(d.getDay() + 6) % 7]} ${dayLabel(d)} · ${s}</h2><button type="button" class="icon-btn" id="sheet-x" aria-label="Fermer">✕</button></div>
        <div class="row"><input type="search" id="pk-q" class="grow" placeholder="Chercher une recette…" value="${esc(q)}" aria-label="Chercher"><input type="number" id="pk-p" min="1" inputmode="numeric" placeholder="pers." value="${esc(portions)}" style="width:5.5em" aria-label="Nombre de personnes"></div>
        <div class="list">${list.length ? list.map(r => `<button type="button" class="card" data-id="${esc(r.id)}"><span class="thumb" aria-hidden="true">${r.photo ? `<img src="${esc(photoUrl(r.photo))}" alt="">` : emojiFor(r)}</span><span><span class="title">${esc(r.titre)}</span><span class="meta">${r.portions ? `<span>${r.portions} pers.</span>` : ''}</span></span><span class="star">${r.favori ? '★' : ''}</span></button>`).join('') : '<div class="empty">Aucune recette.</div>'}</div>`;
      $('#sheet-x').addEventListener('click', closeSheet);
      $('#pk-q').addEventListener('input', e => { q = e.target.value.toLowerCase(); const pos = e.target.selectionStart; draw(); const el = $('#pk-q'); el.focus(); try { el.setSelectionRange(pos, pos); } catch (err) {} });
      $('#pk-p').addEventListener('input', e => { portions = e.target.value; });
      sh.querySelectorAll('.card').forEach(c => c.addEventListener('click', async () => {
        const r = recettes.find(x => x.id === c.dataset.id); const body = { ...dayOf(k), date: k };
        body[s] = [...(body[s] || []), { id: r.id, portions: +portions || r.portions || null }];
        await savePlanDay(k, body); closeSheet(); toast(r.titre + ' → ' + s); renderPlanning();
      }));
    };
    draw(); document.body.append(scrim, sh);
  }
  function closeSheet() { document.querySelectorAll('.sheet, .scrim').forEach(e => e.remove()); }

  // ---------- Courses ----------
  async function generateCourses() {
    const gen = buildShopping(weekStart);
    if (!gen.length) { toast('Aucun ingrédient dans cette semaine'); return false; }
    const old = new Map((courses.items || []).filter(i => !i.manuel).map(i => [i.k, i]));
    const items = gen.map(i => ({ ...i, done: old.has(i.k) ? !!old.get(i.k).done : false })).concat((courses.items || []).filter(i => i.manuel));
    courses = { items, semaine: iso(weekStart) };
    await saveCourses(); toast(gen.length + ' article(s) ajouté(s)'); return true;
  }
  function renderCourses() {
    const items = courses.items || [], left = items.filter(i => !i.done).length;
    const gen = items.filter(i => !i.manuel), man = items.filter(i => i.manuel);
    const li = (i, idx) => `<li class="${i.done ? 'done' : ''}"><button type="button" class="chk" data-i="${idx}" aria-pressed="${!!i.done}" aria-label="Coché">${i.done ? '✓' : ''}</button><span class="txt">${esc(i.texte)}${i.pour ? `<br><span class="hint">${esc(i.pour)}</span>` : ''}</span><button type="button" class="rm" data-i="${idx}" aria-label="Retirer">×</button></li>`;
    main.innerHTML = `<section class="view">
      <div class="topbar"><div><div class="eyebrow">${courses.semaine ? 'Semaine du ' + dayLabel(new Date(courses.semaine + 'T00:00:00')) : 'Liste de courses'}</div><h1>Courses</h1></div><div class="kv" style="align-items:flex-end"><span class="eyebrow">${items.length ? left + ' restant' + (left > 1 ? 's' : '') : ''}</span>${syncBadge()}</div></div>
      <form class="row" id="add-form"><input type="text" id="new-item" class="grow" placeholder="Ajouter un article (ex. : essuie-tout)" aria-label="Nouvel article"><button type="submit" class="btn primary">+</button></form>
      ${!items.length ? `<div class="empty"><span class="big">🧺</span><span>Liste vide. Planifie des repas puis génère la liste, ou ajoute des articles à la main.</span><button type="button" class="btn" data-go="planning">Voir le planning</button></div>` : ''}
      ${gen.length ? `<ul class="shop"><li class="shop-head" style="display:block">Pour les repas planifiés</li>${gen.map(i => li(i, items.indexOf(i))).join('')}</ul>` : ''}
      ${man.length ? `<ul class="shop"><li class="shop-head" style="display:block">Ajouts à la main</li>${man.map(i => li(i, items.indexOf(i))).join('')}</ul>` : ''}
      ${items.length ? `<div class="row"><button type="button" class="btn" id="regen">Régénérer depuis le planning</button>${items.some(i => i.done) ? '<button type="button" class="btn" id="clear-done">Retirer les cochés</button>' : ''}</div>` : ''}
    </section>`;
    bindCards();
    $('#add-form').addEventListener('submit', async e => { e.preventDefault(); const t = $('#new-item').value.trim(); if (!t) return; courses.items = [...items, { k: 'm' + Date.now().toString(36), texte: t, done: false, manuel: true }]; await saveCourses(); renderCourses(); });
    main.querySelectorAll('.chk').forEach(b => b.addEventListener('click', async () => { const i = +b.dataset.i; courses.items = items.map((x, j) => j === i ? { ...x, done: !x.done } : x); renderCourses(); await saveCourses(); }));
    main.querySelectorAll('.rm').forEach(b => b.addEventListener('click', async () => { courses.items = items.filter((_, j) => j !== +b.dataset.i); await saveCourses(); renderCourses(); }));
    const rg = $('#regen'); if (rg) rg.addEventListener('click', async () => { if (await generateCourses()) renderCourses(); });
    const cd = $('#clear-done'); if (cd) cd.addEventListener('click', async () => { courses.items = items.filter(i => !i.done); await saveCourses(); renderCourses(); });
  }

  // ---------- Reglages / partage famille ----------
  function renderReglages() {
    main.innerHTML = `<section class="view">
      <div class="topbar"><button type="button" class="icon-btn" data-go="liste" aria-label="Retour">${backSvg}</button><h1>Partage & réglages</h1></div>
      ${online ? `<div class="section"><h2>Partager avec la famille</h2>
        <p class="hint" style="margin:0">Envoie ce lien (Messages, WhatsApp…). Celui qui l’ouvre voit et modifie le même carnet : recettes, planning, courses. Il peut ensuite l’ajouter à son écran d’accueil.</p>
        <div class="code" id="share-link">${esc(shareLink())}</div>
        <div class="row"><button type="button" class="btn primary" id="copy">Copier le lien</button>${navigator.share ? '<button type="button" class="btn" id="share">Envoyer…</button>' : ''}</div>
        <p class="hint" style="margin:0">Garde ce lien pour toi et tes proches : c’est lui qui donne accès au carnet.</p></div>
      <div class="section"><h2>Synchronisation</h2><div class="banner">${syncState === 'on' ? 'Connecté : tes modifications sont partagées en direct.' : syncState === 'off' ? 'Hors ligne : tes modifications sont gardées sur le téléphone et seront envoyées au retour du réseau.' : 'Connexion en cours…'}${store.queue.length ? ' (' + store.queue.length + ' en attente)' : ''}</div>
        <div class="row"><button type="button" class="btn" id="refresh">Actualiser maintenant</button></div></div>
      <div class="section"><h2>Rejoindre un autre carnet</h2><p class="hint" style="margin:0">Si quelqu’un t’a envoyé son lien, colle-le ici. Attention : tu quittes ton carnet actuel (ses données restent en ligne, tu peux y revenir avec son lien).</p>
        <div class="row"><input type="url" id="join" class="grow" placeholder="https://…#carnet=…" aria-label="Lien du carnet"><button type="button" class="btn" id="join-ok">Rejoindre</button></div></div>`
      : `<div class="section"><h2>Mode « juste moi »</h2><div class="banner">Les recettes sont stockées dans ce téléphone uniquement. Le partage famille s’active quand la base en ligne est configurée (config.js).</div></div>`}
      <div class="section"><h2>Installer sur l’écran d’accueil</h2><p class="hint" style="margin:0">Dans Safari : bouton Partager (carré avec flèche) → « Sur l’écran d’accueil ». L’appli s’ouvre ensuite en plein écran, comme une vraie appli.</p></div>
      <p class="hint">Version 1.0 · ${recettes.length} recette${recettes.length > 1 ? 's' : ''}</p>
    </section>`;
    bindCards();
    const cp = $('#copy'); if (cp) cp.addEventListener('click', async () => { try { await navigator.clipboard.writeText(shareLink()); toast('Lien copié'); } catch (e) { const r = document.createRange(); r.selectNodeContents($('#share-link')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Sélectionne et copie le lien'); } });
    const sh = $('#share'); if (sh) sh.addEventListener('click', () => navigator.share({ title: 'Mes Recettes', text: 'Notre carnet de recettes partagé', url: shareLink() }).catch(() => {}));
    const rf = $('#refresh'); if (rf) rf.addEventListener('click', async () => { await store.refresh(); toast(syncState === 'on' ? 'À jour' : 'Pas de réseau'); });
    const jo = $('#join-ok'); if (jo) jo.addEventListener('click', () => { const m = ($('#join').value || '').match(/carnet=([0-9a-f-]{36})/i); if (!m) { toast('Lien invalide'); return; } setCarnet(m[1]); toast('Carnet rejoint'); go('liste'); store.refresh(); });
  }
  function setCarnet(id) { carnet = id; ls.set('carnet', id); recettes = []; planning = {}; courses = { items: [] }; ls.set('recettes', null); ls.set('planning', null); ls.set('courses', null); }

  let toastT; function toast(m) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = m; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2200); }

  const backSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  const starSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/></svg>';
  const starFull = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/></svg>';
  const editSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16z"/></svg>';

  // ---------- Demarrage ----------
  // Lien d'entree : #carnet=<id> (rejoindre un carnet), #import=<texte encode> (raccourci iOS),
  // ?text=&url= (partage Android). Retourne true si l'entree a ete traitee.
  function handleEntry() {
    const h = location.hash || '';
    const hp = h.match(/carnet=([0-9a-f-]{36})/i);
    if (hp && hp[1] !== carnet) { setCarnet(hp[1]); store.refresh(); }
    const qs = new URLSearchParams(location.search);
    const imp = h.match(/import=([^&]+)/);
    let prefill = '';
    if (imp) { try { prefill = decodeURIComponent(imp[1]); } catch (e) { prefill = ''; } }
    else if (qs.get('text') || qs.get('url')) prefill = [qs.get('title'), qs.get('text'), qs.get('url')].filter(Boolean).join('\n');
    if (prefill) { history.replaceState(null, '', location.pathname + '#ajout'); route = { view: 'ajout' }; ls.set('brouillon', null); render(); renderForm(null, prefill); return true; }
    if (hp) { history.replaceState(null, '', location.pathname + '#liste'); route = { view: 'liste' }; render(); return true; }
    return false;
  }
  if (!carnet) { carnet = uuid(); ls.set('carnet', carnet); }
  if (!handleEntry()) { readHash(); render(); }
  // 3. Synchro
  store.refresh();
  if (online) {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.refresh(); });
    window.addEventListener('online', () => store.refresh());
    setInterval(() => { if (document.visibilityState === 'visible' && !$('#sheet') && !['ajout', 'edit'].includes(route.view)) store.refresh(); }, 45000);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
