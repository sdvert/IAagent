const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { handleMessage } = require('./claudeAgent')

// Suprime logs internos do protocolo Signal do Baileys (usam console.log diretamente,
// bypassam o pino logger) e expõem dados criptográficos sensíveis como chaves privadas
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

// Envia mensagem com até 3 tentativas — necessário porque após renovação de sessão
// Signal (prekey bundle) o sendMessage pode falhar silenciosamente na 1ª tentativa
async function sendWithRetry(sock, from, message, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await sock.sendMessage(from, message)
      if (result?.key?.id) return result
      throw new Error('sem ID de mensagem retornado')
    } catch (err) {
      if (attempt === 3) throw err
      console.log(`⚠️ [${label}] Envio falhou (tentativa ${attempt}/3): ${err.message} — aguardando 2s`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
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

  // Inicializa a partir das credenciais salvas para evitar race condition em reconexões
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
        // Compara número de telefone E LID (WhatsApp migrou para LIDs internos)
        const wasMentioned = mentionedJids.some(jid => {
          const id = phoneFromJid(jid)
          return id === botNumber || (botLid && id === botLid)
        })
        console.log(`👥 [grupo] mencionados: ${mentionedJids.map(phoneFromJid).join(', ') || 'nenhum'} | bot: ${botNumber} | lid: ${botLid} | mencionado: ${wasMentioned}`)
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
          await sendWithRetry(sock, from, { text: response, mentions: [sender] }, label)
        } else {
          await sendWithRetry(sock, from, { text: response }, label)
        }

        console.log(`📤 [${label}]: ${response.substring(0, 80)}...`)
      } catch (err) {
        console.error(`❌ Erro ao processar mensagem de ${label}:`, err.message)
        await sendWithRetry(sock, from, {
          text: '⚠️ Ocorreu um erro ao processar sua mensagem. Tente novamente.'
        }, label).catch(() => {})
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
