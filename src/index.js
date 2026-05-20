const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { handleMessage } = require('./claudeAgent')

let retryCount = 0
const MAX_RETRIES = 5

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

  let botNumber = null

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
      botNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0]
      console.log('✅ WhatsApp conectado com sucesso!')
      console.log(`🤖 Número do bot: ${botNumber}`)
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
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
        const botJid = botNumber ? `${botNumber}@s.whatsapp.net` : null
        const wasMentioned = botJid && mentionedJids.includes(botJid)
        if (!wasMentioned) continue
      }

      // Usa o JID do grupo como chave de sessão para manter contexto separado por grupo/privado
      const sessionId = from
      const sender = isGroup ? msg.key.participant : from
      const contact = (isGroup ? from : from).replace(/@.+/, '')
      const label = isGroup ? `grupo:${contact}` : contact

      console.log(`📩 [${label}]: ${text}`)

      await sock.sendPresenceUpdate('composing', from)

      try {
        // Remove a menção (@número) do texto antes de enviar ao Claude
        const cleanText = text.replace(/@\d+/g, '').trim()
        const response = await handleMessage(sessionId, cleanText)

        // Em grupos: responde mencionando quem enviou
        if (isGroup && sender) {
          await sock.sendMessage(from, {
            text: response,
            mentions: [sender]
          })
        } else {
          await sock.sendMessage(from, { text: response })
        }

        console.log(`📤 [${label}]: ${response.substring(0, 80)}...`)
      } catch (err) {
        console.error(`❌ Erro ao processar mensagem de ${label}:`, err.message)
        await sock.sendMessage(from, {
          text: '⚠️ Ocorreu um erro ao processar sua mensagem. Tente novamente.'
        })
      } finally {
        await sock.sendPresenceUpdate('paused', from)
      }
    }
  })
}

startBot().catch(err => {
  console.error('Erro fatal ao iniciar o bot:', err)
  process.exit(1)
})
