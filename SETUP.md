# Manual do operador

Este guia leva você do zero até o sistema operando sozinho na sua máquina. Tudo roda local: o banco, a sessão do Instagram e as chaves ficam com você.

## 1. Pré-requisitos

- Node.js 24 LTS (mínimo 22.12) e pnpm (`corepack enable`)
- Google Chrome instalado
- Uma conta da OpenAI com crédito
- (Para a fase de conversa) um app na Meta com a API de mensagens do Instagram aprovada

```bash
pnpm install
cp .env.example .env
cp config/business.example.json config/business.json
```

## 2. Dados do negócio — `config/business.json`

Troque cada `{{PLACEHOLDER}}`. O sistema não sobe enquanto sobrar algum.

- `verifiedClaims`: **só** o que você consegue provar hoje. É a única coisa que a IA pode afirmar.
- `unverifiedClaims`: o que você quer dizer mas ainda não provou. Fica bloqueado — a IA não menciona nem parafraseado, e um filtro automático barra a mensagem se escapar.
- `icpKeywords` e `affiliateTopics` viram as hashtags da descoberta automática.

O arquivo está no `.gitignore`. Nunca commite.

## 3. Chave da OpenAI

1. Acesse `https://platform.openai.com/api-keys` e faça login.
2. Em **Settings → Billing**, adicione crédito (sem crédito a API responde `429 insufficient_quota`).
3. Em **Settings → Limits**, defina um **hard limit mensal** (ex.: USD 50). Esse é o freio de verdade se algo entrar em loop.
4. Crie um **projeto separado** (não use o `Default`) e gere a chave com permissão **Restricted**, apenas `Model capabilities: Write`.
5. Copie a chave na hora (ela aparece uma única vez) e cole em `OPENAI_API_KEY` no `.env`.
6. Defina `OPENAI_MONTHLY_BUDGET_USD` um pouco abaixo do hard limit. Ao atingir esse valor o sistema **pausa sozinho**.
7. Use nomes de modelo **com data** em `OPENAI_MODEL` e `OPENAI_MODEL_FAST` e confira os preços por 1M de tokens nas variáveis `*_USD_PER_1M` — eles alimentam o custo por lead no painel.

**A chave vazou?** Revogue em `https://platform.openai.com/api-keys` e gere outra. Revogar resolve; reescrever o histórico do Git é secundário.

## 4. Chrome com perfil dedicado

Use um perfil **só para o agente**, separado do seu. Assim o agente nunca vê suas abas, seu Chrome normal continua livre, e o Chrome 136+ exige isso de qualquer forma (ele recusa depuração no perfil padrão).

**macOS**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PWD/.chrome-profile"
```

**Linux**

```bash
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$PWD/.chrome-profile"
```

**Windows (PowerShell)**

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-debugging-address=127.0.0.1 `
  --user-data-dir="$PWD\.chrome-profile"
```

Na janela que abrir, entre em `instagram.com`, faça login e resolva o 2FA **uma única vez**. A sessão fica salva no perfil.

Teste a conexão:

```bash
curl -s http://127.0.0.1:9222/json/version
```

> ⚠️ **Segurança:** a porta de depuração dá **controle total** sobre a sessão logada nesse perfil. Mantenha em `127.0.0.1`, **nunca** `0.0.0.0`, e não rode em máquina compartilhada. A pasta `.chrome-profile/` guarda seus cookies do Instagram — ela está no `.gitignore` e não deve sair da sua máquina.

Como o agente usa o Chrome:

- abre uma **aba própria**, nunca usa as suas, nunca traz a janela para frente e fecha a aba ao terminar (inclusive em erro);
- só navega no domínio do Instagram;
- uma tarefa de navegador por vez;
- se o Chrome não estiver aberto, ele **não** abre outro: pausa a fila do navegador e mostra o alerta "Chrome indisponível" no painel. Quando você reabrir o Chrome, a fila volta sozinha.

## 5. API oficial do Instagram (webhook)

A primeira mensagem sai pelo navegador porque a API da Meta não abre conversa com quem nunca falou com você. Quando o lead responde, a conversa passa para a API oficial.

1. No app da Meta, configure o webhook do Instagram apontando para `https://SEU-ENDERECO/api/webhooks/instagram` (para testar local, use um túnel como `cloudflared` ou `ngrok`).
2. Use o mesmo valor de `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` no app e no `.env`.
3. Assine o campo `messages`.
4. Preencha `INSTAGRAM_APP_SECRET`, `INSTAGRAM_PAGE_ACCESS_TOKEN` e `INSTAGRAM_BUSINESS_ACCOUNT_ID`.

Regras que o sistema segue sozinho:

- responde pela API **apenas** dentro da janela de 24 h após a última mensagem do lead;
- janela expirada, API sem permissão ou webhook fora do ar → **não** tenta pelo navegador; registra na fila de exceções para você;
- depois que o lead responde, o navegador fica **proibido** de escrever naquela conversa;
- se você mesmo escrever na conversa pelo celular, o sistema percebe (eco do webhook) e passa a conversa para revisão humana.

Sem a API configurada o sistema continua prospectando; as respostas vão para a fila de exceções.

## 6. Rodar

Gere uma chave de criptografia para os artefatos de falha (screenshots de DMs são dados pessoais e ficam criptografados):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# cole em APP_ENCRYPTION_KEY no .env
```

Suba painel e worker com **um comando**:

```bash
pnpm dev          # desenvolvimento
# ou
pnpm build && pnpm start   # produção local
```

O painel fica em `http://localhost:3000`.

## 7. Liberar envios — em três níveis

O envio real começa **desligado** (`BROWSER_SEND_ENABLED=false`). O painel mostra "Envio real desativado" e as DMs ficam na fila.

1. **Simulação** (já feita no desenvolvimento): `pnpm test` e `pnpm e2e` rodam tudo contra um Instagram simulado.
2. **Dry-run real**, com o envio final bloqueado — abre o perfil, digita a mensagem e apaga sem enviar:
   ```bash
   pnpm browser:dry-run @um_perfil_seu
   ```
3. **Smoke test real e limitado**, só com sua autorização explícita — envia **uma** DM, de preferência para uma segunda conta sua:
   ```bash
   pnpm browser:smoke @sua_conta_teste "Oi, teste do sistema" --confirm
   ```

Depois disso, coloque `BROWSER_SEND_ENABLED=true` no `.env` e reinicie. Comece com o aquecimento automático (5 DMs/dia na 1ª semana, +5 por semana, até o máximo configurado).

## 8. Operação do dia a dia

- **Pausa geral:** botão vermelho no topo de qualquer tela. Retome no mesmo lugar.
- **Pausas automáticas:** alerta/restrição do Instagram, sessão perdida, muitos erros do navegador, possível mensagem duplicada, pico de pedidos de remoção, divergência navegador/API/CRM, IA gerando afirmações bloqueadas, orçamento da OpenAI estourado. O motivo aparece no topo e em **Alertas**.
- **Exceções:** tudo que precisa de você — por exemplo "entrega incerta" (o navegador pode ter enviado antes de cair). Abra o lead, confira o direct e clique em "Foi entregue" ou "Não foi entregue".
- **Revisão humana:** quando a IA não tem segurança, a conversa fica com você. Responda pelo Instagram e, se quiser, clique em "Devolver para a automação".
- **Não contatar:** pedido de parar é atendido na hora e é permanente, para qualquer campanha e canal. Você também pode marcar manualmente.
- **Cadastro / cliente ativo / volume:** marque na ficha do lead. Para clientes indicados por afiliados, informe o @ do afiliado — quando o cliente fica ativo, o afiliado sobe para "Gerou cliente".
- **Experimentos:** crie em **Experimentos**. Uma variável por vez; o sistema só declara vencedor após a amostra mínima e com significância estatística, aumenta o tráfego da vencedora aos poucos e mantém uma fatia explorando. Qualquer mudança automática pode ser **revertida** na mesma tela.
- **Limites:** em **Configurações**. Há tetos fixos que nem você nem a IA ultrapassam (60 DMs/dia, mínimo de 60 s entre DMs).

## 9. Backup e restauração

Backup automático diário em `BACKUP_DIR` (mantém os 14 mais recentes). Manual:

```bash
pnpm db:backup
```

Restaurar (pare o sistema antes):

```bash
pnpm db:restore                 # o mais recente
pnpm db:restore app-2027-01-01T00-00-00-000Z.db
```

A restauração confere a integridade do arquivo antes de sobrescrever o banco.

## 10. Se algo der errado

| Sintoma | O que fazer |
|---|---|
| "Chrome indisponível" | Abra o Chrome com o comando da seção 4 e confira o `curl`. A fila volta sozinha. |
| "Sessão do Instagram perdida" | Entre no Instagram de novo pela janela do perfil dedicado e clique em "Retomar operação". |
| "Instagram exibiu alerta ou restrição" | Não retome no mesmo dia. Reduza `DMs por dia` em Configurações antes de voltar. |
| "Orçamento mensal atingido" | Aumente `OPENAI_MONTHLY_BUDGET_USD` (e o hard limit na OpenAI) ou espere o mês virar. |
| Job em dead-letter | Veja o erro em **Fila de jobs** e use "Reenfileirar" depois de corrigir a causa. |
| A chave vazou | Revogue em `platform.openai.com/api-keys`, gere outra e troque no `.env`. |
