const CLICKUP_API = 'https://api.clickup.com/api/v2'

function headers() {
  return {
    'Authorization': process.env.CLICKUP_API_KEY,
    'Content-Type': 'application/json'
  }
}

async function callApi(method, path, body) {
  const res = await fetch(`${CLICKUP_API}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.err || `ClickUp API error ${res.status}`)
  return data
}

const CLICKUP_TOOLS = [
  {
    name: 'listar_tarefas',
    description: 'Lista tarefas de uma lista do ClickUp. Use buscar_tarefa primeiro se não souber o list_id.',
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'ID da lista do ClickUp' },
        status: { type: 'string', description: 'Filtrar por status (ex: "to do", "em andamento", "done")' }
      },
      required: ['list_id']
    }
  },
  {
    name: 'criar_tarefa',
    description: 'Cria uma nova tarefa em uma lista do ClickUp',
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'ID da lista onde criar a tarefa' },
        name: { type: 'string', description: 'Título da tarefa' },
        description: { type: 'string', description: 'Descrição da tarefa (opcional)' },
        due_date: { type: 'string', description: 'Data de vencimento ISO 8601, ex: 2024-12-31 (opcional)' },
        priority: { type: 'number', description: 'Prioridade: 1=urgente 2=alta 3=normal 4=baixa (opcional)' }
      },
      required: ['list_id', 'name']
    }
  },
  {
    name: 'atualizar_status',
    description: 'Atualiza o status de uma tarefa do ClickUp',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID da tarefa' },
        status: { type: 'string', description: 'Novo status (ex: "em andamento", "concluída", "to do")' }
      },
      required: ['task_id', 'status']
    }
  },
  {
    name: 'buscar_tarefa',
    description: 'Busca tarefas por nome ou texto no workspace do ClickUp. Requer CLICKUP_TEAM_ID configurado.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto para buscar nas tarefas' }
      },
      required: ['query']
    }
  }
]

async function listarTarefas({ list_id, status }) {
  const params = new URLSearchParams({ include_closed: 'false' })
  if (status) params.append('statuses[]', status)

  const data = await callApi('GET', `/list/${list_id}/task?${params}`)
  return data.tasks.map(t => ({
    id: t.id,
    nome: t.name,
    status: t.status?.status,
    responsaveis: t.assignees?.map(a => a.username),
    prazo: t.due_date ? new Date(parseInt(t.due_date)).toLocaleDateString('pt-BR') : null,
    url: t.url
  }))
}

async function criarTarefa({ list_id, name, description, due_date, priority }) {
  const body = { name }
  if (description) body.description = description
  if (due_date) body.due_date = new Date(due_date).getTime()
  if (priority) body.priority = priority

  const data = await callApi('POST', `/list/${list_id}/task`, body)
  return { id: data.id, nome: data.name, status: data.status?.status, url: data.url }
}

async function atualizarStatus({ task_id, status }) {
  const data = await callApi('PUT', `/task/${task_id}`, { status })
  return { id: data.id, nome: data.name, status: data.status?.status, url: data.url }
}

async function buscarTarefa({ query }) {
  const teamId = process.env.CLICKUP_TEAM_ID
  if (!teamId) throw new Error('CLICKUP_TEAM_ID não configurado no ambiente.')

  const params = new URLSearchParams({ query })
  const data = await callApi('GET', `/team/${teamId}/task?${params}`)
  return data.tasks.map(t => ({
    id: t.id,
    nome: t.name,
    status: t.status?.status,
    lista: t.list?.name,
    url: t.url
  }))
}

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'listar_tarefas':  return await listarTarefas(input)
      case 'criar_tarefa':    return await criarTarefa(input)
      case 'atualizar_status': return await atualizarStatus(input)
      case 'buscar_tarefa':   return await buscarTarefa(input)
      default: return { error: `Ferramenta desconhecida: ${name}` }
    }
  } catch (err) {
    return { error: err.message }
  }
}

module.exports = { CLICKUP_TOOLS, executeTool }
