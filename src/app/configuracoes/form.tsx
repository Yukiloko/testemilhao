"use client";

import { useActionState } from "react";
import type { RuntimeSettings } from "@/features/safety/settings";
import { updateLimitsAction } from "../actions";

export function LimitsForm({ settings: s }: { settings: RuntimeSettings }) {
  const [state, action, pending] = useActionState(updateLimitsAction, {});
  return (
    <form action={action} className="card grid max-w-2xl gap-3 text-sm sm:grid-cols-2">
      <label>DMs por dia (máximo após aquecimento)<input className="input mt-1" name="maxDmsPerDay" type="number" min="0" defaultValue={s.maxDmsPerDay} /></label>
      <label>Janela de operação (HH:MM-HH:MM)<input className="input mt-1" name="operatingHours" defaultValue={s.operatingHours} pattern="\d{2}:\d{2}-\d{2}:\d{2}" /></label>
      <label>Intervalo mínimo entre DMs (s)<input className="input mt-1" name="minSecondsBetweenDms" type="number" defaultValue={s.minSecondsBetweenDms} /></label>
      <label>Intervalo máximo entre DMs (s)<input className="input mt-1" name="maxSecondsBetweenDms" type="number" defaultValue={s.maxSecondsBetweenDms} /></label>
      <label>Dias dos follow-ups (ex.: 3,7)<input className="input mt-1" name="followupDays" defaultValue={s.followupDays.join(",")} /></label>
      <label>Pontuação mínima para qualificar<input className="input mt-1" name="minQualifyScore" type="number" min="0" max="100" defaultValue={s.minQualifyScore} /></label>
      <label>Confiança mínima para responder sozinha (0–1)<input className="input mt-1" name="minConfidenceToAutoReply" type="number" step="0.05" min="0" max="1" defaultValue={s.minConfidenceToAutoReply} /></label>
      <div className="flex flex-col justify-end gap-2">
        <label className="flex items-center gap-2"><input type="checkbox" name="discoveryEnabled" defaultChecked={s.discoveryEnabled} /> Descoberta automática ativa</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="autoReplyEnabled" defaultChecked={s.autoReplyEnabled} /> Resposta automática pela API ativa</label>
      </div>
      <div className="sm:col-span-2">
        <button className="btn btn-primary" disabled={pending}>{pending ? "Salvando…" : "Salvar limites"}</button>
        {state.error && <p role="alert" className="mt-2 text-bad">{state.error}</p>}
        {state.ok && <p role="status" className="mt-2 text-ok">Limites salvos.</p>}
      </div>
    </form>
  );
}
