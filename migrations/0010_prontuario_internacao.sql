-- Vetclin: prontuário (anotações clínicas) e internação (baias, medicações e doses).
--  1) prontuario: histórico de anotações de cada pet (só veterinário e suporte leem e escrevem);
--  2) baias: as "vagas" da internação (Baia 1, Baia 2…);
--  3) internacoes: quem está (ou esteve) internado e em qual baia;
--  4) internacao_medicacoes: remédios da internação (dose, de quantas em quantas horas, por quantos dias);
--  5) administracoes: cada vez que um remédio foi dado ao paciente.
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.
-- Datas em texto ISO (UTC). Não usamos PRAGMA foreign_keys.

-- ---------- 1) Prontuário ----------
-- Uma anotação pode estar ligada a um atendimento e/ou a uma internação (ou a nenhum dos dois).
-- Só o autor edita, e só até 24 h depois de criar; depois disso a anotação fica só para leitura.
CREATE TABLE prontuario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL REFERENCES pets(id),
  atendimento_id INTEGER REFERENCES atendimentos(id),
  internacao_id INTEGER REFERENCES internacoes(id),
  texto TEXT NOT NULL CHECK (length(texto) <= 10000),
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  editado_em TEXT,
  editado_por INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_prontuario_pet ON prontuario (pet_id, criado_em);
CREATE INDEX idx_prontuario_internacao ON prontuario (internacao_id);
CREATE INDEX idx_prontuario_atendimento ON prontuario (atendimento_id);

-- ---------- 2) Baias ----------
CREATE TABLE baias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  ativa INTEGER NOT NULL DEFAULT 1 CHECK (ativa IN (0,1)),
  criado_em TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_baias_nome ON baias (lower(nome));
INSERT INTO baias (nome, ordem, ativa, criado_em) VALUES
  ('Baia 1', 1, 1, '2026-01-01T00:00:00.000Z'),
  ('Baia 2', 2, 1, '2026-01-01T00:00:00.000Z');

-- ---------- 3) Internações ----------
CREATE TABLE internacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL REFERENCES pets(id),
  atendimento_id INTEGER REFERENCES atendimentos(id),
  baia_id INTEGER NOT NULL REFERENCES baias(id),
  inicio_em TEXT NOT NULL,
  alta_em TEXT,
  motivo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'internado' CHECK (status IN ('internado','alta','obito','transferido')),
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  encerrado_por INTEGER REFERENCES usuarios(id),
  observacao_alta TEXT
);
-- O banco garante: uma baia só tem UM internado, e um pet só está internado UMA vez.
CREATE UNIQUE INDEX idx_internado_por_baia ON internacoes (baia_id) WHERE status = 'internado';
CREATE UNIQUE INDEX idx_internado_por_pet ON internacoes (pet_id) WHERE status = 'internado';
CREATE INDEX idx_internacoes_pet ON internacoes (pet_id);
CREATE INDEX idx_internacoes_status ON internacoes (status);

-- ---------- 4) Medicações da internação ----------
CREATE TABLE internacao_medicacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internacao_id INTEGER NOT NULL REFERENCES internacoes(id),
  remedio TEXT NOT NULL,
  dose TEXT,                                -- ex.: "250 mg"
  via TEXT,                                 -- ex.: "Uso oral"
  quantidade TEXT,                          -- ex.: "1 comprimido", "0,5 ml"
  intervalo_horas REAL NOT NULL CHECK (intervalo_horas >= 0.5 AND intervalo_horas <= 168),
  duracao_dias INTEGER CHECK (duracao_dias IS NULL OR (duracao_dias >= 1 AND duracao_dias <= 365)),
  inicio_em TEXT NOT NULL,
  encerrada_em TEXT,
  encerrada_por INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE INDEX idx_internacao_med_internacao ON internacao_medicacoes (internacao_id);

-- ---------- 5) Doses dadas ----------
CREATE TABLE administracoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medicacao_id INTEGER NOT NULL REFERENCES internacao_medicacoes(id),
  feita_em TEXT NOT NULL,
  feita_por INTEGER NOT NULL REFERENCES usuarios(id),
  observacao TEXT
);
CREATE INDEX idx_administracoes_med ON administracoes (medicacao_id, feita_em);
