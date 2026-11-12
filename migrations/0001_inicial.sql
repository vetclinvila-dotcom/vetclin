-- Vetclin: esquema inicial do banco (fase 1).
-- Regras gerais:
--  * Dinheiro sempre em CENTAVOS (número inteiro). R$ 100,00 = 10000.
--  * Datas em texto ISO no horário UTC (ex.: 2026-11-11T15:30:00.000Z).
--  * Não usamos PRAGMA foreign_keys (o D1 não permite em migrações).

-- Usuários do sistema (recepção e veterinários).
CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,            -- sempre minúsculo
  senha_hash TEXT NOT NULL,              -- nunca a senha em si
  papel TEXT NOT NULL CHECK (papel IN ('recepcao','veterinario')),
  admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0,1)),
  crmv TEXT,                             -- registro do veterinário (opcional)
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Sessões de login. O id é o SHA-256 do token; o token em si nunca é guardado.
CREATE TABLE sessoes (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  criada_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  ultimo_uso_em TEXT NOT NULL,
  agente TEXT                            -- navegador/aparelho usado
);
CREATE INDEX idx_sessoes_usuario ON sessoes (usuario_id);

-- Tentativas de login (para bloquear quem erra a senha muitas vezes).
CREATE TABLE tentativas_login (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT,
  ip TEXT,
  sucesso INTEGER NOT NULL CHECK (sucesso IN (0,1)),
  em TEXT NOT NULL
);
CREATE INDEX idx_tentativas_login_em ON tentativas_login (login, em);
CREATE INDEX idx_tentativas_ip_em ON tentativas_login (ip, em);

-- Tutores (donos dos animais).
CREATE TABLE tutores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,           -- formato T-000001
  nome TEXT NOT NULL,
  whatsapp TEXT,                         -- formato E.164, ex.: +5571999998888
  observacoes TEXT,
  origem TEXT NOT NULL CHECK (origem IN ('recepcao','veterinario','whatsapp','tablet')),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  mesclado_em_id INTEGER REFERENCES tutores(id)  -- preenchido se for cadastro duplicado unido a outro
);
CREATE INDEX idx_tutores_whatsapp ON tutores (whatsapp);
CREATE INDEX idx_tutores_nome ON tutores (nome);

-- Pets (animais).
CREATE TABLE pets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,           -- formato P-000001
  tutor_id INTEGER NOT NULL REFERENCES tutores(id),
  nome TEXT NOT NULL,
  especie TEXT NOT NULL,
  raca TEXT,
  raca_confirmada INTEGER NOT NULL DEFAULT 0 CHECK (raca_confirmada IN (0,1)),
  nascimento_aprox TEXT,
  idade_anos INTEGER,
  idade_meses INTEGER,
  sexo TEXT,
  foto_chave TEXT,                       -- chave da foto no R2
  observacoes TEXT,
  origem TEXT NOT NULL CHECK (origem IN ('recepcao','veterinario','whatsapp','tablet')),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1))
);
CREATE INDEX idx_pets_tutor ON pets (tutor_id);
CREATE INDEX idx_pets_nome ON pets (nome);

-- Atendimentos (cada chegada do pet à clínica).
CREATE TABLE atendimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL REFERENCES pets(id),
  chegada_em TEXT NOT NULL,
  peso_kg REAL,
  peso_origem TEXT CHECK (peso_origem IN ('balanca_recepcao','veterinario')),
  peso_registrado_por INTEGER REFERENCES usuarios(id),
  motivo TEXT,
  urgente INTEGER NOT NULL DEFAULT 0 CHECK (urgente IN (0,1)),
  foto_chave TEXT,
  status TEXT NOT NULL DEFAULT 'chegou'
    CHECK (status IN ('chegou','em_atendimento','finalizado','cancelado')),
  veterinario_id INTEGER REFERENCES usuarios(id),
  iniciado_em TEXT,
  finalizado_em TEXT,
  registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX idx_atendimentos_status_chegada ON atendimentos (status, chegada_em);
CREATE INDEX idx_atendimentos_pet ON atendimentos (pet_id);

-- Catálogo de serviços e produtos com preços (em centavos).
CREATE TABLE catalogo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('consulta','exame','vacina','procedimento','produto','outro')),
  preco_centavos INTEGER NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
  ia_pode_informar INTEGER NOT NULL DEFAULT 0 CHECK (ia_pode_informar IN (0,1)),
  aparece_no_site INTEGER NOT NULL DEFAULT 0 CHECK (aparece_no_site IN (0,1)),
  exige_receita INTEGER NOT NULL DEFAULT 0 CHECK (exige_receita IN (0,1)),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
INSERT INTO catalogo (nome, categoria, preco_centavos, criado_em, atualizado_em) VALUES
  ('Consulta (até o horário de corte)', 'consulta', 10000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('Consulta (após o horário de corte)', 'consulta', 20000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

-- Pedidos (a "conta" de um atendimento).
CREATE TABLE pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  atendimento_id INTEGER NOT NULL REFERENCES atendimentos(id),
  status TEXT NOT NULL DEFAULT 'aberto'
    CHECK (status IN ('aberto','aguardando_pagamento','pago','cancelado')),
  onde_cobrar TEXT CHECK (onde_cobrar IN ('recepcao','consultorio')),
  total_centavos INTEGER NOT NULL DEFAULT 0,
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  cancelado_por INTEGER REFERENCES usuarios(id),
  cancelado_em TEXT,
  motivo_cancelamento TEXT
);
CREATE INDEX idx_pedidos_atendimento ON pedidos (atendimento_id);

-- Itens de cada pedido. O preço é copiado no momento da venda.
CREATE TABLE itens_pedido (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  catalogo_id INTEGER REFERENCES catalogo(id),
  descricao TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1,
  preco_unitario_centavos INTEGER NOT NULL
);
CREATE INDEX idx_itens_pedido ON itens_pedido (pedido_id);

-- Pagamentos recebidos. Nunca guardamos número de cartão.
CREATE TABLE pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  forma TEXT NOT NULL CHECK (forma IN ('pix','cartao','dinheiro')),
  valor_centavos INTEGER NOT NULL,
  recebido_por INTEGER NOT NULL REFERENCES usuarios(id),
  recebido_em TEXT NOT NULL,
  comprovante_chave TEXT,
  transacao_id TEXT,
  estornado INTEGER NOT NULL DEFAULT 0 CHECK (estornado IN (0,1)),
  estornado_por INTEGER REFERENCES usuarios(id),
  estornado_em TEXT
);
CREATE INDEX idx_pagamentos_pedido ON pagamentos (pedido_id);

-- Inscrições para avisos no celular (notificações push).
CREATE TABLE inscricoes_push (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  ultimo_uso_em TEXT
);

-- Registro de ações: quem fez o quê e quando (nunca guarda senhas).
CREATE TABLE registro_acoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  acao TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id INTEGER,
  antes TEXT,                            -- JSON
  depois TEXT,                           -- JSON
  em TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX idx_registro_entidade ON registro_acoes (entidade, entidade_id);

-- Contadores para gerar códigos T-000001 / P-000001 sem repetir.
CREATE TABLE contadores (
  nome TEXT PRIMARY KEY,
  valor INTEGER NOT NULL
);
INSERT INTO contadores (nome, valor) VALUES ('tutor', 0), ('pet', 0);
