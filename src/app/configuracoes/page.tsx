import { getSettings, HARD_LIMITS } from "@/features/safety/settings";
import { PageHeader } from "../components/ui";
import { LimitsForm } from "./form";

export default function SettingsPage() {
  const s = getSettings();
  return (
    <>
      <PageHeader title="Configurações e limites" description={`Os limites valem para o operador e para a IA. Teto fixo: ${HARD_LIMITS.maxDmsPerDay} DMs/dia e no mínimo ${HARD_LIMITS.minSecondsBetweenDms}s entre DMs.`} />
      <LimitsForm settings={s} />
      <p className="mt-4 max-w-2xl text-xs text-zinc-500">
        Fuso de operação: {s.operatingTimezone} (definido no .env). Aquecimento iniciado em: {s.warmupStartedAt ? new Date(s.warmupStartedAt).toLocaleDateString("pt-BR") : "ainda não iniciado"}.
      </p>
    </>
  );
}
