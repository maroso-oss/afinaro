'use strict';
/* Afinaro — treinador de canto "Ouve e repete". Tudo corre no navegador. */
const NOMES = ['Dó','Dó#','Ré','Ré#','Mi','Fá','Fá#','Sol','Sol#','Lá','Lá#','Si'];
const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const freqToMidi = f => 69 + 12 * Math.log2(f / 440);
const noteName = m => { const r = Math.round(m); return NOMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };

// Deteção de altura YIN
function yin(buf, sr, thr = 0.15) {
  const half = Math.floor(buf.length / 2), d = new Float32Array(half);
  const minTau = Math.floor(sr / 1100), maxTau = Math.min(half - 1, Math.floor(sr / 65));
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

// Descrição de uma tentativa (puro, testável em Node)
function devWord(c) {
  const a = Math.abs(c), dir = c < 0 ? 'abaixo' : 'acima';
  if (a <= 20) return 'certo';
  if (a <= 60) return 'um pouco ' + dir;
  if (a <= 140) return 'meio tom ' + dir;
  return 'bem ' + dir + ' (uns ' + Math.round(a / 100) + ' meios-tons)';
}
function analyseNote(samples, target) {
  // samples: [{m}] já dentro da janela da nota
  const v = samples.filter(s => s.m != null);
  const cover = samples.length ? v.length / samples.length : 0;
  if (v.length < 6) return { target, voiced: false, cover, score: 0 };
  let folded = false;
  const ms = v.map(s => { const k = Math.round((target - s.m) / 12); if (k) folded = true; return s.m + 12 * k; });
  const cents = ms.map(m => (m - target) * 100);
  const third = Math.max(2, Math.floor(cents.length / 3));
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const start = avg(cents.slice(0, third)), mid = avg(cents.slice(third, cents.length - third).concat(cents.length < 3 * third ? cents.slice(-1) : [])), end = avg(cents.slice(-third));
  const mean = avg(cents.slice(Math.floor(cents.length * 0.2)));
  const tail = cents.slice(Math.floor(cents.length * 0.4)), tm = avg(tail);
  const sd = Math.sqrt(avg(tail.map(c => (c - tm) ** 2)));
  const inTune = cents.filter(c => Math.abs(c) <= 35).length / cents.length;
  const acc = Math.max(0, 100 - Math.max(0, Math.abs(mean) - 12) * 1.2);
  const stab = Math.max(0, 100 - Math.max(0, sd - 10) * 1.6);
  const score = Math.round((acc * 0.5 + stab * 0.2 + inTune * 100 * 0.3) * Math.min(1, cover / 0.6));
  return { target, voiced: true, cover, start, mid, end, mean, sd, inTune, score, folded };
}
function explainNote(r) {
  if (!r.voiced) return 'não te consegui ouvir' + (r.cover > 0 ? ' o tempo suficiente' : '');
  const s = devWord(r.start), e = devWord(r.end);
  const move = r.end - r.start;
  let midTxt = Math.abs(move) < 25 ? (s === 'certo' ? 'mantiveste-te' : 'ficaste aí') : move > 0 ? 'subiste a meio' : 'desceste a meio';
  let t = 'começaste ' + s + ', ' + midTxt + ' e acabaste ' + e;
  if (s === e && Math.abs(move) < 25) t = s === 'certo' ? 'estiveste certo do princípio ao fim' : 'estiveste ' + s + ' do princípio ao fim';
  if (r.sd > 35) t += ', com a nota a tremer bastante';
  if (r.folded) t += ' (numa oitava diferente da minha — conta na mesma)';
  return t;
}
function starsFor(score) { return score >= 85 ? 3 : score >= 65 ? 2 : score >= 40 ? 1 : 0; }
if (typeof module !== 'undefined') module.exports = { yin, noteName, freqToMidi, analyseNote, explainNote, devWord, starsFor };

if (typeof document !== 'undefined') (function () {
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const KEY = 'afinaro.v2';
const P = Object.assign({ range: null, tutDone: false, level: 0, item: 0, stars: {}, xp: 0, streak: { d: null, n: 0 }, hist: [], voz: true }, (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })());
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch {} };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ---------- Áudio ---------- */
const S = { ctx: null, an: null, buf: null, stream: null, midi: null, rms: 0, trail: [], raw: [], toneUntil: 0, speaking: false, lane: null, rec: null, cur: null };
function ensureCtx() {
  if (!S.ctx) { S.ctx = new (window.AudioContext || window.webkitAudioContext)(); S.ctx.onstatechange = () => { if (S.ctx.state !== 'running' && S.stream) S.ctx.resume().catch(() => {}); }; }
  if (S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
  return S.ctx;
}
// qualquer toque reativa o áudio (iOS suspende o AudioContext após o pedido de permissão, chamadas, etc.)
['pointerdown', 'touchend', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (S.ctx && S.ctx.state !== 'running') S.ctx.resume().catch(() => {}); }, { passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ctx) S.ctx.resume().catch(() => {}); });

async function startMic() {
  if (S.an) { ensureCtx(); return true; }
  if (!navigator.mediaDevices?.getUserMedia) { $('micErr').textContent = 'Este navegador não permite usar o microfone (é preciso HTTPS).'; return false; }
  const c = ensureCtx(); // criado dentro do gesto
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
  } catch (e) { $('micErr').textContent = 'Não consegui aceder ao microfone: ' + e.message + '. Verifica as permissões do navegador.'; return false; }
  await c.resume().catch(() => {});
  S.an = c.createAnalyser(); S.an.fftSize = 2048; S.buf = new Float32Array(S.an.fftSize);
  c.createMediaStreamSource(S.stream).connect(S.an);
  requestAnimationFrame(loop);
  return true;
}
function playNotes(notes, t0perf) {
  // notes: [{m, t0, t1}] em segundos relativos a t0perf
  const c = ensureCtx(), base = c.currentTime + Math.max(0, (t0perf - now()) / 1000);
  for (const n of notes) {
    const f = midiToFreq(n.m), st = base + n.t0, en = base + n.t1 - 0.04;
    const g = c.createGain(); g.connect(c.destination);
    g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(0.32, st + 0.03); g.gain.exponentialRampToValueAtTime(0.18, st + 0.3); g.gain.setValueAtTime(0.18, Math.max(st + 0.31, en - 0.08)); g.gain.linearRampToValueAtTime(0.0001, en);
    [[1, 'triangle', 1], [2, 'sine', 0.25], [3, 'sine', 0.08]].forEach(([mul, type, amp]) => { const o = c.createOscillator(), og = c.createGain(); o.type = type; o.frequency.value = f * mul; og.gain.value = amp; o.connect(og).connect(g); o.start(st); o.stop(en + 0.05); });
  }
  const last = Math.max(...notes.map(n => n.t1));
  S.toneUntil = Math.max(S.toneUntil, t0perf + last * 1000 + 150);
}

const GATE = 0.01;
function loop() {
  requestAnimationFrame(loop);
  const t = now();
  S.an.getFloatTimeDomainData(S.buf);
  let s = 0; for (let i = 0; i < S.buf.length; i++) s += S.buf[i] * S.buf[i];
  S.rms = Math.sqrt(s / S.buf.length);
  let m = null;
  if (S.rms > GATE) { const r = yin(S.buf, S.ctx.sampleRate); if (r && r.clarity > 0.82 && r.freq > 65 && r.freq < 1100) m = freqToMidi(r.freq); }
  S.raw.push(m); if (S.raw.length > 5) S.raw.shift();
  const v = S.raw.filter(x => x != null).sort((a, b) => a - b);
  S.midi = v.length >= 3 ? v[v.length >> 1] : null;
  const contaminated = t < S.toneUntil || S.speaking;
  const tgt = targetAt(t);
  S.trail.push({ t, m: S.midi, tgt, own: !contaminated, rms: S.rms });
  while (S.trail.length && t - S.trail[0].t > 8000) S.trail.shift();
  if (S.rec && !contaminated) S.rec.push({ t, m: S.midi, rms: S.rms });
  S.frames = (S.frames || 0) + 1;
  renderLive(t, tgt, contaminated);
  drawLane(t);
  if (Coach.active) Coach.tick(t, tgt, contaminated);
}
function targetAt(t) {
  const L = S.lane; if (!L || L.phase !== 'sing') return null;
  const rel = (t - L.start) / 1000; const n = L.notes.find(n => rel >= n.t0 && rel < n.t1); return n ? n.m : null;
}
function colorFor(c) { const a = Math.abs(c); return a <= 25 ? '#2ee59d' : a <= 60 ? '#ffc94a' : '#ff5f7e'; }

function renderLive(t, tgt, contaminated) {
  $('volBar').style.width = Math.min(100, S.rms * 500) + '%';
  if (S.ctx.state !== 'running') { $('liveCents').textContent = '🔇 Toca no ecrã para ativar o som'; return; }
  if (S.midi == null) { $('liveNote').textContent = '—'; $('liveCents').textContent = contaminated ? (S.speaking ? 'o professor está a falar' : 'a tocar a nota guia') : 'canta…'; $('needle').style.left = '50%'; $('needle').style.opacity = .35; return; }
  const ref = tgt != null ? tgt : Math.round(S.midi);
  let c = (S.midi - ref) * 100; if (tgt != null) { const k = Math.round(-c / 1200); c += k * 1200; }
  $('liveNote').textContent = noteName(S.midi);
  $('liveCents').textContent = tgt != null ? (Math.abs(c) <= 25 ? '✅ certo' : (c < 0 ? '⬆️ ' : '⬇️ ') + Math.abs(Math.round(c)) + ' cêntimos ' + (c < 0 ? 'abaixo' : 'acima')) : (c >= 0 ? '+' : '') + Math.round(c) + ' cêntimos';
  $('needle').style.opacity = 1; $('needle').style.left = Math.max(2, Math.min(98, 50 + c / 2)) + '%';
  $('needle').style.background = tgt != null ? colorFor(c) : '#fff';
}

/* ---------- Pista (piano-roll) ---------- */
const cv = $('lane'), g = cv.getContext('2d');
function drawLane(t) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  g.clearRect(0, 0, W, H);
  const L = S.lane, pps = W / 5, px = W * 0.3;
  let center;
  if (L && L.notes.length) center = (Math.min(...L.notes.map(n => n.m)) + Math.max(...L.notes.map(n => n.m))) / 2;
  else { const last = [...S.trail].reverse().find(p => p.m != null); center = S.freeCenter = S.freeCenter == null ? (last ? last.m : 57) : S.freeCenter + ((last ? last.m : S.freeCenter) - S.freeCenter) * 0.03; }
  const span = Math.max(7, L && L.notes.length ? (Math.max(...L.notes.map(n => n.m)) - Math.min(...L.notes.map(n => n.m))) / 2 + 3 : 7);
  const y = m => H / 2 - (m - center) / span * (H / 2 - 12 * dpr);
  // grelha
  g.font = (11 * dpr) + 'px system-ui'; g.textBaseline = 'middle';
  for (let m = Math.floor(center - span); m <= Math.ceil(center + span); m++) {
    const nat = !NOMES[((m % 12) + 12) % 12].includes('#');
    g.fillStyle = nat ? '#ffffff08' : '#00000000'; g.fillRect(0, y(m + .5), W, y(m - .5) - y(m + .5));
    if (nat) { g.fillStyle = '#ffffff55'; g.fillText(noteName(m), 6 * dpr, y(m)); }
  }
  // linhas de tempo a correr (mostra que está vivo)
  g.strokeStyle = '#ffffff0d'; g.lineWidth = 1;
  for (let k = -10; k < 10; k++) { const x = px + (k - ((t / 1000) % 1)) * pps; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  // blocos-alvo
  if (L) {
    const rel = (t - L.start) / 1000;
    for (const n of L.notes) {
      const x0 = px + (n.t0 - rel) * pps, x1 = px + (n.t1 - rel) * pps; if (x1 < 0 || x0 > W) continue;
      const active = rel >= n.t0 && rel < n.t1, hgt = 0.8 / span * (H / 2);
      const grd = g.createLinearGradient(x0, 0, x1, 0);
      grd.addColorStop(0, L.phase === 'listen' ? '#ff564f' : '#f0478a'); grd.addColorStop(1, '#c536e8');
      g.globalAlpha = active ? 1 : 0.55; g.fillStyle = grd;
      roundRect(x0 + 2, y(n.m) - hgt / 2, Math.max(4, x1 - x0 - 4), hgt, 8 * dpr); g.fill(); g.globalAlpha = 1;
      if (n.res) { g.fillStyle = colorFor(n.res.mean ?? 999); g.fillRect(x0 + 2, y(n.m) + hgt / 2 + 2, Math.max(4, x1 - x0 - 4), 4 * dpr); }
      g.fillStyle = '#fff'; g.font = 'bold ' + (12 * dpr) + 'px system-ui'; if (x1 - x0 > 40 * dpr) g.fillText(n.label || noteName(n.m), x0 + 8 * dpr, y(n.m));
    }
  }
  // linha de leitura
  g.strokeStyle = '#ffffff66'; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
  // rasto da voz
  g.lineWidth = 4 * dpr; g.lineCap = 'round';
  let prev = null;
  for (const p of S.trail) {
    const x = px - (t - p.t) / 1000 * pps;
    if (p.m == null || x < 0) { prev = null; continue; }
    let m = p.m; if (p.tgt != null) m += 12 * Math.round((p.tgt - m) / 12);
    if (prev && Math.abs(prev.m - m) < 2) { g.strokeStyle = !p.own ? '#ffffff30' : p.tgt != null ? colorFor((m - p.tgt) * 100) : '#ffffffcc'; g.beginPath(); g.moveTo(prev.x, y(prev.m)); g.lineTo(x, y(m)); g.stroke(); }
    prev = { x, m };
  }
  // bolinha
  const last = S.trail[S.trail.length - 1];
  if (last && last.m != null) {
    let m = last.m; if (last.tgt != null) m += 12 * Math.round((last.tgt - m) / 12);
    const col = !last.own ? '#ffffff55' : last.tgt != null ? colorFor((m - last.tgt) * 100) : '#fff';
    g.fillStyle = col; g.shadowColor = col; g.shadowBlur = 18 * dpr; g.beginPath(); g.arc(px, y(m), 9 * dpr, 0, 7); g.fill(); g.shadowBlur = 0;
  } else { g.strokeStyle = '#ffffff40'; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(px, H / 2, (6 + 3 * Math.sin(t / 300)) * dpr, 0, 7); g.stroke(); }
}
function roundRect(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

/* ---------- Voz do professor ---------- */
const canSpeak = 'speechSynthesis' in window;
let voice = null, unlocked = false;
function chooseVoice() {
  if (!canSpeak) return; const vs = speechSynthesis.getVoices();
  voice = vs.find(v => /^pt[-_]PT/i.test(v.lang)) || vs.find(v => /^pt[-_]BR/i.test(v.lang)) || vs.find(v => /^pt/i.test(v.lang)) || null;
  $('voiceInfo').textContent = !canSpeak ? 'Sem voz neste navegador.' : voice ? 'Voz: ' + voice.name + ' (' + voice.lang + ')' + (/PT/i.test(voice.lang) ? '' : ' — sem voz pt-PT neste aparelho') : 'Voz por defeito do aparelho (pt-PT)';
}
if (canSpeak) { chooseVoice(); speechSynthesis.onvoiceschanged = chooseVoice; }
const voiceOn = () => canSpeak && P.voz !== false;
function syncSound() { $('speakToggle').checked = voiceOn(); $('soundBtn').textContent = voiceOn() ? '🔊' : '🔇'; }
$('speakToggle').onchange = e => { P.voz = e.target.checked; save(); syncSound(); if (!P.voz && canSpeak) speechSynthesis.cancel(); };
$('soundBtn').onclick = () => { P.voz = !voiceOn(); save(); syncSound(); if (P.voz) unlockSpeech('Voz ligada.'); else if (canSpeak) speechSynthesis.cancel(); };
function utter(text) {
  const u = new SpeechSynthesisUtterance(text.replace(/#/g, ' sustenido').replace(/[^\p{L}\p{N}\s.,;:!?'’()%-]/gu, ''));
  u.lang = voice ? voice.lang : 'pt-PT'; if (voice) u.voice = voice; u.rate = 1.02; return u;
}
function unlockSpeech(text) { // tem de ser chamada diretamente no clique
  if (!voiceOn()) return false;
  try { if (!voice) chooseVoice(); if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel(); speechSynthesis.resume(); speechSynthesis.speak(utter(text)); unlocked = true; return true; }
  catch (e) { $('voiceInfo').textContent = 'Erro de voz: ' + e.message; return false; }
}
function say(text) { $('teacherText').textContent = text; }
async function speak(text) {
  say(text);
  if (!voiceOn()) return;
  const t0 = now(); while (now() < S.toneUntil && now() - t0 < 6000) await sleep(80);
  if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); await sleep(80); }
  S.speaking = true;
  try {
    await new Promise(res => {
      const u = utter(text); let fin = false;
      const done = () => { if (!fin) { fin = true; clearTimeout(w); clearInterval(k); res(); } };
      u.onend = done; u.onerror = done;
      const w = setTimeout(done, Math.min(14000, 2500 + text.length * 85)); // vigilante
      const k = setInterval(() => { if (speechSynthesis.paused) speechSynthesis.resume(); }, 1000);
      speechSynthesis.resume(); speechSynthesis.speak(u);
    });
  } finally { await sleep(200); S.speaking = false; }
}
$('testVoice').onclick = () => {
  if (!canSpeak) { $('voiceInfo').textContent = 'Este navegador não suporta voz sintetizada.'; return; }
  P.voz = true; save(); syncSound(); chooseVoice();
  const ok = unlockSpeech('Olá! Eu sou o teu professor de canto. Ouves-me bem?');
  $('voiceInfo').textContent = ok ? 'A falar com: ' + (voice ? voice.name + ' (' + voice.lang + ')' : 'voz por defeito (pt-PT)') : 'Não foi possível falar.';
};

/* ---------- Banco de dicas (ligadas ao que se ouve) ---------- */
const TIPS = {
  apoio: ['A nota treme: firma a barriga como se fosses tossir de leve e deixa o ar sair num fio contínuo.', 'Apoio! Imagina que empurras o ar a partir da cintura, não da garganta.', 'Para estabilizar, expira devagar e de forma constante — como se soprasses uma vela sem a apagar.', 'Mantém as costelas abertas enquanto cantas; é isso que segura a nota.'],
  registo: ['Nota aguda a cair? Deixa a voz passar para a voz de cabeça: mais leve, como um "uh" de coruja.', 'Nos agudos não empurres a voz de peito. Aligeira o som e pensa que a nota sai pelo topo da cabeça.', 'Para subir, faz menos força, não mais. Experimenta um "ng" ou um sirene suave do grave ao agudo.', 'Sente a vibração a passar do peito para a cara e a cabeça à medida que sobes.'],
  baixo: ['Estás um pouco baixo: pensa a nota por cima, como se a apanhasses a descer.', 'Levanta o palato mole — o céu da boca — como no início de um bocejo.', 'Sorri ligeiramente com os olhos; ajuda a dar brilho e a subir a afinação.', 'Mais apoio de ar costuma resolver notas baixas. Barriga firme!'],
  alto: ['Estás acima: solta o maxilar e não empurres o ar.', 'Relaxa o pescoço e os ombros; tensão faz a nota subir.', 'Deixa a nota assentar: menos pressão, mais espaço na boca.'],
  ataque: ['Entraste por baixo e foste à procura. Ouve a nota na cabeça antes de cantar e entra já nela.', 'Ataque suave: começa a nota com um ligeiro "h" imaginário, sem golpe de glote, mas já na altura certa.', 'Prepara a nota antes: inspira, imagina o som e só depois canta.'],
  sustentar: ['A nota cai no fim: guarda ar para o final e mantém o apoio até ao último instante.', 'Sustenta! Pensa que a nota continua a viajar para a frente, mesmo no fim.', 'Não deixes a energia morrer no fim da nota — termina com a mesma intenção com que começaste.'],
  vibrato: ['Estou a ouvir vibrato — bonito! Deixa-o nascer naturalmente, sem o forçar.', 'Belo vibrato. Mantém-no regular e o centro da nota no sítio.'],
  volBaixo: ['Ouço-te pouco. Abre mais a boca, na vertical, como se tivesses um ovo entre os dentes.', 'Dá mais voz: imagina que cantas para alguém do outro lado da sala.', 'Mais som com menos esforço: dirige a voz para a "máscara", à frente da cara.'],
  volAlto: ['Está muito forte. Canta a 70 %: a voz fica mais bonita e mais afinada.', 'Não precisas de gritar. Baixa um pouco o volume e mantém o apoio.'],
  boca: ['Abre bem a boca: o som precisa de espaço para sair.', 'Deixa o maxilar cair, solto, como se estivesse pendurado.'],
  vogais: ['Canta numa vogal aberta como "a" ou "ó" — ficam mais fáceis de afinar.', 'Mantém a mesma forma de vogal do início ao fim da nota.', 'Se a nota for difícil, experimenta "u" — é a vogal mais estável.'],
  ressonancia: ['Experimenta trautear de boca fechada ("mmm") e sentir os lábios a vibrar: isso é ressonância.', 'Imagina o som a sair pelos olhos e pelo nariz — dá brilho sem esforço.'],
  maxilar: ['Solta o maxilar e a língua: deixa a ponta da língua tocar nos dentes de baixo.', 'Massaja as bochechas e deixa a boca cair — menos tensão, mais som.'],
  postura: ['Postura: pés à largura dos ombros, joelhos soltos, cabeça direita como se fosse puxada por um fio.', 'Ombros para baixo e para trás. O peito fica aberto e o ar entra melhor.'],
  respiracao: ['Respira pelo nariz e sente a barriga e as costas a expandir, sem levantar os ombros.', 'Antes de cada frase, inspira em silêncio e com calma — três tempos chegam.', 'Expira o ar velho antes de inspirar de novo; dá espaço ao ar novo.'],
  bom: ['Isso! Nota certa e estável.', 'Muito bem, estás em cima da nota.', 'Perfeito — memoriza esta sensação.', 'Assim mesmo, voz livre e afinada!'],
  hidratacao: ['Lembrete: bebe um pouco de água — as pregas vocais gostam de estar hidratadas.', 'Já cantas há um bocado. Faz uma pausa curta e bebe água.'],
  aquecimento: ['Antes de começar: faz uns "brrr" com os lábios a vibrar, a subir e a descer, durante 30 segundos.', 'Aquece a voz: suspira do agudo para o grave umas três vezes, bem relaxado.'],
};
const tipQueues = {};
function nextTip(cat) { // roda sem repetir até esgotar a categoria
  if (!tipQueues[cat] || !tipQueues[cat].length) { tipQueues[cat] = TIPS[cat].slice().sort(() => Math.random() - 0.5); if (tipQueues[cat][0] === S.lastTip && tipQueues[cat].length > 1) tipQueues[cat].push(tipQueues[cat].shift()); }
  return (S.lastTip = tipQueues[cat].shift());
}
function showTip(cat) { $('tipText').textContent = nextTip(cat); const b = $('tipBox'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }

const Coach = {
  active: false, lastAt: 0, lastCat: null, sessionStart: now(), hydr: false,
  tick(t, tgt, contaminated) {
    if (contaminated || t - this.lastAt < 3800) return;
    const pts = S.trail.filter(p => t - p.t < 1200 && p.own);
    const voiced = pts.filter(p => p.m != null);
    let cat = null;
    if (!this.hydr && t - this.sessionStart > 10 * 60000) { this.hydr = true; cat = 'hidratacao'; }
    else if (voiced.length < 8) { if (S.mode === 'free' && pts.length > 30) cat = 'respiracao'; }
    else {
      const ref = tgt != null ? tgt : Math.round(voiced[voiced.length - 1].m);
      const cs = voiced.map(p => { const m = p.m + 12 * Math.round((ref - p.m) / 12); return (m - ref) * 100; });
      const mean = cs.reduce((a, b) => a + b) / cs.length, sd = Math.sqrt(cs.reduce((a, c) => a + (c - mean) ** 2, 0) / cs.length);
      const rms = voiced.reduce((a, p) => a + p.rms, 0) / voiced.length;
      // vibrato: oscilação regular de 4–7,5 Hz
      let cross = 0; for (let i = 1; i < cs.length; i++) if ((cs[i - 1] - mean) * (cs[i] - mean) < 0) cross++;
      const dur = (voiced[voiced.length - 1].t - voiced[0].t) / 1000, rate = dur > 0 ? cross / 2 / dur : 0;
      const half = Math.floor(cs.length / 2), slope = cs.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, cs.length - half) - cs.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
      const highNote = P.range && ref >= P.range.high - 3;
      if (rms < 0.02) cat = pick(['volBaixo', 'boca', 'ressonancia']);
      else if (rms > 0.3) cat = 'volAlto';
      else if (sd > 18 && sd < 70 && rate >= 4 && rate <= 7.5) cat = 'vibrato';
      else if (sd > 35) cat = 'apoio';
      else if (tgt != null && mean < -30) cat = highNote ? 'registo' : (slope > 30 ? 'ataque' : 'baixo');
      else if (tgt != null && mean > 30) cat = pick(['alto', 'maxilar']);
      else if (slope < -40) cat = highNote ? 'registo' : 'sustentar';
      else cat = Math.random() < 0.5 ? 'bom' : pick(['postura', 'vogais', 'ressonancia', 'maxilar', 'respiracao']);
    }
    if (!cat || (cat === this.lastCat && cat === 'bom')) return;
    this.lastAt = t; this.lastCat = cat; showTip(cat);
    if (S.mode === 'free') say(describeFree(voiced, cat));
  }
};
function describeFree(voiced, cat) {
  if (!voiced.length) return 'Estou à espera da tua voz. Respira e canta uma nota confortável.';
  const m = voiced.reduce((a, p) => a + p.m, 0) / voiced.length, n = Math.round(m), c = Math.round((m - n) * 100);
  return 'Estou a ouvir um ' + noteName(n) + ' (' + Math.round(midiToFreq(m)) + ' Hz)' + (Math.abs(c) <= 15 ? ', bem no centro da nota.' : ', ' + Math.abs(c) + ' cêntimos ' + (c < 0 ? 'abaixo' : 'acima') + ' do centro.');
}

/* ---------- Níveis ---------- */
const LEVELS = [
  { nome: 'Uma nota', desc: 'Ouve uma nota e repete-a.', beat: 2.0, items: [[0], [2], [4], [5], [7], [3], [9]] },
  { nome: 'Duas notas', desc: 'Pequenos saltos.', beat: 1.2, items: [[0, 2], [2, 0], [0, 4], [4, 0], [0, 5], [0, 7]] },
  { nome: 'Pequenas frases', desc: 'Três a cinco notas.', beat: 0.8, items: [[0, 2, 4], [4, 2, 0], [0, 2, 4, 2, 0], [0, 4, 7], [7, 4, 0], [0, 2, 4, 5, 7]] },
  { nome: 'Melodias', desc: 'Canções tradicionais.', beat: 0.55, items: [
    { t: 'Brilha, brilha, estrelinha', n: [0, 0, 7, 7, 9, 9, 7], d: [1, 1, 1, 1, 1, 1, 2] },
    { t: 'Brilha, brilha (2.ª parte)', n: [5, 5, 4, 4, 2, 2, 0], d: [1, 1, 1, 1, 1, 1, 2] },
    { t: 'Frei Martinho', n: [0, 2, 4, 0, 0, 2, 4, 0], d: [1, 1, 1, 1, 1, 1, 1, 1] },
    { t: 'Frei Martinho (2.ª parte)', n: [4, 5, 7, 4, 5, 7], d: [1, 1, 2, 1, 1, 2] },
    { t: 'Parabéns a você', n: [-5, -5, -3, -5, 0, -1], d: [0.75, 0.25, 1, 1, 1, 2] },
  ] },
];
function buildItem(li, ii) {
  const L = LEVELS[li], it = L.items[ii];
  const rel = Array.isArray(it) ? it : it.n, dur = Array.isArray(it) ? rel.map(() => 1) : it.d;
  const r = P.range || { low: 48, high: 60 };
  const lo = Math.min(...rel), hi = Math.max(...rel), room = (r.high - r.low) - (hi - lo);
  const base = r.low - lo + Math.max(0, Math.min(room, Math.round(room * 0.35)));
  let t = 0; const notes = rel.map((x, i) => { const n = { m: base + x, t0: t, t1: t + dur[i] * L.beat }; t += dur[i] * L.beat; return n; });
  return { notes, title: it.t || (L.nome + ' · ' + (ii + 1) + '/' + L.items.length), total: t };
}
const starKey = (li, ii) => li + ':' + ii;
function renderHome() {
  $('streak').textContent = '🔥 ' + (P.streak.n || 0); $('xp').textContent = '⭐ ' + P.xp;
  $('levelMap').innerHTML = LEVELS.map((L, li) => {
    const got = L.items.reduce((a, _, ii) => a + (P.stars[starKey(li, ii)] || 0), 0), max = L.items.length * 3;
    const locked = li > P.level; const cur = li === P.level;
    return `<button class="lvl ${locked ? 'locked' : ''} ${cur ? 'cur' : ''}" data-l="${li}" ${locked ? 'disabled' : ''}><span><b>${locked ? '🔒' : cur ? '▶' : '✓'} Nível ${li + 1} · ${L.nome}</b><small>${L.desc}</small><div class="prog"><i style="width:${got / max * 100}%"></i></div></span><span class="st">${got}/${max} ⭐</span></button>`;
  }).join('');
  document.querySelectorAll('.lvl').forEach(b => b.onclick = () => { const li = +b.dataset.l; if (li !== P.level) { P.level = li; P.item = 0; save(); } go('lesson', true); });
  $('startBtn').textContent = P.range ? '▶ Continuar: Nível ' + (P.level + 1) + ' · ' + LEVELS[P.level].nome : '▶ Começar a primeira aula';
}

/* ---------- Ecrãs ---------- */
function show(id) { document.querySelectorAll('.scr').forEach(s => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }
let flow = 0; // incrementa para cancelar fluxos antigos
function stageButtons(btns) {
  const box = $('stageBtns'); box.innerHTML = '';
  btns.forEach(([label, fn, primary]) => { const b = document.createElement('button'); b.className = 'big' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; box.appendChild(b); });
}
function setPhase(txt) { $('phaseBadge').textContent = txt; }
function setStars(n) { $('stars').textContent = n == null ? '' : '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }

async function go(mode, gesture) {
  if (gesture) unlockSpeech(pick(['Olá, vamos cantar!', 'Vamos a isso!', 'Bora cantar!'].slice(0, 2)));
  const ok = await startMic(); if (!ok) { show('scrHome'); return; }
  if (!P.tutDone && mode !== 'tutorial') { await runTutorial(); }
  if (!P.range && mode === 'lesson') mode = 'range';
  const my = ++flow; S.mode = mode; S.lane = null; S.rec = null; setStars(null);
  show('scrStage');
  if (mode === 'range') return rangeTest(my);
  if (mode === 'free') return freeMode(my);
  return lesson(my);
}
$('startBtn').onclick = () => go('lesson', true);
$('freeBtn').onclick = () => go('free', true);
$('rangeBtn').onclick = () => go('range', true);
$('tutBtn').onclick = () => { unlockSpeech('Vou explicar-te o ecrã.'); runTutorial(); };
$('backBtn').onclick = () => { flow++; S.lane = null; S.rec = null; Coach.active = false; if (canSpeak) speechSynthesis.cancel(); S.speaking = false; renderHome(); show('scrHome'); };

/* Tutorial */
const TUT = [
  ['👋', 'Bem-vindo ao Afinaro', 'Sou o teu professor. Vamos treinar a afinação com um jogo simples: eu canto, tu repetes.'],
  ['🟪', 'Os blocos são as minhas notas', 'Na pista, cada bloco colorido é uma nota. Quanto mais acima, mais aguda. Os blocos andam da direita para a esquerda.'],
  ['⚪', 'A bolinha é a tua voz', 'Quando cantas, a bolinha sobe e desce contigo na linha vertical. O teu objetivo é mantê-la dentro do bloco quando ele passa.'],
  ['🟢', 'As cores dizem-te como estás', 'Verde: estás certo. Amarelo: quase lá. Vermelho: estás longe. Por baixo vês a nota e quantos cêntimos te faltam.'],
  ['🔁', 'Ouve, espera pelo "Agora tu!" e repete', 'Primeiro ouves a nota. Depois há uma contagem 3, 2, 1 e cantas. No fim explico-te o que aconteceu e decidimos se repetes ou avanças.'],
  ['💡', 'Dicas enquanto cantas', 'Enquanto cantas, aparecem dicas na caixa amarela ligadas ao que estou a ouvir. Usa auscultadores se puderes.'],
];
function runTutorial() {
  return new Promise(res => {
    let i = 0; const o = $('tut'); o.classList.remove('hidden');
    const draw = () => { const [a, t, x] = TUT[i]; $('tutArt').textContent = a; $('tutTitle').textContent = t; $('tutText').textContent = x; $('tutNext').textContent = i === TUT.length - 1 ? 'Vamos cantar!' : 'Seguinte'; $('tutDots').innerHTML = TUT.map((_, k) => '<i class="' + (k === i ? 'on' : '') + '"></i>').join(''); };
    const end = () => { o.classList.add('hidden'); P.tutDone = true; save(); res(); };
    $('tutNext').onclick = () => { if (++i >= TUT.length) end(); else draw(); };
    $('tutSkip').onclick = end; draw();
  });
}

/* Teste de extensão */
async function rangeTest(my) {
  Coach.active = false;
  $('stageTitle').textContent = 'Teste de extensão'; $('stageSub').textContent = 'Vamos descobrir as notas confortáveis para a tua voz.';
  setPhase('📏 Extensão'); $('tipText').textContent = 'Canta num "a" ou "ó" confortável, sem forçar. Não é preciso chegar ao limite.';
  const r = { low: null, high: null };
  const capture = async (label) => {
    stageButtons([]);
    for (let k = 3; k > 0; k--) { if (my !== flow) return null; setPhase('🎤 ' + label + ' em ' + k); await sleep(700); }
    setPhase('🎤 Segura a nota…'); S.rec = []; await sleep(2500); const v = S.rec.filter(p => p.m != null).map(p => p.m); S.rec = null;
    if (v.length < 25) return null; v.sort((a, b) => a - b); return Math.round(v[v.length >> 1]);
  };
  const step = (which) => new Promise(res => {
    const label = which === 'low' ? 'Grave' : 'Aguda';
    speak(which === 'low' ? 'Canta a nota mais grave que consegues cantar com conforto, e segura-a. Carrega em gravar quando estiveres pronto.' : 'Agora a nota mais aguda confortável, sem gritar. Pode ser em voz de cabeça.');
    const ask = () => stageButtons([['🎤 Gravar nota ' + label.toLowerCase(), async () => { const m = await capture(label); if (my !== flow) return; if (m == null) { say('Não ouvi uma nota estável. Chega-te ao microfone e tenta outra vez.'); ask(); } else { r[which] = m; say('Ouvi ' + noteName(m) + '. ' + (which === 'low' ? 'Ótimo!' : 'Muito bem!')); res(); } }, true], ['Não sei — escolher tipo de voz', presets]]);
    ask();
  });
  const presets = () => stageButtons([['Voz grave (Lá2–Ré4)', () => done(45, 62)], ['Voz média (Dó3–Sol4)', () => done(48, 67)], ['Voz aguda (Sol3–Ré5)', () => done(55, 74)]]);
  const done = async (lo, hi) => {
    if (hi - lo < 7) hi = lo + 7;
    P.range = { low: lo, high: hi }; save(); setPhase('✅ ' + noteName(lo) + ' – ' + noteName(hi));
    await speak('A tua extensão confortável vai de ' + noteName(lo) + ' a ' + noteName(hi) + '. Vou pôr todos os exercícios nessa zona. ' + nextTip('aquecimento'));
    if (my === flow) { flow++; go('lesson'); }
  };
  await step('low'); if (my !== flow) return;
  await step('high'); if (my !== flow) return;
  let lo = Math.min(r.low, r.high), hi = Math.max(r.low, r.high);
  done(lo + 1, hi - 1); // margem de conforto
}

/* Prática livre */
function freeMode(my) {
  Coach.active = true; Coach.lastAt = 0;
  $('stageTitle').textContent = 'Prática livre'; $('stageSub').textContent = 'Canta o que quiseres — mostro-te a nota e dou-te dicas.';
  setPhase('🎧 A ouvir'); say('Canta uma nota longa e confortável. Vou dizendo o que estou a ouvir.');
  stageButtons([['🎵 Tocar Lá3 de referência', () => { playNotes([{ m: 57, t0: 0, t1: 1.5 }], now() + 50); }]]);
}

/* Aula: ouve e repete */
let tries = 0;
async function lesson(my) {
  if (P.level >= LEVELS.length) { P.level = LEVELS.length - 1; P.item = 0; }
  if (P.item >= LEVELS[P.level].items.length) P.item = 0;
  const li = P.level, ii = P.item, item = buildItem(li, ii);
  $('stageTitle').textContent = 'Nível ' + (li + 1) + ' · ' + LEVELS[li].nome; $('stageSub').textContent = item.title + ' · ' + item.notes.map(n => noteName(n.m)).join(' – ');
  setStars(P.stars[starKey(li, ii)] ?? null); stageButtons([]);
  if (!S.warmed) { S.warmed = true; await speak(pick(['Antes de começarmos: ', 'Uma coisa rápida: ']) + nextTip(pick(['aquecimento', 'postura', 'respiracao']))); if (my !== flow) return; }
  // 1) Ouve
  S.lane = { phase: 'listen', notes: item.notes.map(n => ({ ...n })), start: now() + 1200 };
  setPhase('👂 Ouve'); say(tries ? 'Ouve outra vez com atenção.' : item.notes.length === 1 ? 'Ouve esta nota.' : 'Ouve esta frase.');
  playNotes(item.notes, S.lane.start);
  await sleep(1200 + item.total * 1000 + 300); if (my !== flow) return;
  // 2) Contagem
  const cd = $('countdown'); cd.classList.remove('hidden');
  for (const k of ['3', '2', '1', 'Agora tu!']) { cd.textContent = k; await sleep(k === 'Agora tu!' ? 450 : 550); if (my !== flow) { cd.classList.add('hidden'); return; } }
  cd.classList.add('hidden');
  // 3) Canta — os blocos voltam a passar e tu cantas por cima
  const lead = 600;
  S.lane = { phase: 'sing', notes: item.notes.map(n => ({ ...n })), start: now() + lead };
  setPhase('🎤 Canta!'); say('Canta quando o bloco chegar à linha.'); Coach.active = true; Coach.lastAt = now() - 2500;
  S.rec = [];
  await sleep(lead + item.total * 1000 + 350); if (my !== flow) return;
  Coach.active = false;
  const rec = S.rec; S.rec = null;
  // 4) Análise
  const results = S.lane.notes.map(n => {
    const a = S.lane.start + n.t0 * 1000 + 120, b = S.lane.start + n.t1 * 1000 - 40;
    const r = analyseNote(rec.filter(p => p.t >= a && p.t < b), n.m); n.res = r; return r;
  });
  const score = Math.round(results.reduce((x, r) => x + r.score, 0) / results.length), stars = starsFor(score);
  setStars(stars); setPhase(stars >= 2 ? '🎉 ' + score + '%' : '🔁 ' + score + '%');
  // explicação concreta
  let text;
  if (results.length === 1) text = 'Na nota ' + noteName(results[0].target) + ', ' + explainNote(results[0]) + '.';
  else {
    const worst = results.reduce((w, r, i) => r.score < results[w].score ? i : w, 0), good = results.filter(r => r.score >= 75).length;
    text = good === results.length ? 'Todas as notas certas — ' + explainNote(results[worst]).replace(/^começaste/, 'começaste') + ' até na mais difícil.' : 'Acertaste ' + good + ' de ' + results.length + ' notas. Na ' + (worst + 1) + '.ª nota, ' + noteName(results[worst].target) + ', ' + explainNote(results[worst]) + '.';
  }
  const w = results.reduce((a, r) => r.score < a.score ? r : a, results[0]);
  let fix = '';
  if (!w.voiced) fix = ' Entra logo a seguir à contagem e canta um pouco mais forte.';
  else if (w.start < -40 && Math.abs(w.end) < 30) fix = ' ' + nextTip('ataque');
  else if (w.mean < -30) fix = ' ' + nextTip(P.range && w.target >= P.range.high - 3 ? 'registo' : 'baixo');
  else if (w.mean > 30) fix = ' ' + nextTip('alto');
  else if (w.sd > 35) fix = ' ' + nextTip('apoio');
  else if (w.end - w.start < -40) fix = ' ' + nextTip('sustentar');
  // progresso
  const k = starKey(li, ii), prevStars = P.stars[k] || 0;
  if (stars > prevStars) { P.xp += stars - prevStars; P.stars[k] = stars; }
  const today = new Date().toISOString().slice(0, 10), yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (P.streak.d !== today) { P.streak = { d: today, n: P.streak.d === yest ? P.streak.n + 1 : 1 }; }
  P.hist.unshift({ d: Date.now(), li, ii, score, stars }); P.hist = P.hist.slice(0, 200);
  let verdict, advance;
  if (stars >= 2) { advance = true; tries = 0; verdict = pick(['Muito bem! Vamos avançar.', 'Excelente, passamos à seguinte!', 'Boa! Estás a evoluir. Próximo exercício.']); }
  else if (++tries >= 3) { advance = true; tries = 0; verdict = 'Vamos seguir em frente e voltamos a este mais tarde. Não desanimes!'; }
  else { advance = false; verdict = pick(['Vamos repetir — vais ver que sai melhor.', 'Mais uma vez, com calma.', 'Repete comigo, estás quase.']); }
  if (advance) { P.item++; if (P.item >= LEVELS[li].items.length) { P.item = 0; if (P.level < LEVELS.length - 1) { P.level++; verdict += ' Desbloqueaste o nível ' + (P.level + 1) + ': ' + LEVELS[P.level].nome + '!'; } } }
  save(); $('streak').textContent = '🔥 ' + P.streak.n; $('xp').textContent = '⭐ ' + P.xp;
  S.lastResult = { score, stars, results, text };
  stageButtons([[advance ? 'Continuar ▶' : '🔁 Tentar outra vez', () => { if (my === flow) { flow++; S.mode = 'lesson'; lesson(flow); } }, true], ['👂 Ouvir outra vez', () => { if (my === flow) { if (advance) { if (P.item === 0 && P.level > li) P.level = li; P.item = ii; } flow++; lesson(flow); } }]]);
  await speak(text + fix + ' ' + verdict);
}

syncSound(); renderHome();
window.__af = { S, P, LEVELS, buildItem };
})();
