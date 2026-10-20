"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold">Algo deu errado</h1>
      <p className="mt-2 text-sm text-zinc-500">{error.message || "Erro inesperado ao carregar esta página."}</p>
      <button className="btn mt-4" onClick={reset}>Tentar novamente</button>
    </div>
  );
}
