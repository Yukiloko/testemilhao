"use client";

import { useActionState } from "react";
import { createExperimentAction } from "../actions";

export function ExperimentForm() {
  const [state, action, pending] = useActionState(createExperimentAction, {});
  return (
    <form action={action} className="card flex flex-col gap-2 text-sm" aria-labelledby="new-exp">
      <h2 id="new-exp" className="font-semibold">Novo experimento</h2>
      <label>Nome<input className="input mt-1" name="name" required /></label>
      <label>Funil
        <select className="input mt-1" name="funnel"><option value="customer">Clientes</option><option value="affiliate">Afiliados</option></select>
      </label>
      <label>Variável testada
        <select className="input mt-1" name="variable">
          <option value="opening">Mensagem inicial</option>
          <option value="followup_cadence">Cadência de follow-up</option>
        </select>
      </label>
      <label>Hipótese<input className="input mt-1" name="hypothesis" required /></label>
      <label>Métrica principal
        <select className="input mt-1" name="primaryMetric">
          <option value="replied">Respondeu</option>
          <option value="interested">Interessado</option>
          <option value="whatsapp_handoff">Encaminhado ao WhatsApp</option>
          <option value="joined_affiliate_group">Entrou no grupo</option>
        </select>
      </label>
      <label>Amostra mínima por variante<input className="input mt-1" name="minSamplePerVariant" type="number" min="10" defaultValue="50" /></label>
      <label>Fatia de exploração (0 a 0,5)<input className="input mt-1" name="explorationRate" type="number" step="0.05" min="0" max="0.5" defaultValue="0.1" /></label>
      <label>Controle — instrução de abordagem<textarea className="input mt-1" name="controlInstructions" rows={2} required /></label>
      <label>Desafiante — instrução de abordagem<textarea className="input mt-1" name="challengerInstructions" rows={2} required /></label>
      <label>Controle — dias de follow-up (ex.: 3,7)<input className="input mt-1" name="controlFollowupDays" /></label>
      <label>Desafiante — dias de follow-up (ex.: 2,5)<input className="input mt-1" name="challengerFollowupDays" /></label>
      <button className="btn btn-primary self-start" disabled={pending}>{pending ? "Criando…" : "Criar experimento"}</button>
      {state.error && <p role="alert" className="text-bad">{state.error}</p>}
      {state.ok && <p role="status" className="text-ok">Experimento criado.</p>}
    </form>
  );
}
