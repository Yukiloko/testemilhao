import { PageHeader } from "../../components/ui";
import { ImportForm } from "./form";

export default function ImportPage() {
  return (
    <>
      <PageHeader title="Importar leads" description="Cole @ ou links de perfis. Duplicados e perfis na lista de não contato são ignorados." />
      <ImportForm />
    </>
  );
}
