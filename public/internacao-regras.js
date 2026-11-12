// Regras de texto (sem tela) da internação. Ficam num arquivo à parte para os testes
// usarem o mesmo código do app. Os horários e o "status" das medicações vêm prontos do servidor.

// 1 -> "1º dia", 3 -> "3º dia"
export const ordinalDia = (n) => `${n}º dia`;

// Minutos -> "20 min", "1 h", "2 h 05 min". (Nunca negativo.)
export function formatarDuracao(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
}

// Horas completas de internação -> "há 5 h", "há 2 dias", "há 2 dias e 3 h".
export function tempoInternado(horas) {
  if (horas < 1) return 'há menos de 1 h';
  if (horas < 24) return `há ${horas} h`;
  const d = Math.floor(horas / 24);
  const h = horas % 24;
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}${h ? ` e ${h} h` : ''}`;
}

// 8 -> "a cada 8 h"; 0.5 -> "a cada 30 min"; 1.5 -> "a cada 1,5 h"
export function textoIntervalo(horas) {
  if (horas < 1) return `a cada ${Math.round(horas * 60)} min`;
  return `a cada ${String(horas).replace('.', ',')} h`;
}

// A "pílula" da próxima medicação.
// Recebe { remedio, status, proxima_em, minutos_ate_proxima } e a função que formata a hora (HH:MM em Bahia).
// Devolve { classe: 'atrasada' | 'agora' | 'futura', texto }.
//   Atrasada: Dipirona há 20 min   |   Agora: Dipirona   |   Próxima 14:00 — Dipirona
export function pilulaProxima(pm, formatarHora) {
  if (pm.status === 'atrasada') return { classe: 'atrasada', texto: `Atrasada: ${pm.remedio} há ${formatarDuracao(-pm.minutos_ate_proxima)}` };
  if (pm.status === 'agora') return { classe: 'agora', texto: `Agora: ${pm.remedio}` };
  return { classe: 'futura', texto: `Próxima ${formatarHora(pm.proxima_em)} — ${pm.remedio}` };
}

// Dentro da tabela de medicações (o nome do remédio já está na linha): "Atrasada há 1 h", "Agora", "14:00 · em 4 h 10 min".
export function textoStatusMedicacao(m, formatarHora) {
  if (m.situacao === 'encerrada') return { classe: 'encerrada', texto: 'Encerrada' };
  if (m.situacao === 'concluida') return { classe: 'encerrada', texto: 'Tratamento concluído' };
  if (m.status === 'atrasada') return { classe: 'atrasada', texto: `Atrasada há ${formatarDuracao(-m.minutos_ate_proxima)}` };
  if (m.status === 'agora') return { classe: 'agora', texto: `Agora · ${formatarHora(m.proxima_em)}` };
  return { classe: 'futura', texto: `${formatarHora(m.proxima_em)} · em ${formatarDuracao(m.minutos_ate_proxima)}` };
}

// Resumo da tela Hoje: "Internados: 2 · 1 medicação atrasada". Sem atrasadas, não fala delas.
export function resumoInternados(resumo) {
  const partes = [`Internados: ${resumo.internados}`];
  const a = resumo.medicacoes_atrasadas ?? 0;
  const n = resumo.medicacoes_agora ?? 0;
  if (a) partes.push(`${a} ${a === 1 ? 'medicação atrasada' : 'medicações atrasadas'}`);
  if (n) partes.push(`${n} ${n === 1 ? 'medicação na hora' : 'medicações na hora'}`);
  return partes.join(' · ');
}

// Hora digitada pela pessoa ("2026-11-10T09:30", de <input type="datetime-local">) no relógio de Bahia -> texto ISO em UTC.
export function inicioBahiaParaISO(valor) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(valor ?? ''))) return null;
  const ms = Date.parse(`${valor}:00-03:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// O contrário: instante ISO -> "2026-11-10T09:30" no relógio de Bahia (para preencher o campo).
export function isoParaCampoBahia(iso) {
  return new Date(Date.parse(iso) - 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
