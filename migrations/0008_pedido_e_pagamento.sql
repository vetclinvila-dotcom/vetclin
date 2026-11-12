-- Vetclin: passo 5 (pedido e pagamento).
--  1) pedidos: quem enviou para a recepção e quando; quando foi pago;
--  2) itens_pedido: de onde veio o item (consulta, receita ou digitado à mão);
--  3) pagamentos: foto do comprovante, dinheiro recebido (para o troco) e motivo do estorno;
--  4) um atendimento só pode ter UM pedido que não esteja cancelado;
--  5) índice para listar rápido os pedidos "aguardando pagamento".
-- Nunca edite este arquivo depois de aplicado; crie uma migração nova.
-- Dinheiro em centavos inteiros. Datas em texto ISO (UTC). Não usamos PRAGMA foreign_keys.

-- ---------- 1) Pedidos ----------
ALTER TABLE pedidos ADD COLUMN enviado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE pedidos ADD COLUMN enviado_em TEXT;
ALTER TABLE pedidos ADD COLUMN pago_em TEXT;

-- ---------- 2) Itens ----------
-- 'consulta' = item da consulta (valor pelo horário); 'receita' = produto vindo da receita; 'manual' = o resto.
ALTER TABLE itens_pedido ADD COLUMN origem TEXT NOT NULL DEFAULT 'manual'
  CHECK (origem IN ('consulta','receita','manual'));

-- ---------- 3) Pagamentos ----------
-- Nunca guardamos número de cartão: só a forma e, se quiser, a foto do comprovante.
ALTER TABLE pagamentos ADD COLUMN comprovante_foto_id INTEGER REFERENCES fotos(id);
-- Só para "dinheiro": quanto o cliente entregou (o troco é essa quantia menos o valor).
ALTER TABLE pagamentos ADD COLUMN recebido_dinheiro_centavos INTEGER;
ALTER TABLE pagamentos ADD COLUMN estorno_motivo TEXT;

-- ---------- 4) Um pedido ativo por atendimento ----------
-- Se houver pedidos repetidos (não deveria), os mais novos de cada atendimento são cancelados
-- antes de criar o índice, para a migração nunca falhar.
UPDATE pedidos SET status = 'cancelado', cancelado_em = criado_em, motivo_cancelamento = 'Pedido repetido (ajuste automático da migração 0008)'
 WHERE status <> 'cancelado'
   AND EXISTS (SELECT 1 FROM pedidos o WHERE o.atendimento_id = pedidos.atendimento_id AND o.status <> 'cancelado' AND o.id < pedidos.id);
CREATE UNIQUE INDEX idx_pedido_ativo_por_atendimento ON pedidos (atendimento_id) WHERE status <> 'cancelado';

-- ---------- 5) Lista de pendentes ----------
CREATE INDEX idx_pedidos_status ON pedidos (status);
CREATE INDEX idx_pagamentos_recebido_em ON pagamentos (recebido_em);
