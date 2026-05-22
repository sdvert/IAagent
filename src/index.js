const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { handleMessage } = require('./claudeAgent')

// Suprime logs internos do protocolo Signal do Baileys que expõem chaves privadas
const _origLog = console.log
console.log = (...args) => {
  const msg = String(args[0] ?? '')
  if (msg.includes('Closing open session') || msg.includes('Closing session:')) return
  _origLog(...args)
}

let retryCount = 0
const MAX_RETRIES = 5

// Extrai apenas os dígitos do número de um JID (ex: "5511999:42@s.whatsapp.net" → "5511999")
function phoneFromJid(jid) {
  return jid?.split('@')[0]?.split(':')[0] || null
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  console.log(`🤖 Iniciando agente WhatsApp com Baileys v${version.join('.')}...`)

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp Agent', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  })

  let botNumber = phoneFromJid(state.creds?.me?.id) || null
  let botLid = phoneFromJid(state.creds?.me?.lid) || null
  if (botNumber) console.log(`🤖 Número do bot (credenciais salvas): ${botNumber} | LID: ${botLid}`)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR Code abaixo com o WhatsApp:')
      console.log('   (Dispositivos Conectados → Conectar dispositivo)\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log(`❌ Conexão encerrada. Código: ${statusCode}`)

      if (shouldReconnect && retryCount < MAX_RETRIES) {
        retryCount++
        const delay = retryCount * 3000
        console.log(`🔄 Reconectando em ${delay / 1000}s... (tentativa ${retryCount}/${MAX_RETRIES})`)
        setTimeout(startBot, delay)
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log('🚪 Sessão encerrada. Delete a pasta auth_info e reinicie para reconectar.')
        process.exit(0)
      } else {
        console.log('⚠️  Limite de reconexões atingido. Reinicie o processo.')
        process.exit(1)
      }
    }

    if (connection === 'open') {
      retryCount = 0
      botNumber = phoneFromJid(sock.user?.id)
      botLid = phoneFromJid(sock.user?.lid)
      console.log('✅ WhatsApp conectado com sucesso!')
      console.log(`🤖 Número do bot: ${botNumber} | LID: ${botLid}`)
      console.log('📨 Aguardando mensagens...\n')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const from = msg.key.remoteJid
      const isGroup = from.endsWith('@g.us')

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        null

      if (!text) continue

      // Em grupos: só responde se o bot foi mencionado
      if (isGroup) {
        if (!botNumber) {
          console.log(`⚠️  [grupo] botNumber ainda não definido, ignorando mensagem`)
          continue
        }
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
        const wasMentioned = mentionedJids.some(jid => {
          const id = phoneFromJid(jid)
          return id === botNumber || (botLid && id === botLid)
        })
        console.log(`👥 [grupo] mencionados: ${mentionedJids.map(phoneFromJid).join(', ') || 'nenhum'} | bot: ${botNumber} | lid: ${botLid} | mencionado: ${wasMentioned}`)
        if (!wasMentioned) continue
      }

      const sessionId = from
      const sender = isGroup ? msg.key.participant : from
      const contact = from.replace(/@.+/, '')
      const label = isGroup ? `grupo:${contact}` : contact

      console.log(`📩 [${label}]: ${text}`)

      try {
        await sock.sendPresenceUpdate('composing', from)
      } catch (e) {
        console.error(`⚠️ [${label}] sendPresenceUpdate falhou:`, e.message)
      }

      try {
        const cleanText = text.replace(/@\d+/g, '').trim()

        console.log(`⏳ [${label}] processando com Claude...`)
        const response = await handleMessage(sessionId, cleanText)
        console.log(`✅ [${label}] Claude respondeu (${response.length} chars)`)

        if (isGroup && sender) {
          await sock.sendMessage(from, { text: response, mentions: [sender] })
        } else {
          await sock.sendMessage(from, { text: response })
        }

        console.log(`📤 [${label}]: ${response.substring(0, 80)}...`)
      } catch (err) {
        console.error(`❌ [${label}] Erro:`, err.message, err.stack?.split('\n')[1] || '')
        try {
          await sock.sendMessage(from, {
            text: '⚠️ Ocorreu um erro ao processar sua mensagem. Tente novamente.'
          })
        } catch (e2) {
          console.error(`❌ [${label}] sendMessage de erro também falhou:`, e2.message)
        }
      } finally {
        try {
          await sock.sendPresenceUpdate('paused', from)
        } catch (e) {}
      }
    }
  })
}

startBot().catch(err => {
  console.error('Erro fatal ao iniciar o bot:', err)
  process.exit(1)
})
