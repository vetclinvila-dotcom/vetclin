-- Vetclin: passo 2 (cadastro de tutores e pets).
--  1) novo papel "suporte" para usuários;
--  2) colunas de busca (sem acento, minúsculas) e WhatsApp só com dígitos.
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.

-- ---------- 1) Papel "suporte" ----------
-- O SQLite não deixa alterar a regra (CHECK) de uma coluna, então
-- recriamos a tabela. Passos: guardar uma cópia dos usuários, apagar a
-- tabela, criar de novo com a regra nova e devolver os dados.
-- "defer_foreign_keys" adia a conferência das chaves estrangeiras até o fim
-- da migração, para as tabelas que apontam para usuarios(id) (sessões,
-- pedidos etc.) não darem erro enquanto a tabela está sendo refeita.
-- Importante: os usuários são devolvidos DEPOIS de recriar a tabela com o
-- mesmo nome; assim o SQLite percebe que as referências voltaram a existir.
PRAGMA defer_foreign_keys = true;

CREATE TABLE usuarios_copia AS SELECT * FROM usuarios;

DROP TABLE usuarios;

CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,            -- sempre minúsculo
  senha_hash TEXT NOT NULL,              -- nunca a senha em si
  papel TEXT NOT NULL CHECK (papel IN ('recepcao','veterinario','suporte')),
  admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0,1)),
  crmv TEXT,                             -- registro do veterinário (opcional)
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

INSERT INTO usuarios (id, nome, login, senha_hash, papel, admin, crmv, ativo, criado_em, atualizado_em)
  SELECT id, nome, login, senha_hash, papel, admin, crmv, ativo, criado_em, atualizado_em FROM usuarios_copia;

DROP TABLE usuarios_copia;
-- (O índice único do login já vem junto com a definição da tabela.)

-- ---------- 2) Colunas de busca ----------
ALTER TABLE tutores ADD COLUMN nome_busca TEXT;
ALTER TABLE tutores ADD COLUMN whatsapp_digitos TEXT;   -- ex.: 5571999998888
ALTER TABLE pets ADD COLUMN nome_busca TEXT;

-- Preenche as linhas que já existirem (o aplicativo corrige os acentos
-- na próxima edição; hoje ainda não há tutores nem pets em produção).
UPDATE tutores SET
  nome_busca = lower(trim(nome)),
  whatsapp_digitos = replace(replace(COALESCE(whatsapp, ''), '+', ''), ' ', '');
UPDATE pets SET nome_busca = lower(trim(nome));

CREATE INDEX idx_tutores_nome_busca ON tutores (nome_busca);
CREATE INDEX idx_tutores_whatsapp_digitos ON tutores (whatsapp_digitos);
CREATE INDEX idx_pets_nome_busca ON pets (nome_busca);
