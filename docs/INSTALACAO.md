# Instalação do sistema Vetclin (passo a passo)

Este guia é para quem não programa. São 5 passos, feitos uma vez só, todos pelo navegador.
Tempo estimado: 20 a 30 minutos.

Ao final, o sistema vai estar no ar num endereço como `https://vetclin.SEU-NOME.workers.dev`,
e toda atualização enviada ao GitHub será publicada sozinha.

---

## Passo 1 — Criar a conta da Cloudflare (no nome da clínica)

1. Abra <https://dash.cloudflare.com/sign-up>.
2. Use o **e-mail da clínica** e crie uma senha forte. Guarde essa senha num lugar seguro.
3. Confirme o e-mail (a Cloudflare manda um link).
4. Não precisa cadastrar cartão. O plano gratuito é suficiente para começar.

> Por que no nome da clínica? Para o sistema não depender de nenhuma pessoa específica.

---

## Passo 2 — Criar o banco de dados

1. No painel da Cloudflare, no menu da esquerda, clique em **Storage & Databases** → **D1 SQL Database**.
2. Clique em **Create** (Criar).
3. Em **Name**, digite exatamente: `vetclin`
4. Em **Location** (localização), escolha **South America** se aparecer; se não, deixe o padrão.
5. Clique em **Create**.
6. Na tela do banco, copie o **Database ID** (um código parecido com `a1b2c3d4-...`). Você vai usar no próximo passo.

---

## Passo 3 — Colocar o ID do banco no projeto

1. Abra o repositório no GitHub: <https://github.com/vetclinvila-dotcom/vetclin>
2. Clique no arquivo **`wrangler.jsonc`**.
3. Clique no ícone de lápis (**Edit this file**), no canto direito.
4. Procure o texto `COLE_AQUI_O_ID_DO_BANCO` e troque pelo Database ID que você copiou.
   Mantenha as aspas. Exemplo: `"database_id": "a1b2c3d4-...",`
5. Clique em **Commit changes...** e depois em **Commit changes** de novo.

> O ID do banco não é segredo: sem a senha da conta da Cloudflare, ninguém consegue usá-lo.

---

## Passo 4 — Ligar o GitHub à Cloudflare (publicação automática)

1. No painel da Cloudflare, clique em **Workers & Pages** → **Create** (Criar).
2. Escolha **Import a repository** (Importar um repositório) e clique em **Connect GitHub**.
3. Faça login no GitHub com a conta `vetclinvila-dotcom` e permita o acesso ao repositório **vetclin**.
4. Selecione o repositório **vetclin**.
5. Na tela de configuração:
   - **Project name**: `vetclin`
   - **Build command**: deixe **vazio**
   - **Deploy command**: copie e cole exatamente:
     ```
     npx wrangler d1 migrations apply vetclin --remote && npx wrangler deploy
     ```
     (a primeira parte atualiza o banco de dados; a segunda publica o sistema)
6. Clique em **Create and deploy** (Criar e publicar).
7. Espere 1 a 3 minutos. Quando aparecer **Success**, o sistema está no ar.
   O endereço aparece na tela (algo como `https://vetclin.SEU-NOME.workers.dev`).

**Se der erro na publicação** (mensagem vermelha com "d1" ou "migrations"):
me mande uma foto ou cópia da mensagem. Em geral é só uma permissão a mais que precisa ser ligada.

---

## Passo 5 — Criar a chave de configuração e o primeiro usuário

A chave de configuração é uma senha de uso único que permite criar o **primeiro** usuário
(o administrador). Depois disso, ela não serve para mais nada.

1. No painel da Cloudflare: **Workers & Pages** → **vetclin** → **Settings** (Configurações)
   → **Variables and Secrets** (Variáveis e segredos).
2. Clique em **Add** (Adicionar):
   - **Type**: `Secret`
   - **Variable name**: `CHAVE_CONFIGURACAO`
   - **Value**: invente uma frase longa, por exemplo `cachorro-azul-pula-muro-2026`
3. Clique em **Deploy** (ou **Save and deploy**).
4. Abra o endereço do sistema no navegador. Vai aparecer a tela **Configuração inicial**.
5. Preencha: a chave que você inventou, o nome, o login e a senha do primeiro veterinário
   (por exemplo, a Dra. Elizabeth). Ele será o administrador.
6. Pronto. Agora, logado como administrador, vá em **Usuários** e crie os outros logins
   (Dr. Felipe e a recepção). Cada pessoa tem o seu.

---

## Instalar o app no iPhone dos veterinários

(As notificações chegam na etapa 4, mas já dá para instalar agora.)

1. No iPhone, abra o endereço do sistema no **Safari** (precisa ser o Safari).
2. Toque no botão **Compartilhar** (quadrado com seta para cima).
3. Role e toque em **Adicionar à Tela de Início**. Toque em **Adicionar**.
4. A partir de agora, abra sempre pelo ícone **Vetclin** na tela inicial.

Requisito: iPhone com iOS 16.4 ou mais novo (Ajustes → Geral → Sobre → Versão do iOS).

---

## Atualizações futuras

Você não precisa fazer nada: cada vez que um código novo for enviado ao GitHub,
a Cloudflare publica sozinha em 1 a 3 minutos. Para acompanhar, veja
**Workers & Pages** → **vetclin** → **Deployments**.
