# Planilha financeira e cópia de segurança (Google)

Este guia mostra como ligar o Vetclin ao **Google Drive da clínica** para ter, sem trabalho manual:

- uma **planilha** "Vetclin — Financeiro" com todos os pagamentos (e um resumo por dia), atualizada sozinha a cada 15 minutos;
- uma **cópia de segurança diária** de todos os dados do sistema (e das fotos), guardada no Drive;
- os **comprovantes** (fotos de maquininha/Pix) arrumados em pastas por mês.

**Importante:** o sistema é quem manda. A planilha é só uma **cópia para conferência**: se alguém mudar algo na planilha, **nada muda no sistema** (e na próxima atualização a linha volta ao que o sistema diz). Para corrigir um pagamento, faça no sistema.

Você precisa de: ser **administrador** no Vetclin e acesso à conta Google da clínica. Leva uns 10 minutos, uma vez só.

---

## 1) No sistema: gerar a chave de acesso

1. Entre no Vetclin como administrador e abra **Usuários**.
2. Role até o quadro **Integração com Google (planilha e cópia de segurança)**.
3. Toque em **Gerar chave de acesso**.
4. Toque em **Copiar**. **Guarde agora**: a chave não aparece de novo. (Cole em um bloco de notas por enquanto.)

Sobre a chave:
- Ela só consegue **ler** dados. Não consegue alterar nada nem entrar no sistema.
- Tratem como senha: quem tem a chave consegue baixar os dados da clínica. Não mande por WhatsApp para estranhos nem publique.
- Se perder, ou se achar que vazou: volte aqui e toque em **Gerar outra chave** (a anterior para de funcionar na hora) ou em **Desativar chave**.

## 2) No Google Drive da clínica: criar a planilha e colar o programa

1. Abra o Google Drive da clínica. Clique em **Novo → Planilhas Google → Planilha em branco**.
2. Dê o nome **Vetclin — Financeiro**.
3. Na planilha, clique em **Extensões → Apps Script**. Abre uma página de programação (não se assuste).
4. Apague tudo o que estiver escrito na caixa (selecione tudo e delete).
5. Abra o arquivo do programa: <https://github.com/vetclinvila-dotcom/vetclin/blob/main/apps-script/Vetclin.gs>. Clique em **Raw**, selecione tudo (`Ctrl+A`), copie (`Ctrl+C`) e **cole** na página do Apps Script.
6. Clique no ícone de **disquete (Salvar projeto)**. Se pedir um nome para o projeto, escreva "Vetclin".

## 3) Voltar à planilha e ligar tudo

1. Volte para a aba da planilha e **recarregue a página** (tecla `F5`). Depois de alguns segundos aparece o menu **Vetclin** no alto.
2. Clique em **Vetclin → Configurar (endereço e chave)**.
   - Endereço: o endereço do sistema, no formato `https://vetclin....workers.dev` (o mesmo que vocês usam no navegador).
   - Chave: cole a chave que você copiou no passo 1.
   - Se aparecer **"Tudo certo"**, deu certo. Se aparecer **"Chave inválida — gere outra no sistema"**, volte ao passo 1.
3. Clique em **Vetclin → Instalar atualizações automáticas**.
4. O Google vai pedir **permissões** (ler/gravar a planilha, usar o Drive e acessar um endereço externo). Isso é normal: o programa é seu, na sua conta.
   - Escolha a conta Google da clínica.
   - Vai aparecer **"O Google não verificou este app"**. É esperado, porque o programa é só da clínica e não foi publicado para o público.
   - Clique em **Avançado** e depois em **Acessar Vetclin (não seguro)**, e então em **Permitir**.
5. Se o Google só pedir a permissão agora, clique de novo em **Vetclin → Instalar atualizações automáticas**. A mensagem final é **"Pronto"**.
6. Para ver funcionando já: **Vetclin → Atualizar planilha agora** e, depois, **Vetclin → Fazer cópia de segurança agora**.

## 4) Como conferir que está funcionando

- **Planilha:** a aba **Pagamentos** tem uma linha por pagamento (data, hora, pet, tutor, procedimentos, forma, valor, quem recebeu, situação e link do comprovante). A aba **Resumo** mostra, por dia, o total em Pix, Cartão e Dinheiro, e o total do mês atual. Pagamentos **desfeitos (estornados)** aparecem como "Estornado — motivo" e **não entram nas somas**.
- **Última atualização:** no alto da aba **Resumo** (célula E1) aparece a data/hora da última atualização, ou o aviso de erro (por exemplo **"Chave inválida — gere outra no sistema"**: gere uma chave nova no sistema e repita o passo 3.2).
- **Drive:** deve existir a pasta **Vetclin** com:
  - **Comprovantes / AAAA-MM** — as fotos dos comprovantes (só você, dono da conta, enxerga; elas não ficam públicas);
  - **Backups** — um arquivo `vetclin-backup-AAAA-MM-DD.json` por dia (os **30 mais novos** são guardados; os mais antigos vão para a lixeira do Drive);
  - **Backups / Fotos** — cópia de todas as fotos do sistema (`foto-000123.jpg`).
- A planilha pode ter alguns minutos de atraso (atualiza a cada 15 minutos). Para atualizar na hora: **Vetclin → Atualizar planilha agora**.

Cuidados:
- Não apague as colunas **ID do pagamento** e **ID da foto** (estão escondidas): é por elas que o programa sabe qual linha atualizar.
- Não apague a pasta **Vetclin** do Drive nem mexa na lixeira sem necessidade.
- A conta Google que instalou precisa continuar existindo (se mudar de conta, refaça os passos 2 e 3 na conta nova).

---

## 5) Se o sistema perder dados: como restaurar

São **duas linhas de defesa**. Tente na ordem.

### Primeira opção (a mais fácil): "Time Travel" da Cloudflare

O banco de dados da Cloudflare (D1) guarda o histórico e permite **voltar o banco a qualquer minuto dos últimos dias** (cerca de 30 dias no plano pago e 7 no gratuito). Não precisa de arquivo nenhum.

1. Entre em <https://dash.cloudflare.com> → **Storage & Databases** (ou **Workers & Pages**) → **D1** → banco **vetclin**.
2. Abra a aba **Time Travel** e escolha o **minuto** anterior ao problema.
3. Siga as instruções da tela para restaurar. (Se preferir, peça ajuda a quem cuida do sistema.)

### Segunda opção: o arquivo de cópia de segurança (JSON)

Use se o Time Travel não resolver (por exemplo, o problema foi descoberto tarde demais ou o banco foi apagado). Isto precisa de um computador com **Node.js 22** e o código do sistema (a pasta do repositório); peça ajuda a quem instalou o Vetclin.

1. No Google Drive, abra **Vetclin → Backups** e baixe o arquivo mais recente que esteja bom, por exemplo `vetclin-backup-2026-11-12.json`.
2. Na pasta do sistema, converta a cópia em um arquivo de comandos:

   ```
   node scripts/restaurar-backup.mjs vetclin-backup-2026-11-12.json saida.sql
   ```

   O programa mostra na tela uma **senha temporária para cada usuário** (as senhas de verdade nunca vão para a cópia de segurança). **Anote-as.**
3. Crie um banco **novo e vazio** (não use o antigo) e ligue o sistema a ele:

   ```
   npx wrangler d1 create vetclin-restaurado
   ```

   Coloque o novo banco no arquivo `wrangler.jsonc` (o nome e o `database_id` que o comando mostrou), e aplique as migrações:

   ```
   npx wrangler d1 migrations apply vetclin-restaurado --remote
   ```
4. Aplique os dados no banco novo:

   ```
   npx wrangler d1 execute vetclin-restaurado --remote --file=saida.sql
   ```

   (Se o banco novo tiver outro nome, troque `vetclin-restaurado` pelo nome dele. Se for reaproveitar o nome `vetclin`, o banco tem de estar **vazio**, só com as migrações.)
5. Publique o sistema (`npx wrangler deploy`) e entre com cada login e a **senha temporária**. **Cada pessoa deve trocar a senha** (administrador: Usuários → Editar → Nova senha).
6. Gere uma **nova chave** em Usuários → Integração com Google e refaça o passo 3.2 da planilha (a chave antiga não vem na cópia).
7. Apague o arquivo `saida.sql` (ele tem as senhas temporárias em forma de código).

O que a cópia traz: usuários (sem senha), tutores, pets, atendimentos, contas, pagamentos, receitas, catálogo/preços, configurações, registro de ações e o cadastro das fotos.
O que **não** vem: senhas, sessões de login, aparelhos com notificação ligada (ligue de novo em Notificações) e o **conteúdo** das fotos. As imagens das fotos estão salvas no Drive, em **Vetclin → Backups → Fotos** (`foto-<número>.jpg`, o número é o ID da foto no sistema).

> Atenção: depois de restaurar pelo arquivo, as fotos aparecem como "vazias" no sistema até que as imagens sejam recolocadas a partir da pasta Fotos do Drive. Peça ajuda técnica para isso.

---

## Para quem mantém o sistema (resumo técnico)

- Rotas somente leitura em `GET /api/integracao/*` com `Authorization: Bearer <chave>`: `pagamentos?desde=`, `foto/:id` (só comprovantes), `backup`, `fotos-backup?desde_id=`.
- A chave é de 32 bytes aleatórios; no banco só fica o SHA-256 (`configuracoes.integracao_token_hash`). Mais de 20 erros em 15 minutos do mesmo IP = bloqueio temporário (429).
- Programa do Google: `apps-script/Vetclin.gs`. Restauração: `scripts/restaurar-backup.mjs`. Testes: `tests/integracao.test.js` e `tests/apps-script.test.js` (`npm test`).
