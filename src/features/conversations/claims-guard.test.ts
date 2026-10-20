import { describe, expect, it } from "vitest";
import { testConfig } from "@/test/helpers";
import { checkClaims } from "./claims-guard";
import { isExplicitOptOut } from "./engine";

describe("claims guard", () => {
  it("allows verified claims and known links", () => {
    expect(checkClaims("Oi! Aqui é sem mensalidade e tem recebimento em 1 dia útil no plano D+1. https://wa.me/5511999999999?text=oi", testConfig)).toEqual({ ok: true });
  });

  it("blocks unverified claims even paraphrased", () => {
    const r = checkClaims("A gente tem a menor taxa do mercado pra lojistas!", testConfig);
    expect(r.ok).toBe(false);
  });

  it("blocks invented figures, guarantees, impersonation and unknown links", () => {
    for (const text of ["Taxa de 0,99% no débito", "Aprovação garantida em 5 minutos", "Sou cliente e recomendo", "Veja em https://golpe.example", "Taxa de 2% https://wa.me/5511999999999"]) {
      expect(checkClaims(text, testConfig).ok, text).toBe(false);
    }
  });
});

describe("opt-out safety net", () => {
  it("catches explicit requests to stop without flagging ordinary text", () => {
    expect(isExplicitOptOut("Por favor, não me mande mais mensagens")).toBe(true);
    expect(isExplicitOptOut("NÃO TENHO INTERESSE")).toBe(true);
    expect(isExplicitOptOut("Chega amanhã a mercadoria, me fala mais")).toBe(false);
  });
});
