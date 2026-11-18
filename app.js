'use strict';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const DEF = {
  text: 'https://text.pollinations.ai',
  image: 'https://image.pollinations.ai/prompt',
  tts: 'https://text.pollinations.ai'
};
const S = { abort: false, busy: false, blob: null, name: 'rodolfoia' };
const FADE = 0.5;   // fundido entre planos (s)
const FPS = 30;
const COLORS = ['#ff7eb6', '#5ec8ff', '#ffd166', '#7ee787', '#c4a1ff', '#ff9f68'];
const EXAMPLE = 'Dos gatos humanizados, una chica llamada Luna y un chico llamado Mateo, sentados en una cafetería. Luna le cuenta un chiste a Mateo y él se ríe a carcajadas, y luego Mateo le cuenta otro y ella se ríe.';

/* ---------- ajustes ---------- */
function cfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('ri_cfg') || '{}'); } catch (e) {}
  return { ...DEF, ...c };
}
function loadCfg() { const c = cfg(); $('u_text').value = c.text; $('u_img').value = c.image; $('u_tts').value = c.tts; }
function saveCfg() {
  try { localStorage.setItem('ri_cfg', JSON.stringify({ text: $('u_text').value.trim(), image: $('u_img').value.trim(), tts: $('u_tts').value.trim() })); } catch (e) {}
}

/* ---------- UI ---------- */
function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  $('log').appendChild(d);
  $('log').scrollTop = 1e9;
}
function progress(p) { $('pb').style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; }

/* ---------- red ---------- */
async function fetchBlob(url, opts, o = {}) {
  const tries = o.tries || 5, timeout = o.timeout || 120000;
  let err;
  for (let t = 0; t < tries; t++) {
    if (S.abort) throw new Error('cancelado');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...(opts || {}), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.blob();
      clearTimeout(to);
      if (o.ok && !o.ok(b)) throw new Error('respuesta no válida (' + (b.type || 'sin tipo') + ')');
      return b;
    } catch (e) {
      clearTimeout(to);
      err = e;
      if (t < tries - 1) await sleep(2500 * (t + 1));
    }
  }
  throw err;
}

/* ---------- guion con personajes ---------- */
async function makeScript(prompt, n, style) {
  const sys = `Eres guionista de vídeos con personajes que dialogan. Responde SOLO con JSON válido con esta forma exacta:
{"titulo":"...","personajes":[{"nombre":"...","genero":"mujer"|"hombre","aspecto":"..."}],"escenas":[{"habla":"nombre del personaje","en_plano":["nombres de los personajes visibles"],"texto":"...","visual":"..."}]}
Reglas:
- "personajes": los que pida el usuario (máximo 5). "aspecto": descripción visual detallada y fija EN INGLÉS (especie o persona, pelaje/pelo, ojos, ropa, rasgos distintivos) para que se dibuje igual en todos los planos. "genero" decide su voz.
- "escenas": exactamente ${n} intervenciones en orden, alternando personajes cuando sea un diálogo. "texto" es lo que dice en voz alta, en español de España, natural, 1 a 3 frases cortas, sin acotaciones ni emojis. Si el usuario ya escribió diálogo, respétalo literalmente.
- Si un personaje se ríe, escribe la risa en el texto (por ejemplo "¡Jajajaja! ¡Qué bueno!") y refléjalo en "visual".
- "visual": EN INGLÉS, el plano concreto (encuadre, expresión, postura, lugar, luz). El personaje que habla suele ir en primer plano; el que escucha puede reaccionar al fondo. Sin texto escrito en la imagen.
- El estilo visual general es: ${style}. Mantén el mismo lugar y ambiente entre planos salvo que la historia cambie de sitio.
- Si no hay chiste ni historia dada, inventa algo gracioso y con final.`;
  const b = await fetchBlob(cfg().text + '/openai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], response_format: { type: 'json_object' }, seed: Math.floor(Math.random() * 1e6) })
  }, { tries: 4 });
  const j = JSON.parse(await b.text());
  let txt = j.choices && j.choices[0] ? j.choices[0].message.content : '';
  txt = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
  const g = JSON.parse(txt);
  const isF = g => /mujer|female|chica|femen|ella/i.test(g), isM = g => /hombre|\bmale\b|chico|mascul|var[oó]n|[eé]l$/i.test(g);
  const chars = (g.personajes || []).filter(p => p && p.nombre).map(p => {
    const gen = String(p.genero || '');
    return { name: String(p.nombre).trim(), female: isF(gen) || !isM(gen), look: String(p.aspecto || '') };
  });
  const scenes = (g.escenas || []).filter(e => e && e.texto).map(e => ({
    who: String(e.habla || '').trim(), inShot: Array.isArray(e.en_plano) ? e.en_plano.map(String) : [],
    text: String(e.texto), visual: String(e.visual || '')
  }));
  if (!scenes.length) throw new Error('la IA devolvió un guion vacío');
  // personajes que aparecen en escenas pero no se declararon
  for (const s of scenes) if (s.who && !chars.some(c => c.name.toLowerCase() === s.who.toLowerCase()))
    chars.push({ name: s.who, female: chars.length % 2 === 0, look: '' });
  return { title: g.titulo || 'RodolfoIA', chars, scenes };
}

function assignVoices(chars) {
  const F = [$('vf').value, ...['nova', 'shimmer', 'fable'].filter(v => v !== $('vf').value)];
  const M = [$('vm').value, ...['onyx', 'echo', 'alloy'].filter(v => v !== $('vm').value)];
  let f = 0, m = 0;
  chars.forEach((c, i) => {
    c.voice = c.female ? F[f++ % F.length] : M[m++ % M.length];
    c.color = COLORS[i % COLORS.length];
  });
}
const findChar = (chars, name) => chars.find(c => c.name.toLowerCase() === String(name).toLowerCase());

/* ---------- recursos por escena ---------- */
async function getImage(prompt, W, H, seed) {
  const url = `${cfg().image}/${encodeURIComponent(prompt)}?width=${W}&height=${H}&seed=${seed}&nologo=true&model=flux`;
  return fetchBlob(url, null, { ok: b => b.type.startsWith('image/') && b.size > 2000 });
}
async function getVoice(text, voice) {
  const url = `${cfg().tts}/${encodeURIComponent(text)}?model=openai-audio&voice=${voice}`;
  return fetchBlob(url, null, { tries: 4, ok: b => b.type.startsWith('audio/') && b.size > 1000 });
}
function shotPrompt(sc, chars, style) {
  const names = sc.inShot.length ? sc.inShot : [sc.who];
  const looks = names.map(n => findChar(chars, n)).filter(Boolean).map(c => `${c.name}: ${c.look}`).join('; ');
  return `${sc.visual}. Characters: ${looks}. ${style}. consistent character design, no text, no watermark`;
}

/* ---------- animación ---------- */
function makeMotion() {
  const zoomIn = Math.random() < 0.5;
  return { s0: zoomIn ? 1.03 : 1.12, s1: zoomIn ? 1.12 : 1.03, px0: rnd(-.5, .5), px1: rnd(-.5, .5), py0: rnd(-.4, .4), py1: rnd(-.4, .4) };
}
function drawImg(ctx, img, m, p, alpha, W, H, pulse) {
  pulse = pulse || 0;
  const iw = img.width, ih = img.height;
  const cover = Math.max(W / iw, H / ih);
  const k = Math.min(1.4, Math.max(0, p));
  const sc = cover * (m.s0 + (m.s1 - m.s0) * k) * (1 + pulse * 0.05);
  const w = iw * sc, h = ih * sc;
  const px = m.px0 + (m.px1 - m.px0) * k, py = m.py0 + (m.py1 - m.py0) * k;
  const x = (W - w) / 2 + Math.max(-1, Math.min(1, px)) * (w - W) / 2;
  const y = (H - h) / 2 + Math.max(-1, Math.min(1, py)) * (h - H) / 2 - pulse * H * 0.012;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, x, y, w, h);
  ctx.globalAlpha = 1;
}
function fallbackImage(W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, W, H);
  gr.addColorStop(0, '#1b1f3b'); gr.addColorStop(1, '#4b2e83');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  return c;
}
function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/), lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function drawSubs(ctx, name, color, text, W, H, alpha) {
  const fs = Math.round(Math.min(W, H) * (W > H ? 0.043 : 0.038));
  ctx.font = `600 ${fs}px system-ui,Roboto,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let lines = wrapLines(ctx, text, W * 0.84);
  if (lines.length > 4) lines = lines.slice(0, 4);
  const lh = fs * 1.3, bh = lines.length * lh + fs * 0.7, y0 = H - bh - H * 0.05;
  ctx.globalAlpha = alpha * 0.6; ctx.fillStyle = '#000';
  ctx.fillRect(W * 0.05, y0, W * 0.9, bh);
  ctx.globalAlpha = alpha; ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + fs * 0.35 + i * lh));
  if (name) {
    ctx.font = `700 ${Math.round(fs * 0.8)}px system-ui,Roboto,sans-serif`;
    const tw = ctx.measureText(name).width + fs, th = fs * 1.1;
    ctx.fillStyle = color || '#7c5cff';
    ctx.fillRect(W * 0.05, y0 - th, tw, th);
    ctx.fillStyle = '#111'; ctx.textAlign = 'left';
    ctx.fillText(name, W * 0.05 + fs * 0.5, y0 - th + th * 0.18);
  }
  ctx.globalAlpha = 1;
}
function estDur(text) { return Math.max(2.5, text.split(/\s+/).length / 2.6); }
function speakLive(text, female) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = 'es-ES';
  const vs = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('es'));
  const v = vs.find(v => (female ? /female|mujer|monica|paulina|helena|elvira/i : /male|jorge|diego|pablo|enrique/i).test(v.name)) || vs[0];
  if (v) u.voice = v;
  u.pitch = female ? 1.25 : 0.8;
  speechSynthesis.speak(u);
}

/* ---------- render + grabación ---------- */
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function render(scenes, chars, W, H, showSubs) {
  const cv = $('cv'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC(); await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const stream = new MediaStream([...cv.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 } : {});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.onstop = r);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  rec.start(1000);

  const loadScene = async s => {
    let img;
    try { img = await createImageBitmap(s.image); } catch (e) { img = fallbackImage(W, H); }
    let buf = null;
    if (s.audio) { try { buf = await ac.decodeAudioData(await s.audio.arrayBuffer()); } catch (e) { buf = null; } }
    return { img, buf };
  };
  const an = ac.createAnalyser(); an.fftSize = 512;
  const td = new Uint8Array(an.fftSize);
  let lv = 0;
  const level = () => {
    an.getByteTimeDomainData(td);
    let sum = 0; for (let i = 0; i < td.length; i++) { const d = (td[i] - 128) / 128; sum += d * d; }
    lv = lv * 0.65 + Math.min(1, Math.sqrt(sum / td.length) * 4) * 0.35;
    return lv;
  };

  let prev = null, nextP = loadScene(scenes[0]);
  for (let i = 0; i < scenes.length && !S.abort; i++) {
    const s = scenes[i];
    const ch = findChar(chars, s.who);
    const { img, buf } = await nextP;
    nextP = i + 1 < scenes.length ? loadScene(scenes[i + 1]) : null;
    const dur = (buf ? buf.duration : estDur(s.text)) + 0.3 + FADE;
    const m = makeMotion();
    let hasAudio = false;
    if (buf) {
      const src = ac.createBufferSource(); src.buffer = buf;
      src.connect(dest); src.connect(ac.destination); src.connect(an);
      src.start(ac.currentTime + FADE * 0.5); hasAudio = true;
    } else { setTimeout(() => speakLive(s.text, ch ? ch.female : true), FADE * 500); }
    log(`${i + 1}/${scenes.length} · ${s.who || 'Narrador'} · ${dur.toFixed(1)} s`);
    progress(0.5 + 0.5 * (i / scenes.length));

    const t0 = performance.now();
    await new Promise(res => {
      const frame = () => {
        if (S.abort) return res();
        const t = (performance.now() - t0) / 1000;
        if (t >= dur) return res();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const a = Math.min(1, t / FADE);
        if (prev && a < 1) drawImg(ctx, prev.img, prev.m, 1 + t / prev.dur, 1, W, H, 0);
        const talking = hasAudio && t > FADE * 0.5 && t < dur - 0.2 ? level() : 0;
        drawImg(ctx, img, m, t / dur, prev ? a : Math.min(1, t / 0.4), W, H, talking);
        if (showSubs) drawSubs(ctx, s.who, ch && ch.color, s.text, W, H, Math.min(1, Math.max(0, (t - FADE * 0.3) / 0.3)));
        requestAnimationFrame(frame);
      };
      frame();
    });
    if (prev && prev.img.close) try { prev.img.close(); } catch (e) {}
    prev = { img, m, dur };
  }
  if (!S.abort && prev) {
    const t0 = performance.now();
    await new Promise(res => {
      const f = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= 0.8) return res();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        drawImg(ctx, prev.img, prev.m, 1 + t / prev.dur, 1 - t / 0.8, W, H, 0);
        requestAnimationFrame(f);
      };
      f();
    });
  }
  await sleep(300);
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  try { speechSynthesis.cancel(); } catch (e) {}
  try { await ac.close(); } catch (e) {}
  return new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] });
}

/* ---------- flujo principal ---------- */
async function create() {
  const prompt = $('prompt').value.trim();
  if (!prompt) { log('Escribe primero qué quieres que pase.', 'e'); return; }
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { log('Este navegador no permite grabar vídeo. Prueba con Chrome.', 'e'); return; }
  const n = Math.max(2, Math.min(200, parseInt($('n').value) || 10));
  const [W, H] = $('fmt').value.split('x').map(Number);
  const style = $('style').value;
  S.abort = false; S.busy = true; S.blob = null;
  $('go').disabled = true; $('stop').classList.remove('hide');
  $('log').textContent = ''; progress(0);
  $('out').classList.add('hide'); $('save').classList.add('hide'); $('vid').classList.add('hide'); $('cv').classList.remove('hide');
  let wake = null;
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  try {
    log('1/3 Escribiendo el guion y creando los personajes…');
    let script;
    try { script = await makeScript(prompt, n, style); }
    catch (e) { throw new Error('No pude generar el guion (' + e.message + '). Comprueba la conexión o pulsa «Probar servicios».'); }
    const { chars, scenes } = script;
    assignVoices(chars);
    S.name = (script.title || 'rodolfoia').toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'rodolfoia';
    log(`Guion listo: ${scenes.length} intervenciones. Personajes: ` + chars.map(c => `${c.name} (${c.female ? 'voz femenina' : 'voz masculina'})`).join(', '), 'o');
    const seed0 = Math.floor(Math.random() * 1e6);
    let voiceFails = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (S.abort) throw new Error('cancelado');
      const ch = findChar(chars, scenes[i].who);
      log(`2/3 Plano ${i + 1}/${scenes.length}: imagen y voz de ${scenes[i].who || 'Narrador'}…`);
      const [im, au] = await Promise.allSettled([
        getImage(shotPrompt(scenes[i], chars, style), W, H, seed0),
        getVoice(scenes[i].text, ch ? ch.voice : $('vf').value)
      ]);
      if (im.status === 'fulfilled') scenes[i].image = im.value;
      else { scenes[i].image = new Blob(); log('  imagen no disponible, uso un fondo: ' + im.reason.message, 'e'); }
      if (au.status === 'fulfilled') scenes[i].audio = au.value;
      else { voiceFails++; log('  voz no disponible: ' + au.reason.message, 'e'); }
      progress(0.5 * ((i + 1) / scenes.length));
    }
    if (voiceFails) log(`Aviso: ${voiceFails} intervención(es) sin voz grabable; se oirá la voz del dispositivo solo mientras se graba, pero no quedará en el archivo.`, 'e');
    if (S.abort) throw new Error('cancelado');
    log('3/3 Montando y grabando el vídeo (a tiempo real)…');
    $('out').classList.remove('hide');
    const blob = await render(scenes, chars, W, H, $('subs').checked);
    if (S.abort) throw new Error('cancelado');
    S.blob = blob;
    const v = $('vid'); v.src = URL.createObjectURL(blob);
    $('cv').classList.add('hide'); v.classList.remove('hide'); $('save').classList.remove('hide');
    progress(1);
    log(`¡Vídeo listo! ${(blob.size / 1048576).toFixed(1)} MB`, 'o');
  } catch (e) {
    log(e.message === 'cancelado' ? 'Cancelado.' : 'Error: ' + e.message, 'e');
    try { speechSynthesis.cancel(); } catch (x) {}
  } finally {
    S.busy = false; $('go').disabled = false; $('stop').classList.add('hide');
    if (wake) try { wake.release(); } catch (e) {}
  }
}

/* ---------- guardar / compartir ---------- */
async function saveVideo() {
  if (!S.blob) return;
  const ext = S.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const fname = `${S.name}-${Date.now()}.${ext}`;
  try {
    const f = new File([S.blob], fname, { type: S.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'RodolfoIA' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(S.blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- diagnóstico ---------- */
async function testServices() {
  $('log').textContent = ''; saveCfg(); S.abort = false;
  const t = async (name, f) => { try { const r = await f(); log(`✔ ${name}: ${r}`, 'o'); } catch (e) { log(`✘ ${name}: ${e.message}`, 'e'); } };
  await t('Texto', async () => { const b = await fetchBlob(cfg().text + '/openai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: 'Di hola' }] }) }, { tries: 1, timeout: 40000 }); return (await b.text()).slice(0, 60); });
  await t('Imagen', async () => { const b = await getImage('a red fox in a forest', 512, 512, 1); return b.type + ' ' + b.size + ' B'; });
  await t('Voz', async () => { const b = await getVoice('Hola, esto es una prueba.', 'nova'); return b.type + ' ' + b.size + ' B'; });
}

window.addEventListener('DOMContentLoaded', () => {
  loadCfg();
  $('go').onclick = create;
  $('stop').onclick = () => { S.abort = true; try { speechSynthesis.cancel(); } catch (e) {} };
  $('save').onclick = saveVideo;
  $('test').onclick = testServices;
  $('ex').onclick = () => { $('prompt').value = EXAMPLE; };
  $('reset').onclick = () => { try { localStorage.removeItem('ri_cfg'); } catch (e) {} loadCfg(); log('Valores restaurados.'); };
  ['u_text', 'u_img', 'u_tts'].forEach(id => $(id).addEventListener('change', saveCfg));
});
