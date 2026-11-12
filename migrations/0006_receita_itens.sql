-- Vetclin: passo 5 (valores dos produtos na receita).
-- Ainda não existe módulo de estoque. Por isso, para cada produto da receita a equipe
-- marca "Temos o produto?" (sim/não) e, se tem, digita o valor. O total entra na conta do atendimento.
-- Os valores são só para a equipe: nunca saem no papel impresso nem aparecem para o cliente.
-- Futuro: o módulo de estoque vai ligar estes itens ao catálogo/estoque (um campo produto_id novo,
-- em outra migração); a "descricao" continua guardando o texto como foi escrito na receita.
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.
-- Dinheiro em centavos inteiros. Datas em texto ISO (UTC). Não usamos PRAGMA foreign_keys.

CREATE TABLE receita_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receita_id INTEGER NOT NULL REFERENCES receitas(id),
  ordem INTEGER NOT NULL DEFAULT 0,                  -- posição na lista (0, 1, 2…)
  descricao TEXT NOT NULL CHECK (length(descricao) <= 300), -- a linha da receita, sem marcas do WhatsApp
  temos INTEGER NOT NULL DEFAULT 0 CHECK (temos IN (0, 1)), -- 1 = a clínica tem o produto; 0 = só recomendação
  quantidade INTEGER NOT NULL DEFAULT 1 CHECK (quantidade BETWEEN 1 AND 999),
  valor_unitario_centavos INTEGER CHECK (valor_unitario_centavos IS NULL OR valor_unitario_centavos BETWEEN 0 AND 10000000),
  atualizado_em TEXT NOT NULL,
  atualizado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_receita_itens_receita ON receita_itens (receita_id);
