'use strict';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEF = { space: 'Lightricks/ltx-2-distilled', text: 'https://text.pollinations.ai' };
const S = { abort: false, busy: false, blob: null, client: null, ep: null, proj: null };
const EXAMPLE = 'Dos gatos humanizados, una chica llamada Luna y un chico llamado Mateo, sentados en una cafetería. Luna le cuenta un chiste a Mateo y él se ríe a carcajadas.';

/* ---------- ajustes ---------- */
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
function cfg() { return { space: lsGet('ri_space', DEF.space), text: lsGet('ri_text', DEF.text), tok: lsGet('ri_tok', '') }; }

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  $('log').appendChild(d);
  $('log').scrollTop = 1e9;
}
function progress(p) { $('pb').style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; }

/* ---------- almacenamiento del proyecto (IndexedDB) ---------- */
const DB = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('rodolfoia', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
};
const saveProj = () => DB.set('proj', S.proj).catch(() => {});

/* ---------- guion: un prompt de vídeo por clip ---------- */
async function makeClipPrompts(userPrompt, n, sec) {
  const sys = `You write prompts for an AI video model that generates video AND synchronized audio from text (LTX). Return ONLY valid JSON: {"titulo":"...","clips":[{"prompt":"..."}]}.
Exactly ${n} clips that continue one story, in order. Each "prompt" is ONE flowing paragraph in English, present tense, 70-120 words:
- Re-describe every visible character in full, with IDENTICAL wording in every clip (species or person, fur/hair, eyes, clothes, distinctive features), so they look the same across clips. Same setting and lighting unless the story moves.
- Describe camera, movement, body language and facial expressions.
- Then the spoken dialogue, in SPANISH, inside double quotes, naming who speaks and their voice, e.g.: The girl cat says in Spanish in a bright feminine voice: "..." Then the boy cat answers in Spanish in a warm deep masculine voice: "...". Female characters always have feminine voices, male characters masculine voices.
- Each clip lasts about ${sec} seconds: at most 1-2 short spoken lines (under 12 words each) per clip.
- If someone laughs, describe the laugh and include it in the audio, e.g. He bursts out laughing: "¡Jajajaja!".
- No subtitles or text on screen. If the user already wrote dialogue, keep it word for word in Spanish. If no joke or story is given, invent a funny one with a punchline.`;
  const r = await fetch(cfg().text + '/openai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }], response_format: { type: 'json_object' }, seed: Math.floor(Math.random() * 1e6) })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  let txt = j.choices[0].message.content;
  txt = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
  const g = JSON.parse(txt);
  const clips = (g.clips || []).map(c => String(c.prompt || '').trim()).filter(Boolean);
  if (!clips.length) throw new Error('guion vacío');
  return { title: g.titulo || 'RodolfoIA', prompts: clips };
}

/* ---------- lectura de la API del espacio ---------- */
function allEndpoints(info) {
  const out = [];
  for (const [k, v] of Object.entries(info.named_endpoints || {})) out.push({ name: k, info: v });
  for (const [k, v] of Object.entries(info.unnamed_endpoints || {})) if (v && v.parameters) out.push({ name: Number(k), info: v });
  return out;
}
function pickEndpoint(info) {
  let best = null, bestScore = -1;
  for (const e of allEndpoints(info)) {
    const ps = e.info.parameters || [], rs = e.info.returns || [];
    const hasVideo = rs.some(r => /video/i.test(r.component || ''));
    const hasPrompt = ps.some(p => /prompt/i.test(p.parameter_name || p.label || '') && !/negative/i.test(p.parameter_name || p.label || ''));
    if (!hasVideo || !hasPrompt) continue;
    let sc = 1;
    if (/generate|video|text/i.test(String(e.name))) sc += 2;
    if (/image|audio_to|a2v|retake|extend/i.test(String(e.name))) sc -= 1;
    sc -= ps.filter(p => !p.parameter_has_default).length * 0.1;
    if (sc > bestScore) { best = e; bestScore = sc; }
  }
  return best;
}
function buildArgs(ep, prompt, sec) {
  const args = {}, missing = []; let promptSet = false;
  for (const p of ep.info.parameters) {
    const n = String(p.parameter_name || p.label || '').toLowerCase();
    if (!promptSet && /prompt/.test(n) && !/negative/.test(n)) { args[p.parameter_name] = prompt; promptSet = true; continue; }
    if (/duration|seconds|length/.test(n) && !/frame/.test(n)) { args[p.parameter_name] = sec; continue; }
    if (/(generate|with|enable).*audio|^audio$/.test(n) && /bool/i.test(String((p.python_type && p.python_type.type) || p.type || ''))) { args[p.parameter_name] = true; continue; }
    if (!p.parameter_has_default) missing.push(p.parameter_name);
  }
  return { args, missing };
}
function findUrl(o) {
  if (!o) return null;
  if (typeof o === 'string') return /^https?:/.test(o) ? o : null;
  if (Array.isArray(o)) { for (const x of o) { const u = findUrl(x); if (u) return u; } return null; }
  if (typeof o === 'object') {
    if (typeof o.url === 'string') return o.url;
    for (const k of ['video', 'value', 'data']) if (o[k]) { const u = findUrl(o[k]); if (u) return u; }
  }
  return null;
}
const isQuota = m => /quota|zerogpu|gpu (limit|time)|exceeded|too many|unauthorized|sign in|log in/i.test(String(m));

/* ---------- conexión y generación de un clip ---------- */
async function connect() {
  if (S.client && S.ep) return;
  const c = cfg();
  const opts = {};
  if (c.tok && /^hf_/.test(c.tok)) { opts.token = c.tok; opts.hf_token = c.tok; }
  log('Conectando con el modelo de vídeo (' + c.space + ')… puede tardar si está «dormido».');
  S.client = await window.GradioClient.connect(c.space, opts);
  const info = await S.client.view_api();
  S.ep = pickEndpoint(info);
  if (!S.ep) { S.client = null; throw new Error('No encuentro en ese espacio una función de texto a vídeo. Pulsa «Ver cómo se llama al espacio» en Ajustes.'); }
  log('Función encontrada: ' + S.ep.name, 'o');
}
async function genClip(prompt, sec) {
  await connect();
  const { args, missing } = buildArgs(S.ep, prompt, sec);
  if (missing.length) log('Aviso: parámetros sin valor por defecto: ' + missing.join(', '), 'e');
  let data = null, lastLog = 0;
  const job = S.client.submit(S.ep.name, args);
  for await (const m of job) {
    if (S.abort) { try { job.cancel(); } catch (e) {} throw new Error('cancelado'); }
    if (m.type === 'status') {
      if (m.stage === 'error') throw new Error(m.message || 'error del espacio');
      if (Date.now() - lastLog > 8000) {
        lastLog = Date.now();
        if (m.stage === 'pending') log('  en cola' + (m.position != null ? ` (puesto ${m.position + 1})` : '') + (m.eta ? ` · ~${Math.round(m.eta)} s` : ''));
        else if (m.stage === 'generating') log('  generando…');
      }
    } else if (m.type === 'data') data = m.data;
  }
  const url = findUrl(data);
  if (!url) throw new Error('el espacio no devolvió un vídeo');
  const r = await fetch(url);
  if (!r.ok) throw new Error('no pude descargar el clip (HTTP ' + r.status + ')');
  const b = await r.blob();
  if (b.size < 1000) throw new Error('clip vacío');
  return b;
}

/* ---------- unir clips (reproduce y graba) ---------- */
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function mergeClips(blobs) {
  const cv = $('cv'), ctx = cv.getContext('2d');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC(); await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const mkVideo = b => new Promise((res, rej) => {
    const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(b);
    v.onloadedmetadata = () => res(v); v.onerror = () => rej(new Error('clip no reproducible'));
  });
  const first = await mkVideo(blobs[0]);
  cv.width = first.videoWidth || 768; cv.height = first.videoHeight || 512;
  const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 } : {});
  const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.onstop = r);
  rec.start(1000);
  for (let i = 0; i < blobs.length && !S.abort; i++) {
    const v = i === 0 ? first : await mkVideo(blobs[i]);
    const src = ac.createMediaElementSource(v); src.connect(dest);
    log(`Uniendo clip ${i + 1}/${blobs.length}…`);
    await new Promise(res => {
      v.onended = res; v.onerror = res;
      const draw = () => { if (v.ended || S.abort) return; ctx.drawImage(v, 0, 0, cv.width, cv.height); requestAnimationFrame(draw); };
      v.play().then(draw).catch(res);
    });
    progress((i + 1) / blobs.length);
  }
  await sleep(200);
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  try { await ac.close(); } catch (e) {}
  return new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] });
}

/* ---------- interfaz de clips y resultado ---------- */
function showClips() {
  const box = $('clips'); box.textContent = '';
  const done = S.proj.clips.filter(Boolean).length;
  S.proj.clips.forEach((b, i) => {
    if (!b) return;
    const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.src = URL.createObjectURL(b);
    const l = document.createElement('div'); l.className = 'note'; l.textContent = 'Clip ' + (i + 1);
    box.appendChild(l); box.appendChild(v);
  });
  $('out').classList.toggle('hide', done === 0);
  $('merge').classList.toggle('hide', done === 0);
}
async function doMerge() {
  const blobs = S.proj.clips.filter(Boolean);
  if (!blobs.length) return;
  S.abort = false; $('merge').disabled = true; $('go').disabled = true;
  $('cv').classList.remove('hide'); $('vid').classList.add('hide'); $('save').classList.add('hide');
  try {
    log('Montando el vídeo final (se graba a tiempo real)…');
    const out = await mergeClips(blobs);
    S.blob = out;
    $('vid').src = URL.createObjectURL(out);
    $('cv').classList.add('hide'); $('vid').classList.remove('hide'); $('save').classList.remove('hide');
    log(`¡Vídeo final listo! ${(out.size / 1048576).toFixed(1)} MB`, 'o');
  } catch (e) { log('Error al unir: ' + e.message, 'e'); }
  $('merge').disabled = false; $('go').disabled = false;
}

/* ---------- flujo principal ---------- */
async function run(resume) {
  if (S.busy) return;
  const c = cfg();
  const tok = $('tok').value.trim(); lsSet('ri_tok', tok);
  if (!resume && !$('prompt').value.trim()) { log('Escribe primero qué quieres que pase.', 'e'); return; }
  const sec = Math.max(3, Math.min(10, parseInt($('sec').value) || 6));
  const n = Math.max(1, Math.min(40, parseInt($('n').value) || 3));
  S.abort = false; S.busy = true; S.blob = null;
  $('go').disabled = true; $('stop').classList.remove('hide'); $('resume').classList.add('hide');
  $('log').textContent = ''; progress(0);
  try {
    if (!resume) {
      log('1/2 Escribiendo el guion de cada clip…');
      let sc;
      try { sc = await makeClipPrompts($('prompt').value.trim(), n, sec); }
      catch (e) { log('No pude generar el guion con IA (' + e.message + '). Uso tu texto tal cual en un solo clip.', 'e'); sc = { title: 'RodolfoIA', prompts: [$('prompt').value.trim()] }; }
      S.proj = { prompt: $('prompt').value.trim(), sec, prompts: sc.prompts, clips: sc.prompts.map(() => null), title: sc.title, space: c.space };
      await saveProj();
      log(`Guion listo: ${sc.prompts.length} clip(s).`, 'o');
    }
    const P = S.proj;
    showClips();
    for (let i = 0; i < P.prompts.length; i++) {
      if (P.clips[i]) continue;
      if (S.abort) throw new Error('cancelado');
      log(`2/2 Generando clip ${i + 1}/${P.prompts.length}…`);
      try {
        P.clips[i] = await genClip(P.prompts[i], P.sec);
      } catch (e) {
        if (e.message === 'cancelado') throw e;
        if (isQuota(e.message)) {
          await saveProj();
          throw new Error(`Se agotó la cuota gratuita de hoy (${e.message}). Tienes ${P.clips.filter(Boolean).length} clip(s) guardados. Vuelve más tarde o mañana y pulsa «Continuar». Poner tu clave de Hugging Face aumenta la cuota.`);
        }
        throw e;
      }
      await saveProj(); showClips();
      progress((i + 1) / P.prompts.length);
      log(`Clip ${i + 1} listo.`, 'o');
    }
    log('Todos los clips listos. Montando el vídeo final…', 'o');
    await doMerge();
    await DB.del('proj').catch(() => {});
  } catch (e) {
    log(e.message === 'cancelado' ? 'Cancelado. Lo generado queda guardado.' : 'Error: ' + e.message, 'e');
    if (S.proj) { await saveProj(); showClips(); }
  } finally {
    S.busy = false; $('go').disabled = false; $('stop').classList.add('hide');
  }
}

async function showResume() {
  let p = null;
  try { p = await DB.get('proj'); } catch (e) {}
  if (p && p.prompts && p.clips && p.clips.some(x => !x)) {
    S.proj = p;
    $('rinfo').textContent = `«${(p.prompt || '').slice(0, 80)}» — ${p.clips.filter(Boolean).length} de ${p.clips.length} clips hechos.`;
    $('resume').classList.remove('hide');
    showClips();
  }
}

/* ---------- guardar / compartir ---------- */
async function saveVideo() {
  if (!S.blob) return;
  const ext = S.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const fname = `rodolfoia-${Date.now()}.${ext}`;
  try {
    const f = new File([S.blob], fname, { type: S.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'RodolfoIA' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(S.blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- diagnóstico ---------- */
async function showApi() {
  $('log').textContent = '';
  try {
    S.client = null; S.ep = null;
    const c = cfg();
    const opts = c.tok && /^hf_/.test(c.tok) ? { token: c.tok, hf_token: c.tok } : {};
    const cl = await window.GradioClient.connect(c.space, opts);
    const info = await cl.view_api();
    for (const e of allEndpoints(info)) {
      log('• ' + e.name + '  →  ' + (e.info.returns || []).map(r => r.component).join(', '));
      for (const p of e.info.parameters || []) log(`    ${p.parameter_name} [${p.component}] ${p.parameter_has_default ? '= ' + JSON.stringify(p.parameter_default) : '(obligatorio)'}`);
    }
    const ep = pickEndpoint(info);
    log(ep ? 'Elegida: ' + ep.name : 'Ninguna función válida de texto a vídeo.', ep ? 'o' : 'e');
  } catch (e) { log('Error: ' + e.message, 'e'); }
}

window.addEventListener('DOMContentLoaded', () => {
  const c = cfg();
  $('tok').value = c.tok; $('space').value = c.space; $('u_text').value = c.text;
  $('go').onclick = () => run(false);
  $('rgo').onclick = () => run(true);
  $('rdel').onclick = async () => { await DB.del('proj').catch(() => {}); S.proj = null; $('resume').classList.add('hide'); $('clips').textContent = ''; $('out').classList.add('hide'); };
  $('stop').onclick = () => { S.abort = true; };
  $('merge').onclick = doMerge;
  $('save').onclick = saveVideo;
  $('api').onclick = showApi;
  $('ex').onclick = () => { $('prompt').value = EXAMPLE; };
  $('space').onchange = () => { lsSet('ri_space', $('space').value.trim()); S.client = null; S.ep = null; };
  $('u_text').onchange = () => lsSet('ri_text', $('u_text').value.trim());
  $('reset').onclick = () => { ['ri_space', 'ri_text'].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); $('space').value = DEF.space; $('u_text').value = DEF.text; S.client = null; S.ep = null; log('Valores restaurados.'); };
  showResume();
});
