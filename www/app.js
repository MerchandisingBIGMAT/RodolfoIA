'use strict';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const DEF = {
  text: 'https://text.pollinations.ai',
  image: 'https://image.pollinations.ai/prompt',
  tts: 'https://text.pollinations.ai'
};
const S = { abort: false, busy: false, blob: null, name: 'video-ia' };
const FADE = 0.7;      // segundos de fundido entre escenas
const FPS = 30;

/* ---------- ajustes ---------- */
function cfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('vi_cfg') || '{}'); } catch (e) {}
  return { ...DEF, ...c };
}
function loadCfg() { const c = cfg(); $('u_text').value = c.text; $('u_img').value = c.image; $('u_tts').value = c.tts; }
function saveCfg() {
  try { localStorage.setItem('vi_cfg', JSON.stringify({ text: $('u_text').value.trim(), image: $('u_img').value.trim(), tts: $('u_tts').value.trim() })); } catch (e) {}
}

/* ---------- utilidades de UI ---------- */
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

/* ---------- guion ---------- */
function splitFallback(text, n) {
  const sents = text.replace(/\s+/g, ' ').match(/[^.!?¡¿]+[.!?]*/g) || [text];
  const per = Math.max(1, Math.ceil(sents.length / n));
  const out = [];
  for (let i = 0; i < sents.length; i += per) out.push(sents.slice(i, i + per).join(' ').trim());
  return out.filter(Boolean);
}

async function makeScript(prompt, n, style) {
  if ($('own').checked) {
    const paras = prompt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const parts = paras.length > 1 ? paras : splitFallback(prompt, n);
    return { title: 'Mi vídeo', scenes: parts.map(t => ({ text: t, visual: t })) };
  }
  const sys = `Eres guionista de vídeos. Responde SOLO con JSON válido con esta forma: {"titulo":"...","escenas":[{"narracion":"...","visual":"..."}]}. ` +
    `Exactamente ${n} escenas que cuenten una historia o explicación con principio, desarrollo y final. ` +
    `"narracion": en español de España, 1 a 3 frases (20-45 palabras), natural para locutar, sin emojis ni marcas. ` +
    `"visual": descripción en inglés de UNA imagen concreta (sujeto, entorno, luz, tipo de plano), sin texto escrito en la imagen. Estilo: ${style}.`;
  try {
    const b = await fetchBlob(cfg().text + '/openai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], response_format: { type: 'json_object' }, seed: Math.floor(Math.random() * 1e6) })
    }, { tries: 3 });
    const j = JSON.parse(await b.text());
    let txt = j.choices && j.choices[0] ? j.choices[0].message.content : '';
    txt = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    const g = JSON.parse(txt);
    const sc = (g.escenas || []).filter(e => e && e.narracion).map(e => ({ text: String(e.narracion), visual: String(e.visual || e.narracion) }));
    if (sc.length) return { title: g.titulo || 'Video IA', scenes: sc };
    throw new Error('guion vacío');
  } catch (e) {
    log('No pude generar el guion con IA (' + e.message + '). Divido tu texto en escenas.', 'e');
    return { title: 'Video IA', scenes: splitFallback(prompt, n).map(t => ({ text: t, visual: t })) };
  }
}

/* ---------- recursos por escena ---------- */
async function getImage(visual, style, W, H, seed) {
  const url = `${cfg().image}/${encodeURIComponent(visual + ', ' + style + ', no text, no watermark')}?width=${W}&height=${H}&seed=${seed}&nologo=true&model=flux`;
  return fetchBlob(url, null, { ok: b => b.type.startsWith('image/') && b.size > 2000 });
}
async function getVoice(text, voice) {
  const url = `${cfg().tts}/${encodeURIComponent(text)}?model=openai-audio&voice=${voice}`;
  return fetchBlob(url, null, { tries: 4, ok: b => b.type.startsWith('audio/') && b.size > 1000 });
}

/* ---------- animación ---------- */
function makeMotion() {
  const zoomIn = Math.random() < 0.5;
  return { s0: zoomIn ? 1.03 : 1.2, s1: zoomIn ? 1.2 : 1.03, px0: rnd(-.7, .7), px1: rnd(-.7, .7), py0: rnd(-.7, .7), py1: rnd(-.7, .7) };
}
function drawImg(ctx, img, m, p, alpha, W, H) {
  const iw = img.width, ih = img.height;
  const cover = Math.max(W / iw, H / ih);
  const k = Math.min(1.4, Math.max(0, p));
  const sc = cover * (m.s0 + (m.s1 - m.s0) * k);
  const w = iw * sc, h = ih * sc;
  const px = m.px0 + (m.px1 - m.px0) * k, py = m.py0 + (m.py1 - m.py0) * k;
  const x = (W - w) / 2 + Math.max(-1, Math.min(1, px)) * (w - W) / 2;
  const y = (H - h) / 2 + Math.max(-1, Math.min(1, py)) * (h - H) / 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, x, y, w, h);
  ctx.globalAlpha = 1;
}
function fallbackImage(W, H, text) {
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
function drawSubs(ctx, text, W, H, alpha) {
  const fs = Math.round(Math.min(W, H) * (W > H ? 0.045 : 0.04));
  ctx.font = `600 ${fs}px system-ui,Roboto,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let lines = wrapLines(ctx, text, W * 0.86);
  if (lines.length > 4) lines = lines.slice(0, 4);
  const lh = fs * 1.3, bh = lines.length * lh + fs * 0.7, y0 = H - bh - H * 0.05;
  ctx.globalAlpha = alpha * 0.55; ctx.fillStyle = '#000';
  ctx.fillRect(W * 0.05, y0, W * 0.9, bh);
  ctx.globalAlpha = alpha; ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + fs * 0.35 + i * lh));
  ctx.globalAlpha = 1;
}
function estDur(text) { return Math.max(3, text.split(/\s+/).length / 2.5); }
function speakLive(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = 'es-ES';
  const v = speechSynthesis.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith('es'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

/* ---------- render + grabación ---------- */
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function render(scenes, W, H, showSubs) {
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
    try { img = await createImageBitmap(s.image); } catch (e) { img = fallbackImage(W, H, s.text); }
    let buf = null;
    if (s.audio) { try { buf = await ac.decodeAudioData(await s.audio.arrayBuffer()); } catch (e) { buf = null; } }
    return { img, buf };
  };

  let prev = null, nextP = loadScene(scenes[0]);
  for (let i = 0; i < scenes.length && !S.abort; i++) {
    const s = scenes[i];
    const { img, buf } = await nextP;
    nextP = i + 1 < scenes.length ? loadScene(scenes[i + 1]) : null;
    const dur = (buf ? buf.duration : estDur(s.text)) + 0.35 + FADE;
    const m = makeMotion();
    if (buf) {
      const src = ac.createBufferSource(); src.buffer = buf;
      src.connect(dest); src.connect(ac.destination);
      src.start(ac.currentTime + FADE * 0.6);
    } else { setTimeout(() => speakLive(s.text), FADE * 600); }
    log(`Escena ${i + 1}/${scenes.length} · ${dur.toFixed(1)} s`);
    progress(0.5 + 0.5 * (i / scenes.length));

    const t0 = performance.now();
    await new Promise(res => {
      const frame = () => {
        if (S.abort) return res();
        const t = (performance.now() - t0) / 1000;
        if (t >= dur) return res();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const a = Math.min(1, t / FADE);
        if (prev && a < 1) drawImg(ctx, prev.img, prev.m, 1 + t / prev.dur, 1, W, H);
        drawImg(ctx, img, m, t / dur, prev ? a : Math.min(1, t / 0.5), W, H);
        if (showSubs) drawSubs(ctx, s.text, W, H, Math.min(1, Math.max(0, (t - FADE * 0.4) / 0.4)));
        requestAnimationFrame(frame);
      };
      frame();
    });
    if (prev && prev.img.close) try { prev.img.close(); } catch (e) {}
    prev = { img, m, dur };
  }
  // fundido final a negro
  if (!S.abort && prev) {
    const t0 = performance.now();
    await new Promise(res => {
      const f = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= 0.8) return res();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        drawImg(ctx, prev.img, prev.m, 1 + t / prev.dur, 1 - t / 0.8, W, H);
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
  if (!prompt) { log('Escribe primero una idea o un guion.', 'e'); return; }
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { log('Este dispositivo no permite grabar vídeo desde la app.', 'e'); return; }
  const n = Math.max(2, Math.min(200, parseInt($('n').value) || 8));
  const [W, H] = $('fmt').value.split('x').map(Number);
  const style = $('style').value, voice = $('voice').value;
  S.abort = false; S.busy = true; S.blob = null;
  $('go').disabled = true; $('stop').classList.remove('hide');
  $('log').textContent = ''; progress(0);
  $('out').classList.add('hide'); $('save').classList.add('hide'); $('vid').classList.add('hide'); $('cv').classList.remove('hide');
  let wake = null;
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  try {
    log('1/3 Escribiendo el guion…');
    const script = await makeScript(prompt, n, style);
    S.name = (script.title || 'video-ia').toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video-ia';
    const scenes = script.scenes;
    log(`Guion listo: ${scenes.length} escenas.`, 'o');
    const seed0 = Math.floor(Math.random() * 1e6);
    let voiceFails = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (S.abort) throw new Error('cancelado');
      log(`2/3 Escena ${i + 1}/${scenes.length}: imagen y voz…`);
      const [im, au] = await Promise.allSettled([
        getImage(scenes[i].visual, style, W, H, seed0 + i),
        getVoice(scenes[i].text, voice)
      ]);
      if (im.status === 'fulfilled') scenes[i].image = im.value;
      else { scenes[i].image = new Blob(); log('  imagen no disponible, uso un fondo: ' + im.reason.message, 'e'); }
      if (au.status === 'fulfilled') scenes[i].audio = au.value;
      else { voiceFails++; log('  voz no disponible: ' + au.reason.message, 'e'); }
      progress(0.5 * ((i + 1) / scenes.length));
    }
    if (voiceFails) log(`Aviso: ${voiceFails} escena(s) sin voz grabable; se usará la voz del dispositivo solo para escucharla (no quedará en el archivo).`, 'e');
    if (S.abort) throw new Error('cancelado');
    log('3/3 Montando y grabando el vídeo (a tiempo real)…');
    $('out').classList.remove('hide');
    const blob = await render(scenes, W, H, $('subs').checked);
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
function blobToBase64(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
}
async function saveVideo() {
  if (!S.blob) return;
  const ext = S.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const fname = `${S.name}-${Date.now()}.${ext}`;
  const P = window.Capacitor && window.Capacitor.Plugins;
  try {
    if (P && P.Filesystem && P.Share) {
      const w = await P.Filesystem.writeFile({ path: fname, data: await blobToBase64(S.blob), directory: 'CACHE' });
      await P.Share.share({ title: 'Video IA', url: w.uri, dialogTitle: 'Guardar o compartir vídeo' });
      return;
    }
    if (navigator.canShare && navigator.canShare({ files: [new File([S.blob], fname, { type: S.blob.type })] })) {
      await navigator.share({ files: [new File([S.blob], fname, { type: S.blob.type })], title: 'Video IA' });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; log('Compartir falló: ' + e.message + '. Pruebo a descargar.', 'e'); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(S.blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- diagnóstico ---------- */
async function testServices() {
  $('log').textContent = ''; saveCfg(); S.abort = false;
  const t = async (name, f) => { try { const r = await f(); log(`✔ ${name}: ${r}`, 'o'); } catch (e) { log(`✘ ${name}: ${e.message}`, 'e'); } };
  await t('Texto', async () => { const b = await fetchBlob(cfg().text + '/openai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: 'Di hola' }] }) }, { tries: 1, timeout: 40000 }); return (await b.text()).slice(0, 60); });
  await t('Imagen', async () => { const b = await getImage('a red fox in a forest', 'photo', 512, 512, 1); return b.type + ' ' + b.size + ' B'; });
  await t('Voz', async () => { const b = await getVoice('Hola, esto es una prueba.', 'nova'); return b.type + ' ' + b.size + ' B'; });
}

/* ---------- init ---------- */
window.addEventListener('DOMContentLoaded', () => {
  loadCfg();
  $('go').onclick = create;
  $('stop').onclick = () => { S.abort = true; try { speechSynthesis.cancel(); } catch (e) {} };
  $('save').onclick = saveVideo;
  $('test').onclick = testServices;
  $('reset').onclick = () => { try { localStorage.removeItem('vi_cfg'); } catch (e) {} loadCfg(); log('Valores restaurados.'); };
  ['u_text', 'u_img', 'u_tts'].forEach(id => $(id).addEventListener('change', saveCfg));
});
