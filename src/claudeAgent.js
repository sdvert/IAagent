const Anthropic = require('@anthropic-ai/sdk')
const { getHistory, saveHistory } = require('./sessionStore')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

let CLICKUP_TOOLS = []
let executeTool = null
if (process.env.CLICKUP_API_KEY) {
  const clickup = require('./clickupTools')
  CLICKUP_TOOLS = clickup.CLICKUP_TOOLS
  executeTool = clickup.executeTool
  console.log('🔧 ClickUp integrado:', CLICKUP_TOOLS.map(t => t.name).join(', '))
}

const SYSTEM_PROMPT = `Você é um assistente inteligente disponível via WhatsApp.

Regras de comportamento:
- Responda sempre em português brasileiro, de forma clara e natural
- Seja direto e objetivo — mensagens de WhatsApp devem ser curtas quando possível
- Use formatação simples: evite markdown pesado, prefira texto limpo
- Você pode ajudar com: perguntas gerais, redação, análise de texto, cálculos, programação, tradução, e muito mais
- Se não souber algo, diga claramente
- Não invente informações ou fatos

Identidade:
- Você é um agente de IA baseado no Claude da Anthropic
- Não revele detalhes técnicos da sua implementação, apenas que é um assistente de IA${CLICKUP_TOOLS.length > 0 ? `

ClickUp:
- Você tem acesso ao ClickUp do usuário via ferramentas
- Use buscar_tarefa quando não souber o ID da lista ou tarefa
- Ao listar tarefas, apresente: nome, status e prazo (se houver)
- Para criar tarefas, confirme os detalhes antes de criar` : ''}`

const MAX_TOKENS = 1024
const MAX_HISTORY = 20
const MAX_TOOL_ROUNDS = 5

async function handleMessage(userId, userText) {
  const history = await getHistory(userId)
  history.push({ role: 'user', content: userText })

  const createParams = {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: history
  }

  if (CLICKUP_TOOLS.length > 0) {
    createParams.tools = CLICKUP_TOOLS
  }

  let assistantText = ''

  try {
    let response = await client.messages.create(createParams)

    // Loop de tool_use: executa ferramentas até Claude retornar texto final
    let rounds = 0
    while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
      rounds++

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')
      const toolResults = []

      for (const toolUse of toolUseBlocks) {
        console.log(`🔧 ClickUp tool: ${toolUse.name}`, JSON.stringify(toolUse.input))
        const result = await executeTool(toolUse.name, toolUse.input)
        console.log(`✅ Resultado:`, JSON.stringify(result).substring(0, 200))

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        })
      }

      // Adiciona ao histórico temporário desta requisição (não persiste tool_use no DB)
      const tempMessages = [
        ...history,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults }
      ]

      response = await client.messages.create({ ...createParams, messages: tempMessages })
    }

    assistantText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()

    if (!assistantText) {
      assistantText = 'Não consegui gerar uma resposta. Tente reformular sua mensagem.'
    }

  } catch (err) {
    history.pop()
    await saveHistory(userId, history)

    if (err.status === 401) throw new Error('API Key inválida ou não configurada.')
    if (err.status === 429) throw new Error('Limite de requisições atingido. Aguarde um momento.')
    if (err.status === 500) throw new Error('Erro interno da API Anthropic. Tente novamente.')
    throw err
  }

  history.push({ role: 'assistant', content: assistantText })
  const trimmed = history.slice(-MAX_HISTORY)
  await saveHistory(userId, trimmed)

  return assistantText
}

async function clearHistory(userId) {
  await saveHistory(userId, [])
}

module.exports = { handleMessage, clearHistory }
