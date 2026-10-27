const express = require('express');
const path = require('path');
const lib = require('tiktok-live-connector');
const Conn = lib.WebcastPushConnection || lib.TikTokLiveConnection;

// ================= CONFIGURACIÓN =================
// Se configura en Render > Environment (no hace falta editar este archivo)
const TIKTOK_USER = (process.env.TIKTOK_USER || '').replace('@', '').trim();
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODELO = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const NOMBRE_IA = process.env.NOMBRE_IA || 'Mr Juego';

// Qué regalo activa qué acción (nombres en minúscula, en inglés o español).
// Si tu botón usa otro regalo, mira el nombre exacto en los Logs de Render
// (aparece como "🎁 usuario envió ...") y agrégalo aquí.
const REGALOS = {
  primero: ['finger heart', 'corazón con los dedos', 'corazon con los dedos'], // Respóndeme primero
  animar: ['rose', 'rosa'],                                                     // Anímame
  nombre: ['fireworks', 'fuegos artificiales'],                                 // Di mi nombre
};

const PERSONALIDAD =
  `Eres ${NOMBRE_IA}, una IA divertida, ingeniosa y carismática que hace LIVE en TikTok. ` +
  'Respondes SIEMPRE en español, en máximo 2 frases cortas, con humor y sin groserías. ' +
  'Si te preguntan algo, respóndelo de verdad y con datos correctos. ' +
  'Nunca digas cosas ofensivas, sexuales, de odio ni des datos personales. ' +
  'No uses emojis, asteriscos ni formato, porque tu respuesta se lee en voz alta.';

const MAX_COLA = 15;          // máximo de comentarios esperando
const COOLDOWN_MS = 15000;    // tiempo entre respuestas al mismo usuario
const VIP_MS = 10 * 60 * 1000; // cuánto dura "Respóndeme primero"
const MAX_LARGO = 200;
const PROHIBIDAS = [];        // palabras a bloquear, ej: ['palabra1', 'palabra2']
// =================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = express();
app.use(express.json());
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- conexión con la página del avatar (SSE) ----------
const clientes = new Set();
app.get('/eventos', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clientes.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clientes.delete(res);
  });
});

let avisarListo = null;
app.post('/listo', (_, res) => {
  if (avisarListo) avisarListo();
  res.end();
});

const broadcast = (obj) => {
  for (const c of clientes) c.write('event: turno\ndata: ' + JSON.stringify(obj) + '\n\n');
};
const esperarListo = (ms) =>
  new Promise((res) => {
    const t = setTimeout(() => { avisarListo = null; res(); }, ms);
    avisarListo = () => { clearTimeout(t); avisarListo = null; res(); };
  });

// ---------- cola con prioridad ----------
// prio 0 = regalos / VIP, 1 = seguidores, 2 = comentarios
let seq = 0;
const cola = [];
const vip = new Map();     // id -> expiración
const ultimo = new Map();  // id -> última respuesta

function encolar(it) {
  it.seq = seq++;
  it.coins = it.coins || 0;
  cola.push(it);
}
function siguiente() {
  cola.sort((a, b) => a.prio - b.prio || b.coins - a.coins || a.seq - b.seq);
  return cola.shift();
}

function limpiar(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LARGO);
}
function valido(t) {
  const l = t.toLowerCase();
  if (l.length < 2) return false;
  if (/https?:\/\/|www\.|\.com/.test(l)) return false;
  if (/(.)\1{7,}/.test(l)) return false;
  return !PROHIBIDAS.some((p) => l.includes(p));
}
function datosUsuario(d) {
  const pp = d.user && d.user.profilePicture;
  let pic = d.profilePictureUrl || '';
  if (!pic && pp) {
    if (Array.isArray(pp.urls)) pic = pp.urls[0];
    else if (Array.isArray(pp.url)) pic = pp.url[0];
  }
  const nombre = d.nickname || (d.user && d.user.nickname) || d.uniqueId || 'alguien';
  const id = d.uniqueId || (d.user && d.user.uniqueId) || nombre;
  return { nombre, id, pic: pic || '' };
}

// ---------- eventos de TikTok ----------
function alChat(d) {
  const u = datosUsuario(d);
  const texto = limpiar(d.comment);
  if (!valido(texto)) return;
  const ahora = Date.now();
  const esVip = (vip.get(u.id) || 0) > ahora;
  if (!esVip && ahora - (ultimo.get(u.id) || 0) < COOLDOWN_MS) return;
  if (!esVip && cola.filter((i) => i.prio === 2).length >= MAX_COLA) return;
  ultimo.set(u.id, ahora);
  if (esVip) vip.delete(u.id);
  console.log(`💬 ${u.nombre}${esVip ? ' (VIP)' : ''}: ${texto}`);
  encolar({ prio: esVip ? 0 : 2, tipo: 'comentario', usuario: u.nombre, pic: u.pic, texto });
}

function accionDeRegalo(nombre) {
  const n = nombre.toLowerCase();
  for (const [accion, lista] of Object.entries(REGALOS)) if (lista.includes(n)) return accion;
  return 'regalo';
}

function alRegalo(d) {
  const tipoRegalo = d.giftType !== undefined ? d.giftType : d.giftDetails && d.giftDetails.giftType;
  if (tipoRegalo === 1 && !d.repeatEnd) return; // regalo en racha: esperamos a que termine
  const u = datosUsuario(d);
  const nombreRegalo = d.giftName || (d.giftDetails && d.giftDetails.giftName) || 'un regalo';
  const cantidad = d.repeatCount || 1;
  const diamantes = d.diamondCount || (d.giftDetails && d.giftDetails.diamondCount) || 1;
  const coins = diamantes * cantidad;
  const accion = accionDeRegalo(nombreRegalo);
  console.log(`🎁 ${u.nombre} envió ${cantidad}x ${nombreRegalo} (${coins} monedas) -> ${accion}`);

  if (accion === 'primero') {
    vip.set(u.id, Date.now() + VIP_MS);
    // si ya tenía un comentario esperando, lo subimos al frente
    cola.forEach((i) => { if (i.tipo === 'comentario' && i.usuario === u.nombre) i.prio = 0; });
  }
  encolar({
    prio: 0, tipo: accion, usuario: u.nombre, pic: u.pic, coins,
    texto: `${cantidad}x ${nombreRegalo}`,
  });
}

function alSeguir(d) {
  const u = datosUsuario(d);
  console.log(`➕ ${u.nombre} te siguió`);
  encolar({ prio: 1, tipo: 'seguidor', usuario: u.nombre, pic: u.pic, texto: '' });
}

// ---------- IA (Gemini) ----------
function promptDe(it) {
  switch (it.tipo) {
    case 'comentario': return `${it.usuario} dice en el chat: "${it.texto}"`;
    case 'regalo': return `${it.usuario} te envió este regalo: ${it.texto}. Agradécele con muchísima energía mencionando su nombre.`;
    case 'primero': return `${it.usuario} envió un Corazón con los dedos para que le respondas primero. Salúdalo por su nombre y dile que escriba ya su pregunta porque será la siguiente que respondes.`;
    case 'animar': return `${it.usuario} envió una rosa para que lo animes. Dale un mensaje corto, motivador y divertido, diciendo su nombre.`;
    case 'nombre': return `${it.usuario} envió un regalo para que digas su nombre. Di su nombre con mucha emoción y de forma creativa, y dale la bienvenida al live.`;
    case 'seguidor': return `${it.usuario} acaba de seguirte. Dale las gracias y la bienvenida de forma divertida.`;
    default: return it.texto;
  }
}
function preguntaVisible(it) {
  switch (it.tipo) {
    case 'comentario': return it.texto;
    case 'regalo': return `🎁 ${it.texto}`;
    case 'primero': return 'Respóndeme primero';
    case 'animar': return 'Anímame';
    case 'nombre': return 'Di mi nombre';
    case 'seguidor': return 'Acaba de seguirte ➕';
    default: return it.texto;
  }
}

const historial = [];
async function gemini(msg) {
  historial.push({ role: 'user', parts: [{ text: msg }] });
  while (historial.length > 8) historial.shift();
  while (historial.length && historial[0].role !== 'user') historial.shift();
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PERSONALIDAD }] },
          contents: historial,
          generationConfig: { maxOutputTokens: 200, temperature: 0.9 },
        }),
      }
    );
    const j = await r.json();
    const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!t) throw new Error(JSON.stringify(j).slice(0, 300));
    historial.push({ role: 'model', parts: [{ text: t }] });
    return t;
  } catch (e) {
    console.log('⚠️ Error con Gemini:', e.message);
    historial.pop();
    return 'Uy, se me cruzaron los cables un segundo. ¿Me lo repites?';
  }
}

// ---------- bucle principal ----------
(async function bucle() {
  while (true) {
    if (!cola.length || !clientes.size) { await sleep(400); continue; }
    const it = siguiente();
    const respuesta = await gemini(promptDe(it));
    console.log(`🤖 [${it.tipo}] ${it.usuario}: ${respuesta}`);
    broadcast({ usuario: it.usuario, pic: it.pic, pregunta: preguntaVisible(it), respuesta, tipo: it.tipo });
    await esperarListo(40000);
  }
})();

// ---------- conexión a TikTok (reintenta solo si el live aún no empezó) ----------
let programado = false;
function reintentar(ms) {
  if (programado) return;
  programado = true;
  setTimeout(() => { programado = false; conectar(); }, ms);
}
async function conectar() {
  if (!TIKTOK_USER) return console.log('⚠️ Falta la variable TIKTOK_USER');
  const c = new Conn(TIKTOK_USER);
  c.on('chat', alChat);
  c.on('gift', alRegalo);
  c.on('follow', alSeguir);
  c.on('disconnected', () => { console.log('Desconectado, reintentando...'); reintentar(10000); });
  try {
    await c.connect();
    console.log(`✅ Conectado al live de @${TIKTOK_USER}`);
  } catch (e) {
    console.log('⏳ Aún no hay live o no se pudo conectar:', e.message || e);
    reintentar(15000);
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));
conectar();
