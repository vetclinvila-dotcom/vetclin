-- Vetclin: quem marcou que o paciente entrou no consultório.
-- A recepção também pode marcar o início do atendimento (informando o veterinário). Guardamos quem apertou o botão;
-- se for diferente do veterinário, a tela mostra "(marcado pela recepção)". Vazio (NULL) = atendimentos antigos.
-- Nunca edite este arquivo depois de aplicado.
ALTER TABLE atendimentos ADD COLUMN iniciado_por INTEGER REFERENCES usuarios(id);
