-- Vetclin: chegada "para um veterinário" (opcional).
-- A recepção pode indicar para qual veterinário o paciente veio. Vazio (NULL) = "Qualquer veterinário".
-- Qualquer veterinário continua podendo iniciar o atendimento. Nunca edite este arquivo depois de aplicado.
ALTER TABLE atendimentos ADD COLUMN para_veterinario_id INTEGER REFERENCES usuarios(id);
