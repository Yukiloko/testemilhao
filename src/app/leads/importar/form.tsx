"use client";

import { useActionState } from "react";
import { importLeadsAction } from "../../actions";

export function ImportForm() {
  const [state, action, pending] = useActionState(importLeadsAction, {});
  return (
    <form action={action} className="card flex max-w-2xl flex-col gap-3">
      <fieldset className="flex gap-4 text-sm">
        <legend className="mb-1 font-medium">Funil</legend>
        <label className="flex items-center gap-1"><input type="radio" name="funnel" value="customer" defaultChecked /> Clientes</label>
        <label className="flex items-center gap-1"><input type="radio" name="funnel" value="affiliate" /> Afiliados</label>
      </fieldset>
      <label className="text-sm font-medium" htmlFor="handles">Perfis</label>
      <textarea id="handles" name="handles" rows={8} className="input font-mono" placeholder={"@loja_exemplo\nhttps://www.instagram.com/outra_loja/"} required />
      <button className="btn btn-primary self-start" disabled={pending}>{pending ? "Importando…" : "Importar"}</button>
      {state.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      {state.message && <p role="status" className="text-sm text-ok">{state.message}</p>}
    </form>
  );
}
