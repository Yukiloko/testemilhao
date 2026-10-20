/** PT-BR labels for internal (English) values. The UI never shows raw internal values. */
export const PIPELINE_LABELS: Record<string, string> = {
  discovered: "Descoberto",
  qualified: "Qualificado",
  contacted: "Abordado",
  replied: "Respondeu",
  interested: "Interessado",
  whatsapp_handoff: "Encaminhado ao WhatsApp",
  registered: "Cadastrado",
  active_customer: "Cliente ativo",
  joined_affiliate_group: "Entrou no grupo",
  active_affiliate: "Afiliado ativo",
  generated_customer: "Gerou cliente",
  closed: "Encerrado",
};

export const CHANNEL_LABELS: Record<string, string> = {
  browser_contact_pending: "Aguardando 1º contato",
  browser_contact_sent: "Enviando pelo navegador",
  waiting_inbound_reply: "Aguardando resposta",
  api_eligible: "Pronto para API",
  api_active: "Conversa pela API",
  api_window_closed: "Janela de 24h encerrada",
  human_review_required: "Revisão humana",
  do_not_contact: "Não contatar",
  blocked: "Bloqueado",
  completed: "Concluído",
};

export const FUNNEL_LABELS: Record<string, string> = { customer: "Clientes", affiliate: "Afiliados" };

export const ROLE_LABELS: Record<string, string> = {
  store: "Loja",
  employee: "Funcionário",
  owner: "Dono",
  decision_maker: "Decisor",
  creator: "Criador",
  unknown: "Indefinido",
};

export const SOURCE_LABELS: Record<string, string> = { hashtag: "Hashtag", related: "Perfil relacionado", keyword: "Palavra-chave", import: "Importação", referral: "Indicação" };

export const JOB_LABELS: Record<string, string> = {
  plan_discovery: "Planejar descoberta",
  discover_hashtag: "Descobrir por hashtag",
  enrich_profile: "Ler perfil",
  qualify_lead: "Qualificar lead",
  plan_outreach: "Planejar abordagem",
  send_first_dm: "Enviar 1ª DM",
  schedule_followups: "Agendar follow-ups",
  send_followup: "Enviar follow-up",
  process_inbound: "Processar mensagem recebida",
  reply_inbound: "Responder pela API",
  expire_windows: "Encerrar janelas expiradas",
  evaluate_experiments: "Avaliar experimentos",
  optimize_insights: "Otimizar nichos e horários",
  circuit_breaker: "Verificar disjuntor",
  backup: "Backup do banco",
};

export const JOB_STATUS_LABELS: Record<string, string> = { queued: "Na fila", running: "Executando", succeeded: "Concluído", failed: "Falhou", dead: "Dead-letter", cancelled: "Cancelado" };

export const INTENT_LABELS: Record<string, string> = {
  interested: "Interessado",
  asked_info: "Pediu informação",
  asked_pricing: "Perguntou preço",
  wants_whatsapp: "Quer WhatsApp",
  not_the_owner: "Não é o dono",
  will_forward: "Vai repassar",
  objection: "Objeção",
  not_interested: "Sem interesse",
  opt_out: "Pediu para parar",
  ambiguous: "Ambíguo",
  needs_human: "Precisa de humano",
};

export const ACTION_LABELS: Record<string, string> = {
  reply: "Responder",
  ask: "Perguntar",
  present: "Apresentar",
  handle_objection: "Tratar objeção",
  send_whatsapp: "Encaminhar ao WhatsApp",
  wait: "Aguardar",
  schedule_followup: "Agendar follow-up",
  close: "Encerrar",
  escalate: "Escalar para humano",
};

export const OUTCOME_LABELS: Record<string, string> = { sent: "Enviada", blocked_by_claims: "Bloqueada (afirmações)", escalated: "Escalada", no_reply: "Sem resposta", failed: "Falhou" };

export const EXCEPTION_LABELS: Record<string, string> = {
  delivery_unknown: "Entrega incerta",
  content_blocked: "Conteúdo bloqueado",
  needs_human: "Precisa de humano",
  api_window_closed: "Janela expirada",
  api_send_refused: "Envio pela API recusado",
  api_error: "Erro na API",
  inbound_during_review: "Resposta durante revisão",
};

export const VARIABLE_LABELS: Record<string, string> = { opening: "Mensagem inicial", presentation: "Apresentação", cta: "CTA", followup_cadence: "Cadência de follow-up", send_hour: "Horário de envio" };

export const EVENT_LABELS: Record<string, string> = {
  "lead.discovered": "Lead descoberto",
  "lead.scored": "Pontuação calculada",
  "lead.qualification_decided": "Qualificação decidida",
  "lead.pipeline_changed": "Etapa alterada",
  "lead.opted_out": "Pediu para não ser contatado",
  "channel.changed": "Canal alterado",
  "channel.igsid_matched": "ID da Meta vinculado",
  "channel.divergence": "Divergência de canal",
  "channel.transition_skipped": "Transição de canal ignorada",
  "message.outbound": "Mensagem enviada",
  "message.inbound": "Mensagem recebida",
  "message.duplicate_suspected": "Possível duplicidade",
  "ai.decision": "Decisão da IA",
  "ai.reply_blocked": "Rascunho bloqueado",
  "affiliate.group_link_sent": "Link do grupo enviado",
  "exception.opened": "Exceção aberta",
  "system.paused": "Sistema pausado",
  "system.resumed": "Sistema retomado",
};

export const label = (map: Record<string, string>, key: string | null | undefined) => (key ? (map[key] ?? key) : "—");

export const ACTOR_LABELS: Record<string, string> = { system: "sistema", ai: "IA", operator: "operador", webhook: "webhook", browser: "navegador" };

const SCORE_REASON_PREFIXES: [RegExp, string][] = [
  [/^keywords: /, "Palavras-chave: "],
  [/^segment: /, "Segmento: "],
  [/^topics: /, "Temas: "],
  [/^role: /, "Papel: "],
  [/^engagement /, "Engajamento "],
  [/^business account$/, "Conta comercial"],
  [/^geography match$/, "Região compatível"],
  [/^followers in range$/, "Seguidores na faixa ideal"],
  [/^audience size in range$/, "Audiência na faixa ideal"],
  [/^portuguese content$/, "Conteúdo em português"],
  [/^consistent posting$/, "Publica com frequência"],
  [/^private profile \(capped\)$/, "Perfil privado (pontuação limitada)"],
];

/** Score reasons are stored in English (code language) and translated for the operator. */
export function scoreReasonLabel(reason: string): string {
  for (const [re, pt] of SCORE_REASON_PREFIXES) if (re.test(reason)) return reason.replace(re, pt).replace(/^Papel: (\w+)$/, (_m, r: string) => `Papel: ${ROLE_LABELS[r] ?? r}`);
  return reason;
}
