# ManyChat caseiro — respostas automáticas a comentários

Alguém comenta uma palavra-chave numa publicação tua e recebe automaticamente:

- **Instagram** 📸 — resposta pública ao comentário **+ DM** (private reply).
- **Facebook** 📘 — resposta pública ao comentário.

As regras gerem-se num dashboard com senha (`/dashboard`): palavra-chave, tipo
de deteção (contém / exata / começa por), texto da resposta e da DM.

## Como funciona

```
Pessoa comenta "QUERO"  →  Meta envia webhook  →  POST /webhooks/meta
                                                        │
                             match da palavra-chave (SQLite)
                                                        │
                              ├─ resposta pública ao comentário
                              └─ DM ao autor (só Instagram)
```

Regras da Meta a ter em conta:
- **1 private reply por comentário, para sempre** (o dedup interno garante isto).
- Janela de **7 dias** após o comentário para enviar a DM.
- Só DMs a quem **comentou** (pediu) — nada de mensagens em massa.

## Arrancar localmente

```bash
cp .env.example .env   # preenche pelo menos DASHBOARD_PASS e META_VERIFY_TOKEN
npm install
npm run dev            # http://localhost:4300/dashboard
```

## Setup na Meta (app própria, sem App Review)

Para automatizar **as tuas próprias contas**, a app pode ficar em Development
Mode para sempre — sem business verification nem App Review. Passos:

1. Cria a app em [developers.facebook.com](https://developers.facebook.com) →
   tipo *Business* → adiciona os produtos **Instagram** e **Webhooks**.
2. A conta de Instagram tem de ser **Business ou Creator**.
3. No painel da app → Instagram → *API setup with Instagram login* → liga a tua
   conta → **Generate token** → copia o `IG_ACCESS_TOKEN` e o `IG_USER_ID`.
4. Webhook: URL `https://O-TEU-DOMINIO/webhooks/meta`, *Verify token* = o valor
   de `META_VERIFY_TOKEN` no teu .env. Subscreve os campos **`comments`**
   (Instagram) e **`feed`** (Página de Facebook).
5. Facebook: token de Página via *Graph API Explorer* (scopes
   `pages_manage_engagement`, `pages_read_engagement`) → `PAGE_ACCESS_TOKEN` e
   `PAGE_ID`; subscreve a Página à app.
6. Copia o *App Secret* (Definições → Básico) para `META_APP_SECRET`.

Em Development Mode os webhooks só disparam para contas com papel na app
(admin/developer/tester) — ou seja, as tuas.

## Deploy no Render

O `render.yaml` está pronto: sobe o repositório para o GitHub, cria um
*Blueprint* no Render e preenche as variáveis de ambiente no painel. O plano
`starter` tem disco persistente (as regras sobrevivem a deploys); o `free`
adormece e perde os dados a cada deploy.

## Endpoints

| Rota | Auth | Função |
|------|------|--------|
| `GET /webhooks/meta` | verify token | Handshake de verificação da Meta |
| `POST /webhooks/meta` | assinatura HMAC | Recebe eventos de comentários |
| `GET /api/automation` | `x-dash-key` | Estado + regras + últimos eventos |
| `POST /api/automation/rules` | `x-dash-key` | Cria (sem `id`) ou atualiza (com `id`) uma regra |
| `DELETE /api/automation/rules/:id` | `x-dash-key` | Apaga uma regra |
| `GET /dashboard` | senha na página | Interface de gestão |
| `GET /health` | — | Health check (Render) |
