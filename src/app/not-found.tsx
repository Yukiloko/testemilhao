import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-semibold">Página não encontrada</h1>
      <p className="mt-2 text-sm text-zinc-500">O endereço não existe ou o lead foi removido.</p>
      <Link className="btn mt-4" href="/">Voltar ao painel</Link>
    </div>
  );
}
