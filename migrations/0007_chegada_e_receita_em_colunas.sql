-- Vetclin: passo 6 (receita em colunas).
--  1) receitas.linhas_json: os remédios da receita como lista (remédio, dose, como dar, intervalo, duração).
--     O campo "texto" continua sendo gerado a partir dessas linhas, então impressão, prévias e
--     sugestões funcionam como sempre. Vazio (NULL) = receita escrita como texto livre (modo "Colar texto").
--  2) sugestoes_receita.tipo: 'linha' (linha inteira da receita) ou 'remedio' (só nome + dose,
--     usado para sugerir no campo "Remédio").
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.

ALTER TABLE receitas ADD COLUMN linhas_json TEXT;
ALTER TABLE sugestoes_receita ADD COLUMN tipo TEXT NOT NULL DEFAULT 'linha';
