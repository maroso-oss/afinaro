'use strict';
const NOMES = ['Dó','Dó#','Ré','Ré#','Mi','Fá','Fá#','Sol','Sol#','Lá','Lá#','Si'];
const $ = id => document.getElementById(id);
const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const freqToMidi = f => 69 + 12 * Math.log2(f / 440);
const noteName = m => NOMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

// YIN pitch detection
function yin(buf, sr, thr = 0.15) {
  const half = Math.floor(buf.length / 2), d = new Float32Array(half);
  const minTau = Math.floor(sr / 1200), maxTau = Math.min(half - 1, Math.floor(sr / 60));
  for (let t = 1; t <= maxTau; t++) { let s = 0; for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + t]; s += x * x; } d[t] = s; }
  let run = 0; d[0] = 1;
  for (let t = 1; t <= maxTau; t++) { run += d[t]; d[t] = run ? d[t] * t / run : 1; }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) { if (d[t] < thr) { while (t + 1 <= maxTau && d[t + 1] < d[t]) t++; tau = t; break; } }
  if (tau < 0) return null;
  const a = d[tau - 1] ?? d[tau], b = d[tau], c = d[tau + 1] ?? d[tau];
  const den = a + c - 2 * b, shift = den ? (a - c) / (2 * den) : 0;
  return { freq: sr / (tau + shift), clarity: 1 - b };
}
if (typeof module !== 'undefined') module.exports = { yin, noteName, freqToMidi };
if (typeof document === 'undefined') { /* node test */ } else (function () {

const S = { ctx: null, an: null, buf: null, midi: null, rms: 0, hist: [], target: 57, free: false, lastVoice: 0, silenceStart: performance.now(), tipAt: 0, listeners: [], toneUntil: 0, speaking: false };
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem(k, JSON.stringify(v)) };

// UI setup
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab,.panel').forEach(e => e.classList.remove('active'));
  b.classList.add('active'); $(b.dataset.tab).classList.add('active'); if (b.dataset.tab === 'hist') renderHist();
});
const opts = (sel, from, to, val) => { sel.innerHTML = ''; for (let m = from; m <= to; m++) { const o = new Option(noteName(m) + ' (' + midiToFreq(m).toFixed(0) + ' Hz)', m); if (m === val) o.selected = true; sel.add(o); } };
opts($('targetSel'), 36, 84, 57);
$('targetSel').onchange = e => S.target = +e.target.value;
$('followTarget').onchange = e => S.free = e.target.checked;
$('playRef').onclick = () => { ensureCtx(); tone(S.target, 1.2); };

function ensureCtx() { if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (S.ctx.state === 'suspended') S.ctx.resume(); return S.ctx; }
function tone(m, dur = 1) {
  const c = ensureCtx(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
  o.type = 'triangle'; o.frequency.value = midiToFreq(m);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3, t + 0.05); g.gain.setValueAtTime(0.3, t + dur - 0.15); g.gain.linearRampToValueAtTime(0, t + dur);
  S.toneUntil = performance.now() + dur * 1000 + 100;
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  return new Promise(r => setTimeout(r, dur * 1000));
}

$('micBtn').onclick = async () => {
  unlockSpeech('Olá, vamos cantar!');
  if (!navigator.mediaDevices?.getUserMedia) { $('micErr').textContent = 'O teu navegador não suporta acesso ao microfone (é necessário HTTPS).'; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const c = ensureCtx(); S.an = c.createAnalyser(); S.an.fftSize = 2048; S.buf = new Float32Array(S.an.fftSize);
    c.createMediaStreamSource(stream).connect(S.an);
    $('micBanner').classList.add('hidden'); loop();
  } catch (e) { $('micErr').textContent = 'Não foi possível aceder ao microfone: ' + e.message; }
};

const GATE = 0.012;
function loop() {
  S.an.getFloatTimeDomainData(S.buf);
  let s = 0; for (const x of S.buf) s += x * x; S.rms = Math.sqrt(s / S.buf.length);
  const now = performance.now(); let midi = null;
  const busy = S.speaking || now < S.toneUntil;
  if (!busy && S.rms > GATE) { const r = yin(S.buf, S.ctx.sampleRate); if (r && r.clarity > 0.8 && r.freq > 60 && r.freq < 1200) midi = freqToMidi(r.freq); }
  // median smoothing
  S.raw = (S.raw || []).concat([midi]).slice(-5);
  const v = S.raw.filter(x => x != null).sort((a, b) => a - b);
  S.midi = v.length >= 3 ? v[v.length >> 1] : null;
  S.hist.push({ t: now, m: S.midi, rms: S.rms }); while (S.hist.length && now - S.hist[0].t > 6000) S.hist.shift();
  trackSegments(now);
  if (S.midi != null) { if (now - S.lastVoice > 2500) S.phraseStart = now; S.lastVoice = now; }
  S.listeners.forEach(f => f(S.midi, S.rms, now));
  render(now); requestAnimationFrame(loop);
}

function render(now) {
  $('volBar').style.width = Math.min(100, S.rms * 600) + '%';
  if (S.midi != null) {
    const n = Math.round(S.midi), c = (S.midi - n) * 100;
    $('noteName').textContent = noteName(n); $('freq').textContent = midiToFreq(S.midi).toFixed(1) + ' Hz';
    $('cents').textContent = (c >= 0 ? '+' : '') + c.toFixed(0) + ' cêntimos'; $('needle').style.left = (50 + c) + '%';
  }
  if (now - S.tipAt > 500) { S.tipAt = now; teacherTick(now); }
  drawGraph();
}

function stats(win = 1000) {
  const now = performance.now(), pts = S.hist.filter(p => now - p.t < win && p.m != null).map(p => p.m);
  if (pts.length < 8) return null;
  const mean = pts.reduce((a, b) => a + b) / pts.length, sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length);
  return { mean, sd: sd * 100 };
}
function liveTip(now) {
  const silent = now - S.lastVoice;
  if (S.midi == null) {
    if (silent > 8000) return '😮‍💨 Antes da próxima frase, inspira fundo pelo nariz, ombros relaxados.';
    if (silent > 1500) return '🌬️ Respira: enche a barriga de ar antes de começar a frase.';
    return 'A ouvir…';
  }
  if (S.rms > 0.3) return '🔊 Está muito alto — canta com menos força, sem gritar.';
  if (S.rms < 0.02) return '🔈 Está muito baixo — projeta mais a voz, com apoio do diafragma.';
  const st = stats();
  if (st && st.sd > 35) return '〰️ A nota está instável — apoia mais o ar, segura a nota estável.';
  if (st && st.sd > 18 && st.sd <= 35) return '🎶 Ligeira oscilação — mantém o fluxo de ar constante.';
  if (S.free) return '✨ Boa! Mantém a nota ' + noteName(S.midi) + '.';
  const diff = ((st ? st.mean : S.midi) - S.target) * 100;
  if (Math.abs(diff) > 250) return diff < 0 ? '⬆️ Estás bastante abaixo de ' + noteName(S.target) + '. Ouve a nota de referência.' : '⬇️ Estás bastante acima de ' + noteName(S.target) + '. Ouve a nota de referência.';
  if (diff < -20) return '⬆️ Estás um pouco abaixo, sobe ligeiramente.';
  if (diff > 20) return '⬇️ Estás um pouco acima, desce ligeiramente.';
  return '✅ Perfeito! Estás afinado em ' + noteName(S.target) + '.';
}

const cv = $('graph'), g = cv.getContext('2d');
function drawGraph() {
  const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
  const pts = S.hist.filter(p => p.m != null).map(p => p.m);
  const center = S.free ? (pts.length ? pts[pts.length - 1] : 60) : S.target;
  const span = 6, y = m => h / 2 - (m - center) / span * (h / 2), now = performance.now();
  g.font = (11 * devicePixelRatio) + 'px sans-serif';
  for (let m = Math.ceil(center - span); m <= center + span; m++) {
    g.strokeStyle = '#ffffff14'; g.beginPath(); g.moveTo(0, y(m)); g.lineTo(w, y(m)); g.stroke();
    g.fillStyle = '#9aa0c7'; g.fillText(noteName(m), 4, y(m) - 2);
  }
  if (!S.free) { g.fillStyle = '#22d3a622'; g.fillRect(0, y(S.target + 0.2), w, y(S.target - 0.2) - y(S.target + 0.2)); g.strokeStyle = '#22d3a6'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, y(S.target)); g.lineTo(w, y(S.target)); g.stroke(); }
  g.strokeStyle = '#a78bff'; g.lineWidth = 3 * devicePixelRatio; g.beginPath(); let pen = false;
  for (const p of S.hist) { const x = w - (now - p.t) / 6000 * w; if (p.m == null) { pen = false; continue; } pen ? g.lineTo(x, y(p.m)) : g.moveTo(x, y(p.m)); pen = true; }
  g.stroke();
}

// ===== Professor: o que estou a ouvir + persona + voz =====
const pick = (arr, key) => { const last = T.lastPick[key]; let opts = arr.filter(x => x !== last); if (!opts.length) opts = arr; const s = opts[Math.floor(Math.random() * opts.length)]; T.lastPick[key] = s; return s; };
const T = { lastPick: {}, lastFocus: null, lastAt: 0, lastSpokenAt: 0, speaking: false, voice: null, goodStreak: 0, prevDiff: null, segStart: 0, gaps: [] };
const canSpeak = 'speechSynthesis' in window;
$('speakToggle').checked = canSpeak && store.get('canto.voz', true) !== false;
$('speakToggle').disabled = !canSpeak;
if (!canSpeak) $('voiceInfo').textContent = 'O teu navegador não tem síntese de voz.';
$('speakToggle').onchange = e => { store.set('canto.voz', e.target.checked); if (!e.target.checked && canSpeak) speechSynthesis.cancel(); };
function chooseVoice() {
  if (!canSpeak) return;
  const vs = speechSynthesis.getVoices();
  T.voice = vs.find(v => /^pt[-_]PT/i.test(v.lang)) || vs.find(v => /^pt[-_]BR/i.test(v.lang)) || vs.find(v => /^pt/i.test(v.lang)) || null;
  $('voiceInfo').textContent = T.voice ? 'Voz: ' + T.voice.name + ' (' + T.voice.lang + ')' + (/PT/i.test(T.voice.lang) ? '' : ' — não há voz pt-PT neste dispositivo') : (vs.length ? 'Sem voz portuguesa neste dispositivo; será usada a voz por defeito.' : '');
}
if (canSpeak) { chooseVoice(); speechSynthesis.onvoiceschanged = chooseVoice; }
// Fala em voz alta; nunca por cima do tom guia; durante a fala a análise do micro fica em pausa.
function makeUtter(text) {
  const u = new SpeechSynthesisUtterance(text.replace(/[^\p{L}\p{N}\s.,;:!?'’()%#-]/gu, ''));
  u.lang = T.voice ? T.voice.lang : 'pt-PT'; if (T.voice) u.voice = T.voice; u.rate = 1.0; u.pitch = 1.0; u.volume = 1;
  return u;
}
// Tem de ser chamado DIRETAMENTE num clique (iOS/Safari só desbloqueia a fala dentro de um gesto).
function unlockSpeech(text) {
  if (!canSpeak || !$('speakToggle').checked) return false;
  try {
    if (!T.voice) chooseVoice();
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.resume();
    const u = makeUtter(text || 'Olá, vamos cantar!');
    T.speaking = true; S.speaking = true;
    const end = () => { clearTimeout(w); T.speaking = false; S.speaking = false; };
    const w = setTimeout(end, 4000); u.onend = end; u.onerror = e => { end(); $('voiceInfo').textContent = 'Erro de voz: ' + (e.error || 'desconhecido'); };
    speechSynthesis.speak(u); T.unlocked = true; return true;
  } catch (e) { T.speaking = false; S.speaking = false; $('voiceInfo').textContent = 'Erro de voz: ' + e.message; return false; }
}
async function speak(text) {
  $('teacher').textContent = text;
  if (!canSpeak || !$('speakToggle').checked) return;
  const t0 = performance.now();
  while (performance.now() < S.toneUntil && performance.now() - t0 < 5000) await sleep(100);
  // não fazer cancel() imediatamente antes de speak() (bug do Chrome que descarta a fala)
  if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); await sleep(80); }
  T.speaking = true; S.speaking = true;
  try {
    await new Promise(res => {
      const u = makeUtter(text);
      let fin = false; const done = () => { if (!fin) { fin = true; clearTimeout(w); clearInterval(k); res(); } };
      u.onend = done; u.onerror = e => { if (e.error && e.error !== 'interrupted' && e.error !== 'canceled') $('voiceInfo').textContent = 'Erro de voz: ' + e.error; done(); };
      const w = setTimeout(done, Math.min(12000, 2500 + text.length * 90)); // vigilante: onend pode nunca chegar
      const k = setInterval(() => { if (speechSynthesis.paused) speechSynthesis.resume(); }, 1000); // Chrome pausa falas longas
      speechSynthesis.resume(); speechSynthesis.speak(u);
    });
    await sleep(250); // deixa morrer o eco antes de voltar a ouvir
  } finally { T.speaking = false; S.speaking = false; S.raw = []; S.hist.push({ t: performance.now(), m: null, rms: 0 }); }
}
const fmtNote = m => noteName(m) + ' (' + midiToFreq(Math.round(m)).toFixed(0) + ' Hz)';
function analyse(now) {
  const voiced = S.hist.filter(p => p.m != null);
  const recent = voiced.filter(p => now - p.t < 1200);
  const silent = now - S.lastVoice;
  const a = { silent, voiced: S.midi != null && recent.length >= 6 };
  if (!a.voiced) return a;
  const ms = recent.map(p => p.m), mean = ms.reduce((x, y) => x + y) / ms.length;
  a.mean = mean; a.note = Math.round(mean);
  a.sd = Math.sqrt(ms.reduce((x, y) => x + (y - mean) ** 2, 0) / ms.length) * 100;
  const last = voiced.filter(p => now - p.t < 700);
  if (last.length > 5) { const t0 = last[0].t, xs = last.map(p => (p.t - t0) / 1000), ys = last.map(p => p.m * 100); const mx = xs.reduce((s, x) => s + x) / xs.length, my = ys.reduce((s, y) => s + y) / ys.length; let nu = 0, de = 0; xs.forEach((x, i) => { nu += (x - mx) * (ys[i] - my); de += (x - mx) ** 2; }); a.slope = de ? nu / de : 0; } else a.slope = 0;
  a.trend = a.slope > 60 ? 'subir' : a.slope < -60 ? 'descer' : 'estável';
  a.diff = S.free ? null : (mean - S.target) * 100;
  a.sustain = (now - T.segStart) / 1000;
  const seg = voiced.filter(p => p.t >= T.segStart);
  if (!S.free && seg.length > 20 && a.sustain > 0.8) { const att = seg.slice(0, 8).map(p => p.m), avgA = att.reduce((x, y) => x + y) / att.length; a.attack = (avgA - S.target) * 100; }
  a.vol = S.rms > 0.3 ? 'alto' : S.rms < 0.02 ? 'baixo' : 'bom';
  a.gaps = T.gaps.filter(g => now - g.t < 15000);
  return a;
}
function describe(a) {
  if (!a.voiced) {
    if (a.silent > 60000 || !isFinite(a.silent)) return 'Ainda não ouvi nada. Quando estiveres pronto, canta uma nota confortável.';
    return 'Silêncio há ' + (a.silent / 1000).toFixed(1) + ' s.' + (T.lastGapLen ? ' A tua última pausa para respirar durou ' + T.lastGapLen.toFixed(1) + ' s.' : '');
  }
  const p = [];
  let s = 'Estou a ouvir um ' + fmtNote(a.note);
  if (a.diff != null) {
    const c = Math.round(Math.abs(a.diff));
    if (c <= 15) s += ', afinado com o ' + noteName(S.target) + ' que pedi';
    else if (c >= 100) s += ', ' + (c / 100).toFixed(1).replace('.', ',') + ' meios-tons ' + (a.diff < 0 ? 'abaixo' : 'acima') + ' do ' + noteName(S.target) + ' que pedi';
    else s += ', cerca de ' + c + ' cêntimos ' + (a.diff < 0 ? 'abaixo' : 'acima') + ' do ' + noteName(S.target) + ' que pedi';
  }
  p.push(s + '.');
  p.push(a.trend === 'estável' ? 'A altura está estável.' : 'A nota está a ' + a.trend + '.');
  p.push(a.sd > 35 ? 'Há bastante oscilação (±' + Math.round(a.sd) + ' cêntimos).' : a.sd > 18 ? 'Há uma ligeira ondulação (±' + Math.round(a.sd) + ' cêntimos).' : 'Pouca oscilação, boa estabilidade.');
  p.push(a.vol === 'alto' ? 'O volume está muito forte.' : a.vol === 'baixo' ? 'O volume está fraco.' : 'O volume está bom.');
  if (a.attack != null && Math.abs(a.attack) > 30 && Math.abs(a.diff) < Math.abs(a.attack) - 15) p.push('Entraste ' + (a.attack < 0 ? 'abaixo' : 'acima') + ' e estás a corrigir.');
  p.push('Estás a sustentar há ' + a.sustain.toFixed(1).replace('.', ',') + ' s' + (a.gaps.length ? ', com ' + a.gaps.length + ' pausa(s) para respirar nos últimos 15 s.' : '.'));
  return p.join(' ');
}
const FR = {
  breathe: ['Antes da próxima frase, enche a barriga de ar pelo nariz, sem levantar os ombros.', 'Aproveita o silêncio para respirar fundo: imagina que o ar desce até à cintura.', 'Respira com calma. Um bom fôlego antes de cantar poupa-te esforço na garganta.'],
  loud: ['Estás a dar muita força. Canta com menos pressão: a voz soa melhor quando não a empurras.', 'Baixa um pouco o volume. Gritar cansa as pregas vocais; deixa o som fluir.'],
  quiet: ['Ouço-te pouco. Apoia o ar com a barriga e abre mais a boca para o som sair.', 'Dá-me um pouco mais de voz: imagina que cantas para alguém ao fundo da sala.'],
  wobble: ['A nota está a tremer. Apoia mais o ar com o diafragma e segura a nota estável, como uma linha reta.', 'Há oscilação. Mantém a barriga firme e o fluxo de ar constante, sem apertar a garganta.', 'Tenta pensar num fio de ar contínuo. A estabilidade vem do apoio, não da garganta.'],
  low: ['Estás um pouco abaixo, sobe ligeiramente. Pensa a nota por cima, como se a apanhasses de cima.', 'Falta-te um bocadinho. Levanta as sobrancelhas e eleva o palato mole, como num bocejo.', 'Quase lá! Sobe ligeiramente — muitas vezes basta mais apoio de ar.'],
  high: ['Estás um pouco acima, desce ligeiramente. Relaxa o maxilar e não empurres o ar.', 'Passaste um pouco da nota. Solta a tensão no pescoço e deixa a nota assentar.', 'Ligeiramente alto. Respira e deixa o som cair com naturalidade.'],
  farLow: ['Estás bem abaixo da nota. Ouve outra vez a referência e imagina-a antes de cantar.', 'Essa nota ainda está longe, abaixo. Ouve a referência e tenta trautear primeiro de boca fechada.'],
  farHigh: ['Estás bem acima da nota. Ouve a referência e procura-a com calma, a descer.', 'Muito acima. Relaxa, ouve outra vez a nota e entra suavemente.'],
  falling: ['A nota está a descer no fim. Mantém o apoio até ao último instante da frase.', 'Estás a deixar cair a nota. Guarda ar para o fim e segura a barriga firme.'],
  rising: ['A nota está a subir. Relaxa o maxilar e não aumentes a pressão do ar.'],
  attack: ['Entraste abaixo e foste corrigindo. Da próxima vez, imagina a nota antes de cantar e entra já nela.', 'A entrada foi por baixo. Pensa a nota por cima e ataca-a de forma limpa.'],
  good: ['Muito bem! Estás afinado. Mantém assim.', 'Isso! Bonita nota, estável e no sítio.', 'Perfeito. Sentes como isto é confortável? É este o apoio certo.', 'Excelente, estás mesmo em cima da nota.'],
  progress: ['Boa! Estás a melhorar — já estás muito mais perto da nota.', 'Assim é que é! Corrigiste bem a afinação.'],
  free: ['Boa nota! Agora tenta mantê-la estável durante mais uns segundos.', 'Estou a gostar. Experimenta segurar a nota sem a deixar oscilar.'],
};
function focusOf(a) {
  if (!a.voiced) return a.silent > 1500 && a.silent < 30000 ? 'breathe' : null;
  if (a.vol === 'alto') return 'loud';
  if (a.vol === 'baixo') return 'quiet';
  if (a.diff != null && Math.abs(a.diff) > 250) return a.diff < 0 ? 'farLow' : 'farHigh';
  if (a.sd > 35) return 'wobble';
  if (a.diff != null && a.diff < -20) return (T.prevDiff != null && T.prevDiff - Math.abs(a.diff) > 40) ? 'progress' : 'low';
  if (a.diff != null && a.diff > 20) return (T.prevDiff != null && T.prevDiff - Math.abs(a.diff) > 40) ? 'progress' : 'high';
  if (a.trend === 'descer' && a.sustain > 1.5) return 'falling';
  if (a.trend === 'subir' && a.sustain > 1.5) return 'rising';
  if (a.attack != null && a.attack < -30 && a.sustain < 3) return 'attack';
  return S.free ? 'free' : 'good';
}
function teacherTick(now) {
  if (T.speaking) return;
  const a = analyse(now);
  $('hearing').textContent = describe(a);
  if (running) return;
  const f = focusOf(a);
  if (!f) return;
  const changed = f !== T.lastFocus, since = now - T.lastAt;
  if ((changed && since > 2000) || since > 3500) {
    if (f === T.lastFocus && f === 'good' && since < 7000) return;
    T.lastFocus = f; T.lastAt = now; if (a.diff != null) T.prevDiff = Math.abs(a.diff);
    const txt = pick(FR[f], f);
    // em modo livre/ao vivo fala só em mudanças relevantes e com espaço, para não interromper o canto
    if (now - T.lastSpokenAt > 9000 && (changed || f === 'breathe')) { T.lastSpokenAt = now; speak(txt); } else $('teacher').textContent = txt;
  }
}
function trackSegments(now) {
  if (S.midi != null) { const gap = now - S.lastVoiceT; if (!S.lastVoiceT || gap > 300) { if (S.lastVoiceT && gap < 15000) { T.gaps.push({ t: now, len: gap }); T.lastGapLen = gap / 1000; } T.segStart = now; } S.lastVoiceT = now; }
}
function noteComment(r) {
  if (!r.voiced) return pick(['Não te ouvi nessa nota. Entra logo depois da guia, sem medo.', 'Essa passou sem som. Respira e entra com confiança.'], 'nc0');
  if (r.score >= 85) return pick(['Muito bem!', 'Isso mesmo!', 'Linda nota!', 'Perfeito!'], 'nc1');
  if (Math.abs(r.cents) > 20) return r.cents < 0 ? pick(['Um pouco baixo, pensa por cima.', 'Faltou subir um bocadinho.'], 'nc2') : pick(['Um pouco alto, relaxa.', 'Passaste ligeiramente, solta o maxilar.'], 'nc3');
  if (r.sd > 25) return pick(['Afinado, mas a tremer. Mais apoio.', 'Segura mais estável.'], 'nc4');
  return pick(['Bem!', 'Boa, continua.'], 'nc5');
}
function exerciseTalk(total, acc, stab, tips, prev) {
  let s = total >= 85 ? pick(['Que bom trabalho!', 'Fantástico, estou orgulhoso de ti!'], 'ex1') : total >= 60 ? pick(['Bom trabalho!', 'Está a ficar muito bem.'], 'ex2') : pick(['Não desanimes, isto treina-se.', 'Foi um bom começo. Vamos melhorar juntos.'], 'ex3');
  s += ' Fizeste ' + total + ' por cento.';
  if (prev != null && total > prev + 3) s += ' Melhoraste ' + (total - prev) + ' pontos desde a última vez!';
  s += ' O meu conselho para a próxima: ' + tips[0];
  return s;
}

// Range
const range = () => store.get('canto.range', null);
function showRange() { const r = range(); $('rangeInfo').textContent = r ? 'A tua extensão: ' + noteName(r.low) + ' – ' + noteName(r.high) : 'Ainda sem extensão guardada (usa-se Dó3–Dó4 por defeito).'; opts($('manLow'), 36, 84, r ? r.low : 48); opts($('manHigh'), 36, 84, r ? r.high : 60); }
showRange();
$('saveMan').onclick = () => { const l = +$('manLow').value, h = +$('manHigh').value; if (h - l < 5) return alert('A extensão deve ter pelo menos 5 semitons.'); store.set('canto.range', { low: l, high: h }); showRange(); };
function captureNote(ms = 2000) {
  return new Promise(res => { const vals = [], t0 = performance.now(); const f = (m, r, now) => { if (m != null) vals.push(m); if (now - t0 > ms) { S.listeners = S.listeners.filter(x => x !== f); res(vals); } }; S.listeners.push(f); });
}
async function recRange(which) {
  if (!S.an) return alert('Ativa primeiro o microfone.');
  $('rangeInfo').textContent = 'A ouvir… canta e segura a nota ' + (which === 'low' ? 'grave' : 'aguda') + '.';
  const v = await captureNote(2500);
  if (v.length < 20) { $('rangeInfo').textContent = 'Não ouvi uma nota estável. Tenta outra vez, mais perto do microfone.'; return; }
  v.sort((a, b) => a - b); const m = Math.round(v[v.length >> 1]);
  const r = range() || { low: 48, high: 60 }; r[which] = m;
  if (r.high - r.low < 5) { which === 'low' ? r.high = r.low + 7 : r.low = r.high - 7; }
  store.set('canto.range', r); showRange();
}
$('rangeLow').onclick = () => recRange('low'); $('rangeHigh').onclick = () => recRange('high');

// Exercises
const EX = {
  sustain: { nome: 'Aquecimento: nota sustentada', build: (l, h) => { const m = Math.round(l + (h - l) * 0.35); return [m, m + 2, m + 4].map(n => ({ m: n, dur: 4 })); } },
  scale: { nome: 'Escala de 5 notas', build: l => [0, 2, 4, 5, 7, 5, 4, 2, 0].map(i => ({ m: l + 2 + i, dur: 1.6 })) },
  arp: { nome: 'Arpejo maior', build: l => [0, 4, 7, 12, 7, 4, 0].map(i => ({ m: l + 1 + i, dur: 1.8 })) },
  intervals: { nome: 'Intervalos (3ª, 5ª, oitava)', build: l => [[0, 4], [0, 7], [0, 12]].flat().map(i => ({ m: l + 1 + i, dur: 2 })) },
};
let running = null;
document.querySelectorAll('.exBtn').forEach(b => b.onclick = () => { if (!T.unlocked && !running) unlockSpeech('Vamos a isso!'); runEx(b.dataset.ex); });
$('testVoice').onclick = () => {
  if (!canSpeak) { $('voiceInfo').textContent = 'Este navegador não suporta voz sintetizada.'; return; }
  if (!$('speakToggle').checked) { $('speakToggle').checked = true; store.set('canto.voz', true); }
  chooseVoice();
  const ok = unlockSpeech('Olá! Eu sou o teu professor de canto. Ouves-me bem?');
  $('voiceInfo').textContent = ok ? 'A falar com: ' + (T.voice ? T.voice.name + ' (' + T.voice.lang + ')' : 'voz por defeito (pt-PT)') : 'Não foi possível falar neste navegador.';
};
$('exStop').onclick = () => { if (running) running.stop = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runEx(key) {
  if (!S.an) return alert('Ativa primeiro o microfone.');
  if (running) return;
  const r = range() || { low: 48, high: 60 }, ex = EX[key];
  let notes = ex.build(r.low, r.high);
  const top = Math.max(...notes.map(n => n.m)); if (top > r.high) { const sh = top - r.high; notes = notes.map(n => ({ ...n, m: Math.max(r.low, n.m - sh) })); }
  running = { stop: false };
  $('exSummary').classList.add('hidden'); $('exRun').classList.remove('hidden'); $('exTitle').textContent = ex.nome;
  $('exSteps').innerHTML = notes.map((n, i) => `<div class="step" id="st${i}">${noteName(n.m)}</div>`).join('');
  document.querySelectorAll('.exBtn').forEach(b => b.disabled = true);
  const results = [];
  $('exStatus').textContent = '🌬️ Inspira fundo… vamos começar.'; await speak(pick(['Vamos lá! Ouve cada nota e repete-a logo a seguir.', 'Prepara-te: respira fundo, ombros soltos, e repete cada nota que eu tocar.'], 'start')); await sleep(500);
  for (let i = 0; i < notes.length && !running.stop; i++) {
    const n = notes[i], el = $('st' + i); el.classList.add('cur');
    S.target = n.m; S.free = false; $('followTarget').checked = false; $('targetSel').value = n.m;
    $('exStatus').textContent = '🔊 Ouve: ' + noteName(n.m); await tone(n.m, Math.min(1.2, n.dur));
    $('exStatus').textContent = '🎤 Agora canta: ' + noteName(n.m); await sleep(300);
    const v = await captureNote(n.dur * 1000), res = scoreNote(v, n.m); results.push(res);
    el.classList.remove('cur'); el.classList.add(res.score >= 75 ? 'good' : res.score >= 45 ? 'ok' : 'bad');
    el.title = res.score + '%';
    const nc = noteComment(res); $('exStatus').textContent = '🧑‍🏫 ' + nc; if (!running.stop) await speak(nc);
  }
  document.querySelectorAll('.exBtn').forEach(b => b.disabled = false);
  $('exRun').classList.add('hidden');
  if (results.length) summary(ex.nome, results);
  running = null;
}
function scoreNote(v, target) {
  const valid = v.slice(Math.floor(v.length * 0.2)); // ignora ataque
  if (valid.length < 10) return { m: target, voiced: false, score: 0, acc: 0, stab: 0, cents: null, sd: null };
  const fixed = valid.map(x => x + 12 * Math.round((target - x) / 12)); // tolera erro de oitava
  const octErr = Math.abs(valid[0] - fixed[0]) > 6;
  const mean = fixed.reduce((a, b) => a + b) / fixed.length, cents = (mean - target) * 100;
  const sd = Math.sqrt(fixed.reduce((a, b) => a + (b - mean) ** 2, 0) / fixed.length) * 100;
  const acc = Math.max(0, 100 - Math.max(0, Math.abs(cents) - 10) * 1.1), stab = Math.max(0, 100 - Math.max(0, sd - 8) * 2);
  const cov = Math.min(1, v.length / 40);
  return { m: target, voiced: true, cents: Math.round(cents), sd: Math.round(sd), acc: Math.round(acc), stab: Math.round(stab), score: Math.round((acc * 0.6 + stab * 0.4) * cov), octErr };
}
function summary(nome, rs) {
  const avg = k => Math.round(rs.reduce((a, r) => a + r[k], 0) / rs.length);
  const total = avg('score'), acc = avg('acc'), stab = avg('stab'), voiced = rs.filter(r => r.voiced);
  const tips = [];
  if (voiced.length < rs.length) tips.push('Algumas notas não foram detetadas: canta mais perto do microfone e começa logo após a nota guia.');
  const meanC = voiced.length ? voiced.reduce((a, r) => a + r.cents, 0) / voiced.length : 0;
  if (meanC < -20) tips.push('Tens tendência a ficar abaixo da nota — pensa "para cima" e mantém o palato mole elevado.');
  if (meanC > 20) tips.push('Tens tendência a ficar acima da nota — relaxa a garganta e não empurres o ar.');
  if (stab < 70) tips.push('Trabalha a estabilidade: notas longas em "sss" ou "vvv" ajudam a controlar o fluxo de ar.');
  const hi = voiced.filter(r => r.m >= Math.max(...rs.map(x => x.m)) - 2);
  if (hi.length && hi.reduce((a, r) => a + r.score, 0) / hi.length < total - 15) tips.push('As notas agudas custam mais — aquece mais tempo e não forces a extensão.');
  if (rs.some(r => r.octErr)) tips.push('Cantaste algumas notas numa oitava diferente (contou na mesma, mas tenta a oitava da guia).');
  if (!tips.length) tips.push('Excelente trabalho! Experimenta um exercício mais exigente.');
  $('exSummary').innerHTML = `<h3>Resumo: ${nome}</h3><div class="score">${total}%</div><p>Afinação ${acc}% · Estabilidade ${stab}%</p>
  <table><tr><th>Nota</th><th>Desvio</th><th>Oscilação</th><th>Pontos</th></tr>${rs.map(r => `<tr><td>${noteName(r.m)}</td><td>${r.voiced ? (r.cents > 0 ? '+' : '') + r.cents + ' ¢' : '—'}</td><td>${r.voiced ? r.sd + ' ¢' : '—'}</td><td>${r.score}%</td></tr>`).join('')}</table>
  <ul>${tips.map(t => '<li>' + t + '</li>').join('')}</ul>`;
  $('exSummary').classList.remove('hidden');
  const h = store.get('canto.hist', []);
  const prev = (h.find(x => x.nome === nome) || {}).total;
  const talk = exerciseTalk(total, acc, stab, tips, prev); $('exSummary').insertAdjacentHTML('afterbegin', '<p class="teacherSay">🧑‍🏫 ' + talk + '</p>'); speak(talk); h.unshift({ d: Date.now(), nome, total, acc, stab }); store.set('canto.hist', h.slice(0, 100));
}
function renderHist() {
  const h = store.get('canto.hist', []);
  $('histList').innerHTML = h.length ? `<table><tr><th>Data</th><th>Exercício</th><th>Total</th><th>Afinação</th><th>Estab.</th></tr>${h.map(x => `<tr><td>${new Date(x.d).toLocaleString('pt-PT')}</td><td>${x.nome}</td><td>${x.total}%</td><td>${x.acc}%</td><td>${x.stab}%</td></tr>`).join('')}</table>` : '<p class="sub">Ainda não há sessões.</p>';
}
$('clearHist').onclick = () => { if (confirm('Apagar todo o histórico?')) { store.set('canto.hist', []); renderHist(); } };
})();
