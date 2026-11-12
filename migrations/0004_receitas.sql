-- Vetclin: passo 4 (receita rápida).
--  1) receitas (rascunho -> liberada -> impressa -> entregue, ou cancelada);
--  2) sugestões de linhas de receita (aprendidas das receitas liberadas);
--  3) configurações da clínica (nome, endereço etc., usados no papel impresso).
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.
-- Datas em texto ISO (UTC). Não usamos PRAGMA foreign_keys.

-- ---------- 0) WhatsApp dos usuários ----------
-- Usado para abrir o WhatsApp do colega com o pedido de receita (formato E.164).
ALTER TABLE usuarios ADD COLUMN whatsapp TEXT;

-- ---------- 1) Receitas ----------
CREATE TABLE receitas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL REFERENCES pets(id),
  atendimento_id INTEGER REFERENCES atendimentos(id),
  veterinario_id INTEGER REFERENCES usuarios(id),   -- quem assina; preenchido ao liberar
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  texto TEXT NOT NULL DEFAULT '',                    -- corpo da receita (até 10000 letras)
  orientacoes TEXT,                                  -- cuidados para o tutor (até 5000 letras)
  status TEXT NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho','liberada','impressa','entregue','cancelada')),
  versao INTEGER NOT NULL DEFAULT 1,
  receita_anterior_id INTEGER REFERENCES receitas(id), -- receita que esta versão corrige
  -- 'veterinario' = escrita no sistema; 'transcrita' = a recepção digitou/colou o texto
  -- recebido pelo WhatsApp (já nasce liberada; o veterinário assina no papel).
  origem TEXT NOT NULL DEFAULT 'veterinario' CHECK (origem IN ('veterinario','transcrita')),
  -- Pedido a outro veterinário ("escreve essa receita para mim").
  solicitada_a INTEGER REFERENCES usuarios(id),
  solicitada_por INTEGER REFERENCES usuarios(id),
  nota_pedido TEXT,
  liberada_em TEXT,
  impressa_em TEXT,
  impressa_por INTEGER REFERENCES usuarios(id),
  vezes_impressa INTEGER NOT NULL DEFAULT 0,
  entregue_em TEXT,
  entregue_por INTEGER REFERENCES usuarios(id),
  cancelada_em TEXT,
  cancelada_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX idx_receitas_status ON receitas (status);
CREATE INDEX idx_receitas_pet ON receitas (pet_id);
CREATE INDEX idx_receitas_solicitada ON receitas (solicitada_a, status);

-- ---------- 2) Sugestões de linhas ----------
-- Cada linha de uma receita liberada vira (ou reforça) uma sugestão.
-- Mais tarde o módulo de estoque/produtos poderá se juntar a esta tabela
-- (ex.: sugerir também os medicamentos cadastrados).
CREATE TABLE sugestoes_receita (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  texto TEXT NOT NULL,                  -- a linha como foi escrita
  texto_busca TEXT NOT NULL UNIQUE,     -- sem acento, minúsculas, sem asteriscos
  vezes INTEGER NOT NULL DEFAULT 1,
  ultimo_uso TEXT
);

-- ---------- 3) Configurações ----------
CREATE TABLE configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT,
  atualizado_em TEXT,
  atualizado_por INTEGER REFERENCES usuarios(id)
);
INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ('clinica_nome', 'Vetclin', '2026-01-01T00:00:00.000Z');
