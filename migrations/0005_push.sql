-- Vetclin: passo 4 (notificações no celular).
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.

-- Chaves de identidade do servidor para as notificações (VAPID).
-- São criadas automaticamente na primeira vez que alguém ativa as notificações.
-- Só existe uma linha (id = 1).
-- "contato" é o endereço do sistema (exigido pela Apple para identificar quem envia).
CREATE TABLE push_chaves (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  publica TEXT NOT NULL,
  privada_jwk TEXT NOT NULL,
  contato TEXT,
  criado_em TEXT NOT NULL
);

-- A tabela inscricoes_push (aparelhos que aceitaram notificações) já existe
-- desde a migração 0001. Aqui só guardamos de qual aparelho/navegador veio,
-- para mostrar na tela ("iPhone", "Computador").
ALTER TABLE inscricoes_push ADD COLUMN agente TEXT;
CREATE INDEX idx_inscricoes_push_usuario ON inscricoes_push (usuario_id);
