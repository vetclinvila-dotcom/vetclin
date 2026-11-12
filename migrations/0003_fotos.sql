-- Vetclin: passo 3 (chegada de pacientes, tela "Hoje" e fotos).
--  1) tabela de fotos (guardadas no próprio banco, sem R2);
--  2) foto do atendimento e foto do pet (colunas novas "foto_id");
--  3) dados do cancelamento de uma chegada;
--  4) um pet só pode ter UM atendimento aberto por vez;
--  5) índice para listar rápido as chegadas do dia.
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.

-- ---------- 1) Fotos ----------
-- O navegador já reduz a foto (no máx. 1024 px) antes de enviar; limite de 1,5 MB.
CREATE TABLE fotos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dados BLOB NOT NULL,                   -- os bytes da imagem
  tipo TEXT NOT NULL CHECK (tipo IN ('image/jpeg','image/webp')),
  tamanho INTEGER,                       -- em bytes
  largura INTEGER,                       -- opcional
  altura INTEGER,                        -- opcional
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);

-- ---------- 2) Fotos no atendimento e no pet ----------
-- As colunas antigas "foto_chave" (pensadas para o R2) ficam sem uso.
ALTER TABLE atendimentos ADD COLUMN foto_id INTEGER REFERENCES fotos(id);
ALTER TABLE pets ADD COLUMN foto_id INTEGER REFERENCES fotos(id);

-- ---------- 3) Cancelamento de chegada ----------
ALTER TABLE atendimentos ADD COLUMN cancelado_em TEXT;
ALTER TABLE atendimentos ADD COLUMN cancelado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE atendimentos ADD COLUMN motivo_cancelamento TEXT;

-- ---------- 4) Um atendimento aberto por pet ----------
-- "Aberto" = chegou ou em_atendimento. O banco garante isso mesmo se duas
-- pessoas registrarem a chegada ao mesmo tempo.
CREATE UNIQUE INDEX idx_atendimento_aberto_por_pet ON atendimentos (pet_id)
  WHERE status IN ('chegou','em_atendimento');

-- ---------- 5) Lista do dia ----------
CREATE INDEX idx_atendimentos_chegada ON atendimentos (chegada_em);
