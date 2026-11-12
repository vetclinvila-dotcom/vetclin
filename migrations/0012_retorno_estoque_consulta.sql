-- Vetclin: retorno, estoque com validade e fluxo "Iniciar consulta".
--  1) atendimentos.tipo: 'consulta' ou 'retorno' (paciente que volta, mesmo que ainda não esteja no sistema);
--     atendimentos.peso_em: hora em que o peso foi anotado;
--  2) catalogo.papel_fixo: marca os 3 itens de consulta que o sistema usa sozinho
--     (consulta_dia, consulta_noite, retorno). Antes eram "as duas primeiras linhas de consulta";
--     a migração marca essas duas e cria o item "Retorno" (preço 0, só administradores mudam);
--  3) catalogo: apresentacao (ex.: "250 mg · caixa com 10 comprimidos"), controla_estoque e unidade;
--  4) estoque_lotes e estoque_movimentos (entradas, saídas automáticas ao pagar, ajustes e estornos);
--  5) receita_itens: do_carrinho/catalogo_id, para produtos que já estão na conta pelo carrinho
--     não serem cobrados duas vezes.
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.
-- Dinheiro em centavos inteiros. Datas em texto ISO (UTC); validade é só a data (AAAA-MM-DD).

-- ---------- 1) Retorno ----------
ALTER TABLE atendimentos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'consulta' CHECK (tipo IN ('consulta','retorno'));
ALTER TABLE atendimentos ADD COLUMN peso_em TEXT;
UPDATE atendimentos SET peso_em = chegada_em WHERE peso_kg IS NOT NULL;

-- ---------- 2) Itens fixos da consulta ----------
ALTER TABLE catalogo ADD COLUMN papel_fixo TEXT CHECK (papel_fixo IS NULL OR papel_fixo IN ('consulta_dia','consulta_noite','retorno'));
UPDATE catalogo SET papel_fixo = 'consulta_dia'
 WHERE id = (SELECT id FROM catalogo WHERE categoria = 'consulta' ORDER BY id LIMIT 1);
UPDATE catalogo SET papel_fixo = 'consulta_noite'
 WHERE id = (SELECT id FROM catalogo WHERE categoria = 'consulta' ORDER BY id LIMIT 1 OFFSET 1);
-- Se a clínica já tinha criado um item "Retorno" na categoria consulta, ele é aproveitado (e reativado).
UPDATE catalogo SET papel_fixo = 'retorno', ativo = 1
 WHERE id = (SELECT id FROM catalogo WHERE categoria = 'consulta' AND papel_fixo IS NULL AND lower(trim(nome)) = 'retorno' ORDER BY id LIMIT 1);
INSERT INTO catalogo (nome, categoria, preco_centavos, papel_fixo, ativo, criado_em, atualizado_em)
SELECT 'Retorno', 'consulta', 0, 'retorno', 1, '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z'
 WHERE NOT EXISTS (SELECT 1 FROM catalogo WHERE papel_fixo = 'retorno');
CREATE UNIQUE INDEX idx_catalogo_papel_fixo ON catalogo (papel_fixo) WHERE papel_fixo IS NOT NULL;

-- ---------- 3) Produtos com apresentação e controle de estoque ----------
ALTER TABLE catalogo ADD COLUMN apresentacao TEXT;
ALTER TABLE catalogo ADD COLUMN controla_estoque INTEGER NOT NULL DEFAULT 0 CHECK (controla_estoque IN (0,1));
ALTER TABLE catalogo ADD COLUMN unidade TEXT NOT NULL DEFAULT 'un';

-- ---------- 4) Estoque ----------
-- Cada entrada de produto é um LOTE (com a validade dele). A baixa usa primeiro o lote que vence antes.
CREATE TABLE estoque_lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalogo_id INTEGER NOT NULL REFERENCES catalogo(id),
  quantidade_inicial REAL NOT NULL CHECK (quantidade_inicial > 0),
  quantidade_atual REAL NOT NULL CHECK (quantidade_atual >= 0),
  validade TEXT,                                   -- AAAA-MM-DD; vazio = sem validade
  custo_unitario_centavos INTEGER CHECK (custo_unitario_centavos IS NULL OR custo_unitario_centavos >= 0),
  observacao TEXT,
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_estoque_lotes_catalogo ON estoque_lotes (catalogo_id, validade);

-- Histórico de tudo que mexeu no estoque. "quantidade" tem sinal: entrada +, saída -, ajuste +/-, estorno +.
-- sem_estoque = 1: a saída aconteceu sem ter produto no estoque (lote_id vazio); revertido = 1: o estorno já devolveu.
CREATE TABLE estoque_movimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalogo_id INTEGER NOT NULL REFERENCES catalogo(id),
  lote_id INTEGER REFERENCES estoque_lotes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','saida','ajuste','estorno')),
  quantidade REAL NOT NULL,
  motivo TEXT,
  sem_estoque INTEGER NOT NULL DEFAULT 0 CHECK (sem_estoque IN (0,1)),
  revertido INTEGER NOT NULL DEFAULT 0 CHECK (revertido IN (0,1)),
  pedido_id INTEGER REFERENCES pedidos(id),
  item_pedido_id INTEGER,                          -- sem chave estrangeira: os itens da conta são trocados ao editar
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_estoque_mov_catalogo ON estoque_movimentos (catalogo_id, criado_em);
CREATE INDEX idx_estoque_mov_pedido ON estoque_movimentos (pedido_id);
-- Nunca baixar duas vezes o mesmo item da conta do mesmo lote (proteção contra duas pessoas ao mesmo tempo).
CREATE UNIQUE INDEX idx_estoque_saida_unica ON estoque_movimentos (item_pedido_id, COALESCE(lote_id, 0))
  WHERE tipo = 'saida' AND revertido = 0 AND item_pedido_id IS NOT NULL;

-- ---------- 5) Produtos da receita que já estão na conta pelo carrinho ----------
ALTER TABLE receita_itens ADD COLUMN do_carrinho INTEGER NOT NULL DEFAULT 0 CHECK (do_carrinho IN (0,1));
ALTER TABLE receita_itens ADD COLUMN catalogo_id INTEGER REFERENCES catalogo(id);
