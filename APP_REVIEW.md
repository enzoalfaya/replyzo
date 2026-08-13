# App Review — Replyzo 2.0 (Instagram)

App: **Replyzo 2.0** (ID `1656283862097843`) · Instagram app ID `1768926984263788`
Conta: **@chefmargaridacosta** · Página FB: **Margarida Costa**

Permissões a submeter:
1. `instagram_business_manage_comments`
2. `instagram_business_manage_messages`

---

## 1. PRÉ-REQUISITOS (verificar ANTES de submeter)

- [ ] App em **Live** (interruptor no topo = Ativo)
- [ ] **Privacy Policy URL** (Configurações → Básico): `https://manychat-proprio.onrender.com/privacy`
- [ ] **User Data Deletion** (Configurações → Básico): `https://manychat-proprio.onrender.com/data-deletion`
- [ ] **Ícone** da app + **categoria** + **email de contacto** preenchidos
- [ ] Negócio **verificado** ligado à app (✅ já feito)
- [ ] Conta de teste (para comentar no vídeo) adicionada como **Instagram Tester** (Funções) e convite **aceite**

> Sem Privacy Policy acessível e app em Live, a Meta reprova sem sequer testar.

---

## 2. DESCRIÇÕES (colar no formulário — em inglês, é o que a Meta revê melhor)

### instagram_business_manage_comments

```
Replyzo is a self-serve engagement tool used by the business that owns the
connected Instagram professional account (the recipe brand "Margarida Costa",
@chefmargaridacosta). The business administrator connects their OWN Instagram
account through Instagram Business Login and explicitly grants this permission.

How we use instagram_business_manage_comments:
1. We subscribe to the "comments" webhook to be notified when someone comments
   on the business's own media.
2. We read the comment text to match keywords the business owner configured in
   our dashboard (for example "tomate").
3. When a comment matches, we publicly reply to that same comment on the
   business's own post with a short, relevant message the owner wrote
   (for example "Enviei-te por mensagem privada!").

All actions happen ONLY on the Instagram account the business admin connected
and authorized. We never access comments on accounts we do not manage. The
feature lets the business respond to its own followers automatically and
consistently.
```

### instagram_business_manage_messages

```
We use instagram_business_manage_messages to send a one-time private reply (DM)
to a person who commented a configured keyword on the connected business's own
Instagram post.

Flow:
1. A follower comments a keyword (e.g. "tomate") on the business's post.
2. Our app sends that follower the content they requested (e.g. a recipe link
   the business owner configured), using Instagram's private-reply-to-comment,
   within Instagram's 7-day / one-reply-per-comment policy.

This is the standard "comment-to-DM" interaction, initiated by the user's own
comment, on the business's own account, with the business admin's consent. We
do NOT send unsolicited messages and we do NOT message users who did not
interact with the business first.
```

---

## 3. INSTRUÇÕES PARA O REVISOR (colar no campo de "test instructions")

```
Test setup: the Instagram professional account @chefmargaridacosta is connected
to the app. A keyword rule ("tomate" -> public reply + DM) is configured in the
Replyzo dashboard.

Steps to reproduce:
1. Open any post on @chefmargaridacosta.
2. From a different Instagram account, comment the word: tomate
3. Within a few seconds the app will:
   a. Post a public reply to your comment on the post.
   b. Send you a private reply (DM) with the configured link.
4. A full recording of this exact flow is attached as the screencast, including
   the Instagram Business Login consent screen where the permissions are granted.
```

---

## 4. GUIÃO DO VÍDEO (screencast) — o mais importante

Grava **um vídeo** (1–3 min) mostrando, por esta ordem:

1. **Consentimento** — o ecrã de **Instagram Business Login** onde @chefmargaridacosta
   concede `instagram_business_basic`, `instagram_business_manage_comments`,
   `instagram_business_manage_messages`. **A Meta QUER ver este ecrã.**
2. **Configuração** — o dashboard do Replyzo com a regra de palavra-chave
   (keyword "tomate" → resposta pública + DM).
3. **Ação** — numa publicação da @chefmargaridacosta, com **outra conta**
   (a que é Instagram Tester), comenta **"tomate"**.
4. **Resultado 1** — mostra a **resposta pública** a aparecer no comentário.
5. **Resultado 2** — abre as mensagens dessa outra conta e mostra a **DM recebida**.
6. **Registo** — volta ao dashboard e mostra o **evento registado**.

Dica: narração ou legendas curtas **em inglês** a dizer o que está a acontecer em cada passo.

---

## 5. ERROS QUE FAZEM REPROVAR (evitar)

- Não mostrar o **ecrã de consentimento** (login) no vídeo. ← causa nº1
- Vídeo que não mostra a permissão a ser **usada de verdade** (comentário → resposta → DM).
- Privacy Policy inacessível ou genérica.
- App **não** em Live.
- Descrição vaga ("para gerir comentários") sem explicar o fluxo concreto.
- Pedir permissões que não usas (pede **só** estas duas).

---

## 6. DEPOIS DE SUBMETER

- Análise costuma levar **de alguns dias a ~2 semanas**.
- Tudo o resto já está montado (tokens, webhooks, subscrições, servidor) → **quando aprovarem, começa a funcionar sozinho**.
- Se reprovarem, a Meta diz o motivo → ajustamos e voltamos a submeter (normal ao 1º/2º try).
