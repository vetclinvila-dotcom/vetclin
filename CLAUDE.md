# Guia para sessões de IA — Vetclin

Sistema de gestão da clínica veterinária Vetclin (Brasil). O dono **não é programador**.

Arquitetura completa: https://claude.ai/artifact/5d7L6tMdxg14vsgtR9FMCB

## Tecnologia
- Cloudflare **Workers** + **Static Assets** (pasta `public/`) + **D1** (SQLite).
- **Zero dependências** npm. JavaScript puro (módulos ES), só APIs web (fetch, crypto.subtle, URL). Sem TypeScript, sem build, sem frameworks.
- Publicação: `npx wrangler deploy`. Migrações do banco em `migrations/` (nunca editar uma migração já aplicada; criar uma nova).
- Rotas `/api/*` passam pelo Worker (`src/index.js`); o resto é servido direto de `public/`.

## Regras
- **Comentários, textos da interface e documentação em português do Brasil**, em linguagem simples, explicando o que cada parte faz.
- **Dinheiro sempre em centavos inteiros** (R$ 100,00 = 10000).
- **Fuso da clínica: America/Bahia (UTC-03:00, sem horário de verão).** Guardar datas como texto ISO em UTC; converter só na exibição.
- Nunca guardar número de cartão. Nunca commitar dados reais de clientes nem segredos (chaves, senhas, tokens). Dados de teste são sempre inventados.
- Nunca gravar senhas ou hashes no `registro_acoes`. Toda ação que altera dados deve ser registrada lá.
- Chamadas que alteram dados exigem o cabeçalho `X-Requested-With: vetclin` (proteção CSRF).
- Futuro: preços de exames nunca são expostos à IA nem ao site público.
- Na tela, nunca inserir texto do usuário com `innerHTML`; usar `textContent`.

## Testes
- `npm test` (usa `node:test` e `node:sqlite`, Node 22+). O adaptador `tests/d1-local.js` imita o D1 e aplica as migrações.
- Todo código novo da API deve vir com testes. `wrangler` não é necessário para testar.
