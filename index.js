import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  downloadMediaMessage, normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const logger = pino({ level: 'silent' })
const DATA_DIR = process.env.DATA_DIR || './data'
fs.mkdirSync(DATA_DIR, { recursive: true })
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth')
const CHATS_FILE = path.join(DATA_DIR, 'chats.json')
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json')
const PROMPT = fs.readFileSync('./prompt.txt', 'utf8')
const KNOW_DIR = './knowledge'

// ----- المفاتيح (مجانية) -----
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim()
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim()

const GROQ_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b')
  .split(',').map(s => s.trim()).filter(Boolean)
const GROQ_VISION_MODEL = (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b').trim()
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim()
const STT_MODEL = (process.env.GROQ_STT_MODEL || 'whisper-large-v3').trim()
const REASONING = (process.env.REASONING_EFFORT || 'medium').trim() // low | medium | high
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 3500)
const PRIMARY = (process.env.PRIMARY || 'groq').trim() // groq | gemini

// وضع الأوامر: البوت ما كيجاوب غير فاش تكتب أمر (ولا كاينة جلسة مفتوحة)
const COMMAND_ONLY = (process.env.COMMAND_ONLY || 'on').trim() !== 'off'
const SESSION_MIN = Number(process.env.SESSION_MIN || 15)
const sessions = new Map() // مفتاح المحادثة -> وقت انتهاء الجلسة
const ASK_CMDS = ['/شرح', '/تمرين', '/سؤال']
const ALWAYS_CMDS = ['/مساعدة', '/help', '/start', '/ابدأ', '/مستوى', '/مادة', '/تلميح', '/حل', '/reset', '/وقف']
const HISTORY_LIMIT = 8
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 80)
// نمر مسموح لها فالخاص (أرقام فقط، مفرقة بفاصلة). فارغ = الكل.
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)

// ----- تحكم المالك: تشغيل/إيقاف البوت من محادثة خاصة -----
const OWNER = (process.env.OWNER || '').replace(/\D/g, '') // نمرتك بالرمز الدولي بلا +
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const botState = loadJson(STATE_FILE)
if (typeof botState.enabled !== 'boolean') {
  botState.enabled = (process.env.START_ON || 'on').trim() !== 'off'
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)) }
  catch (e) { console.log('state save failed:', e.message) }
}

const FAIL = 'السيرفر مشغول دابا، عاود المحاولة من بعد شوية 🙏'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const userPart = j => j?.split('@')[0].split(':')[0]

// ---------- المستويات والمواد ----------
const LEVELS = {
  '1': { key: '3ac', name: 'ثالثة إعدادي' },
  '2': { key: '2bac', name: 'ثانية باك (الآداب والعلوم الإنسانية)' }
}
const LEVEL_BY_KEY = { '3ac': LEVELS['1'], '2bac': LEVELS['2'] }
const SUBJECTS = [
  { key: 'ar', name: 'العربية', names: ['عربية', 'العربية', 'اللغة العربية', 'لغة عربية', 'arabe'] },
  { key: 'phil', name: 'الفلسفة', names: ['فلسفة', 'الفلسفة', 'philosophie'] },
  { key: 'hist', name: 'التاريخ', names: ['تاريخ', 'التاريخ', 'histoire'] },
  { key: 'geo', name: 'الجغرافيا', names: ['جغرافيا', 'الجغرافيا', 'geographie', 'géographie'] },
  { key: 'soc', name: 'الاجتماعيات', names: ['اجتماعيات', 'الاجتماعيات'] },
  { key: 'islam', name: 'التربية الإسلامية', names: ['اسلامية', 'إسلامية', 'الاسلامية', 'الإسلامية', 'التربية الاسلامية', 'التربية الإسلامية'] },
  { key: 'civic', name: 'التربية على المواطنة', names: ['مواطنة', 'المواطنة', 'التربية على المواطنة'] },
  { key: 'en', name: 'الإنجليزية', names: ['انجليزية', 'إنجليزية', 'الانجليزية', 'الإنجليزية', 'english'] },
  { key: 'fr', name: 'الفرنسية', names: ['فرنسية', 'الفرنسية', 'francais', 'français', 'french'] },
  { key: 'math', name: 'الرياضيات', names: ['رياضيات', 'الرياضيات', 'math', 'maths'] },
  { key: 'phys', name: 'الفيزياء', names: ['فيزياء', 'الفيزياء', 'physique'] },
  { key: 'svt', name: 'علوم الحياة والأرض', names: ['svt', 'علوم الحياة والأرض', 'علوم الحياة', 'علوم'] }
]
function findSubject(text) {
  const t = text.trim().toLowerCase()
  if (!t) return null
  return SUBJECTS.find(s => s.names.some(n => t === n.toLowerCase())) ||
    SUBJECTS.find(s => s.names.some(n => t.includes(n.toLowerCase()))) || null
}

// ---------- حفظ الملفات ----------
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return {} }
}
let chats = loadJson(CHATS_FILE)
let profiles = loadJson(PROFILES_FILE)
let saveTimer
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(CHATS_FILE, JSON.stringify(chats))
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles))
    } catch (e) { console.log('save failed:', e.message) }
  }, 1500)
}
function pushHistory(jid, role, content) {
  const arr = (chats[jid] ||= [])
  arr.push({ role, content: String(content).slice(0, role === 'assistant' ? 3500 : 2500) })
  while (arr.length > HISTORY_LIMIT) arr.shift()
  save()
}

// ---------- المراجع الرسمية (مجلد knowledge) ----------
function readKnow(name) {
  try { return fs.readFileSync(path.join(KNOW_DIR, name), 'utf8').trim().slice(0, 6000) } catch (e) { return '' }
}
function loadKnowledge(prof) {
  const parts = []
  const general = readKnow('general.txt')
  if (general) parts.push(general)
  if (prof?.level && prof?.subject) {
    const k = readKnow(`${prof.level}-${prof.subject}.txt`)
    if (k) parts.push(k)
  }
  return parts.join('\n\n')
}

// ---------- الوقت والحدود ----------
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date())
}
const hits = new Map()
function limited(id) {
  const now = Date.now()
  const arr = (hits.get(id) || []).filter(t => now - t < 10 * 60 * 1000)
  arr.push(now)
  hits.set(id, arr)
  return arr.length > 25
}
const daily = new Map()
function overDaily(id) {
  const k = `${id}|${today()}`
  const n = (daily.get(k) || 0) + 1
  daily.set(k, n)
  if (daily.size > 5000) daily.clear()
  return n > DAILY_LIMIT
}

// ---------- تقسيم الجواب الطويل ----------
function chunks(text, max = 3500) {
  const out = []
  let cur = ''
  for (const para of text.split('\n\n')) {
    if (cur && (cur + '\n\n' + para).length > max) { out.push(cur); cur = '' }
    if (para.length > max) {
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max))
    } else {
      cur = cur ? cur + '\n\n' + para : para
    }
  }
  if (cur) out.push(cur)
  return out
}

// ---------- Groq ----------
const blocked = new Map()
async function callGroq(model, system, past, userContent) {
  if (!GROQ_KEY || (blocked.get(model) || 0) > Date.now()) return null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const body = {
        model, temperature: 0.5, max_completion_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: system }, ...past, { role: 'user', content: userContent }]
      }
      if (model.includes('gpt-oss')) body.reasoning_effort = REASONING
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify(body)
      })
      const raw = await res.text()
      let data = null
      try { data = JSON.parse(raw) } catch (e) { /* ماشي JSON */ }
      if (res.ok && data) {
        const out = data?.choices?.[0]?.message?.content?.trim()
        if (out) return out
      }
      console.log('GROQ ERROR', model, res.status, raw.slice(0, 250))
      if (res.status === 429) {
        if (/per day|TPD/i.test(raw)) {
          const mt = /try again in (?:(\d+)h)?(?:(\d+)m)?/i.exec(raw)
          const mins = mt ? Number(mt[1] || 0) * 60 + Number(mt[2] || 0) : 30
          blocked.set(model, Date.now() + Math.max(mins, 1) * 60 * 1000)
          console.log('DAILY LIMIT', model, 'skipping', Math.max(mins, 1), 'min')
          return null
        }
        await sleep(4000)
        continue
      }
      if (res.status === 413) return null
      if (data && ![500, 502, 503].includes(res.status)) break
    } catch (e) {
      console.log('GROQ FETCH ERROR', model, e.message)
    }
    await sleep(2000 * attempt)
  }
  return null
}

// ---------- Gemini ----------
async function callGemini(system, past, text, images) {
  if (!GEMINI_KEY || (blocked.get('gemini') || 0) > Date.now()) return null
  const contents = [
    ...past.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    {
      role: 'user',
      parts: [
        ...images.slice(0, 4).map(b => ({
          inline_data: { mime_type: 'image/jpeg', data: b.toString('base64') }
        })),
        { text }
      ]
    }
  ]
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.5, maxOutputTokens: MAX_TOKENS }
        })
      })
      const raw = await res.text()
      let data = null
      try { data = JSON.parse(raw) } catch (e) { /* ماشي JSON */ }
      if (res.ok && data) {
        const out = (data?.candidates?.[0]?.content?.parts || [])
          .map(p => p.text || '').join('').trim()
        if (out) return out
      }
      console.log('GEMINI ERROR', GEMINI_MODEL, res.status, raw.slice(0, 250))
      if (res.status === 429) {
        blocked.set('gemini', Date.now() + 10 * 60 * 1000)
        return null
      }
      if (![500, 502, 503].includes(res.status)) break
    } catch (e) {
      console.log('GEMINI FETCH ERROR', e.message)
    }
    await sleep(2500 * attempt)
  }
  return null
}

// ---------- قراءة الصور (نقل نص التمرين بدقة) ----------
async function readImages(images) {
  const sys = 'نتا قارئ دقيق للصور المدرسية. كتنقل المحتوى بالضبط كيف هو، بلا ما تزيد ولا تنقص ولا تحل.'
  const ask =
    'انقل نص التمرين أو الدرس اللي فهاد الصورة كامل وبالضبط (بنفس اللغة)، بما فيه الأرقام والمعادلات والجداول والأسئلة والترقيم. ' +
    'إلا كان فيه شكل هندسي أو رسم بياني أو خريطة أو صورة، وصفو بالتفصيل. ' +
    'ما تحل ولا تشرح، غير انقل. إلا شي جزء ما واضحش، كتب [غير واضح].'
  let out = await callGemini(sys, [], ask, images)
  if (!out && GROQ_KEY) {
    const content = [
      { type: 'text', text: ask },
      ...images.slice(0, 3).map(b => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` }
      }))
    ]
    out = await callGroq(GROQ_VISION_MODEL, sys, [], content)
  }
  return out
}

// ---------- الجواب ----------
async function answerText(system, past, text) {
  const tryGroq = async () => {
    for (const m of GROQ_MODELS) {
      const o = await callGroq(m, system, past, text)
      if (o) return o
    }
    return null
  }
  const tryGemini = () => callGemini(system, past, text, [])
  if (PRIMARY === 'gemini') return (await tryGemini()) || (await tryGroq())
  return (await tryGroq()) || (await tryGemini())
}

async function askAI(jid, userText, images = []) {
  if (!GROQ_KEY && !GEMINI_KEY) {
    console.log('ERROR: no GROQ_API_KEY or GEMINI_API_KEY')
    return null
  }
  const prof = profiles[jid] || {}
  const lvl = prof.level ? LEVEL_BY_KEY[prof.level] : null
  const subj = SUBJECTS.find(s => s.key === prof.subject)
  const know = loadKnowledge(prof)

  let system = PROMPT + '\n\n[معلومات التلميذ]\n' +
    `المستوى: ${lvl ? lvl.name : 'ما تحددش (افترضو من السؤال)'}\n` +
    `المادة: ${subj ? subj.name : 'ما تحددتش (افترضها من السؤال)'}\n` +
    `الوضع: ${prof.mode === 'hint' ? '[وضع التلميح: ما تعطيش الحل كامل]' : 'شرح وحل كامل'}`
  if (know) system += `\n\n[مراجع رسمية للمنهجية: التزم بها]\n${know}`

  const past = [...(chats[jid] || [])]
  while (past.length && past[0].role !== 'user') past.shift()

  let text = userText
  let out = null

  if (images.length) {
    const tr = await readImages(images)
    if (tr) {
      text = `${userText || 'شرح ليا هاد التمرين وحلو.'}\n\n[محتوى الصورة (منقول)]\n${tr}\n[نهاية المحتوى المنقول. إلا شي حاجة ما واضحاش، سول التلميذ.]`
      out = await answerText(system, past, text)
    } else {
      out = await callGemini(system, past, userText || 'شرح ليا هاد التمرين وحلو.', images)
    }
  } else {
    out = await answerText(system, past, text)
  }

  if (out) {
    pushHistory(jid, 'user', images.length ? `${userText || 'تمرين'} [صورة تمرين: ${text.slice(0, 1500)}]` : userText)
    pushHistory(jid, 'assistant', out)
  }
  return out
}

// ---------- فهم الرسائل الصوتية ----------
async function transcribe(buf) {
  if (!GROQ_KEY) return null
  try {
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg')
    form.append('model', STT_MODEL)
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form
    })
    const data = await res.json()
    if (!res.ok) {
      console.log('STT ERROR', res.status, JSON.stringify(data).slice(0, 300))
      return null
    }
    return data?.text?.trim() || null
  } catch (e) {
    console.log('STT FETCH ERROR', e.message)
    return null
  }
}

// ---------- نصوص ثابتة ----------
const HELP =
  `📚 *مساعد الدراسة*\n` +
  `نشرح ليك الدروس ونحل معاك التمارين خطوة بخطوة.\n\n` +
  `*كيفاش تستعملني:*\n` +
  `- كتب /شرح وبعدها السؤال ولا الدرس. مثلا: /شرح شنو هو الفاعل؟\n` +
  `- صيفط صورة ديال تمرين وكتب فالتعليق: /تمرين\n` +
  `- من بعد الأمر، تقدر تكمل تهضر معايا ${SESSION_MIN} دقيقة بلا أوامر (مثلا "ما فهمتش" وغادي نعاود ليك بطريقة أخرى، ولا فويس).\n` +
  `- /وقف باش توقف الجلسة.\n\n` +
  `*أوامر:*\n` +
  `/مستوى ← اختار المستوى\n` +
  `/مادة فلسفة ← حدد المادة\n` +
  `/تلميح ← غير تلميح باش تحل بوحدك\n` +
  `/حل ← الشرح والحل كامل\n` +
  `/reset ← نبداو من الأول`
const LEVEL_MENU =
  `شنو المستوى ديالك؟\n` +
  `1️⃣ ثالثة إعدادي\n` +
  `2️⃣ ثانية باك (الآداب والعلوم الإنسانية)\n\n` +
  `كتب: /مستوى 1 ولا /مستوى 2`
const SUBJECT_LIST = SUBJECTS.map(s => s.name).join('، ')

// ---------- البوت ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })
  let asked = false

  const myIds = () => [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !asked && !sock.authState.creds.registered && process.env.PHONE) {
      asked = true
      try {
        const code = await sock.requestPairingCode(process.env.PHONE)
        console.log('PAIRING CODE:', code)
      } catch (e) {
        console.log('pairing error:', e.message)
        asked = false
      }
    }
    if (connection === 'open') console.log('Bot connected')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('connection closed, code:', code)
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000)
      else console.log('logged out, change AUTH_DIR and relink')
    }
  })

  const getMedia = (msgObj, key) =>
    downloadMediaMessage(
      { key, message: msgObj }, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )

  async function sendLong(jid, m, text) {
    const parts = chunks(text)
    for (const [i, part] of parts.entries()) {
      await sock.sendMessage(jid, { text: part }, i === 0 && m ? { quoted: m } : {})
      if (i < parts.length - 1) await sleep(700)
    }
  }

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue
        const jid = m.key.remoteJid
        if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue
        const isGroup = jid.endsWith('@g.us')

        const msg = normalizeMessageContent(m.message)
        if (!msg) continue
        const ext = msg.extendedTextMessage
        const img = msg.imageMessage
        const aud = msg.audioMessage
        const text = msg.conversation || ext?.text || img?.caption || ''
        const ctx = ext?.contextInfo || img?.contextInfo || aud?.contextInfo
        const name = m.pushName || 'تلميذ'
        const senderId = isGroup ? m.key.participant : jid

        // ----- تحكم المالك (فالخاص فقط) -----
        if (!isGroup) {
          const ids = [jid, m.key.remoteJidAlt].filter(Boolean)
            .map(x => userPart(x).replace(/\D/g, ''))
          const isOwner = !!OWNER && ids.includes(OWNER)
          const c0 = text.trim().split(/\s+/)[0]
          const say = t => sock.sendMessage(jid, { text: t }, { quoted: m })
          if (c0 === '/معرف' && (!OWNER || isOwner)) {
            await say(`المعرفات ديالك (حط واحد منهم فـ OWNER):\n${ids.join('\n')}`)
            continue
          }
          if (isOwner && c0 === '/شغل') {
            botState.enabled = true
            saveState()
            await say('✅ البوت خدام دابا.')
            continue
          }
          if (isOwner && c0 === '/حبس') {
            botState.enabled = false
            saveState()
            await say('⏹️ البوت وقف. ما غاديش يجاوب حتى واحد حتى تكتب /شغل.')
            continue
          }
          if (isOwner && c0 === '/حالة') {
            await say(`الحالة: ${botState.enabled ? '✅ خدام' : '⏹️ موقف'}\nالجلسات المفتوحة: ${[...sessions.values()].filter(t => t > Date.now()).length}`)
            continue
          }
        }
        if (!botState.enabled) continue

        // فالخاص: لائحة مسموحين (اختياري)
        if (!isGroup && ALLOWED_USERS.length) {
          const ids = [jid, m.key.remoteJidAlt].filter(Boolean)
            .map(x => userPart(x).replace(/\D/g, ''))
          if (!ids.some(i => ALLOWED_USERS.includes(i))) {
            console.log('BLOCKED private chat:', ids.join(','))
            continue
          }
        }

        const me = myIds()
        const clean = text.replace(/@\d+/g, '').trim()
        const [cmd, ...rest] = clean.split(/\s+/)
        const arg = rest.join(' ').trim()
        const sessKey = isGroup ? `${jid}|${m.key.participant}` : jid
        const isAskCmd = ASK_CMDS.includes(cmd)
        const inSession = (sessions.get(sessKey) || 0) > Date.now()
        let body = clean
        let newSession = false

        if (COMMAND_ONLY) {
          const waitingLevel = profiles[jid]?.awaitLevel && LEVELS[clean]
          if (isAskCmd) {
            body = arg
            if (!inSession) newSession = true
            sessions.set(sessKey, Date.now() + SESSION_MIN * 60 * 1000)
          } else if (ALWAYS_CMDS.includes(cmd) || waitingLevel) {
            // أوامر ديما خدامة
          } else if (inSession) {
            sessions.set(sessKey, Date.now() + SESSION_MIN * 60 * 1000)
          } else {
            continue // ما كاين لا أمر لا جلسة: تجاهل
          }
        } else if (isGroup) {
          const mentioned = (ctx?.mentionedJid || []).some(j => me.includes(userPart(j)))
          const repliedToBot = ctx?.participant && me.includes(userPart(ctx.participant))
          if (!mentioned && !repliedToBot) continue
        }

        const prof = (profiles[jid] ||= {})
        const reply = t => sock.sendMessage(jid, { text: t }, { quoted: m })

        // ----- الأوامر -----
        if (cmd === '/وقف') {
          sessions.delete(sessKey)
          await reply('⏹️ تسالات الجلسة. كتب /شرح باش نبداو من جديد.')
          continue
        }
        if (isAskCmd && !arg && !img && !ctx?.quotedMessage?.imageMessage) {
          await reply('سير، شنو بغيتي تفهم؟ كتب السؤال ولا صيفط صورة التمرين 📚')
          continue
        }
        if (['/مساعدة', '/help', '/start', '/ابدأ'].includes(cmd)) {
          await reply(HELP)
          continue
        }
        if (clean === '/reset') {
          delete chats[jid]
          save()
          await reply('🧹 تمسح السجل. نبداو من الأول.')
          continue
        }
        if (cmd === '/مستوى') {
          const lv = LEVELS[arg]
          if (!lv) {
            prof.awaitLevel = true
            save()
            await reply(LEVEL_MENU)
          } else {
            prof.level = lv.key
            prof.awaitLevel = false
            save()
            await reply(`✅ تحدد المستوى: *${lv.name}*\nدابا حدد المادة بـ /مادة، مثلا: /مادة فلسفة\nولا صيفط ليا السؤال مباشرة.`)
          }
          continue
        }
        if (prof.awaitLevel && LEVELS[clean]) {
          prof.level = LEVELS[clean].key
          prof.awaitLevel = false
          save()
          await reply(`✅ تحدد المستوى: *${LEVELS[clean].name}*\nدابا حدد المادة بـ /مادة، مثلا: /مادة فلسفة\nولا صيفط ليا السؤال مباشرة.`)
          continue
        }
        if (cmd === '/مادة') {
          const s = findSubject(arg)
          if (!s) {
            await reply(`المواد: ${SUBJECT_LIST}\n\nكتب مثلا: /مادة فلسفة`)
          } else {
            prof.subject = s.key
            save()
            await reply(`✅ تحددات المادة: *${s.name}*\nصيفط ليا السؤال ولا صورة التمرين.`)
          }
          continue
        }
        if (cmd === '/تلميح') {
          prof.mode = 'hint'
          save()
          await reply('💡 وضع التلميح: غادي نعطيك غير خطوة وحدة وتكمل بوحدك. باش ترجع للحل كامل كتب /حل')
          continue
        }
        if (cmd === '/حل') {
          prof.mode = 'full'
          save()
          await reply('✅ وضع الشرح والحل كامل.')
          continue
        }

        // ----- الحدود -----
        if (limited(senderId || jid)) {
          await reply('بشوية شوية 😅 بزاف د الرسائل، عاود من بعد شوية.')
          continue
        }
        if (overDaily(senderId || jid)) {
          await reply(`وصلتي الحد اليومي (${DAILY_LIMIT} رسالة). عاود غدا 🙏`)
          continue
        }

        // ----- الصور والصوتيات -----
        let userText = body
        let transcript = null
        const images = []
        const q = ctx?.quotedMessage
        const qKey = ctx?.stanzaId
          ? { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }
          : null

        try {
          if (img) images.push(await getMedia(msg, m.key))
          else if (q?.imageMessage && qKey) images.push(await getMedia(q, qKey))
          if (aud) {
            transcript = await transcribe(await getMedia(msg, m.key))
            if (!transcript) {
              await reply('ما قدرتش نسمع الفويس. كتب لي السؤال ولا عاود صيفطو.')
              continue
            }
            userText = transcript
          }
        } catch (e) {
          console.log('media failed:', e.message)
        }

        if (!userText && !images.length) continue

        const quotedText = q?.conversation || q?.extendedTextMessage?.text
        if (quotedText) userText = `[رسالة مقتبسة: ${quotedText}]\n${userText}`
        if (isGroup) userText = `${name}: ${userText}`

        await sock.sendPresenceUpdate('composing', jid)
        const answer = await askAI(jid, userText, images)
        await sock.sendPresenceUpdate('paused', jid)

        let out = answer || FAIL
        if (answer && newSession) out += `\n\n⏱️ الجلسة مفتوحة ${SESSION_MIN} دقيقة، تقدر تكمل بلا أوامر. /وقف باش توقفها.`
        if (answer && !prof.level && !prof.tip) {
          prof.tip = true
          save()
          out += '\n\n💡 باش نشرح ليك على قد المنهاج ديالك، كتب /مستوى'
        }
        if (transcript) out = `🎙️ سمعت: «${transcript}»\n\n${out}`
        await sendLong(jid, m, out)
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

start()
