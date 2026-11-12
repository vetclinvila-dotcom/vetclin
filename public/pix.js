// Pix "copia e cola" (BR Code) e QR Code do Pix, sem banco e sem internet.
// Segue o "Manual de Padrões para Iniciação do Pix" do Banco Central (QR estático).
// Este arquivo é só JavaScript puro: o app, o servidor e os testes usam o mesmo código.
// Dinheiro sempre em centavos inteiros.

// ---------- CRC16 (a "assinatura" que fecha o código) ----------

// CRC16-CCITT-FALSE: polinômio 0x1021, começa em 0xFFFF, sem inversão. Devolve 4 letras/números em maiúsculas.
export function crc16(texto) {
  let crc = 0xFFFF;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// ---------- Texto do recebedor ----------

export const MAX_NOME_PIX = 25;
export const MAX_CIDADE_PIX = 15;

// Prepara nome/cidade para o Pix: maiúsculas, sem acentos, só A-Z 0-9 espaço . - , ; e corta no tamanho.
// Isso é feito ao SALVAR as configurações (o payloadPix só confere).
export function normalizarTextoPix(texto, max) {
  const t = String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,;-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, max).trim();
}

// ---------- Chave Pix ----------

function digitosCpfValidos(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(d[n])) return false;
  }
  return true;
}

function digitosCnpjValidos(d) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  for (const n of [12, 13]) {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * pesos[i];
    const r = soma % 11;
    const dv = r < 2 ? 0 : 11 - r;
    if (dv !== Number(d[n])) return false;
  }
  return true;
}

export const cpfValido = (texto) => digitosCpfValidos(String(texto ?? '').replace(/\D/g, ''));
export const cnpjValido = (texto) => digitosCnpjValidos(String(texto ?? '').replace(/\D/g, ''));

const RE_EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Confere e padroniza uma chave Pix. Devolve { tipo, chave } ou lança Error com mensagem em português.
// tipo: 'cpf' | 'cnpj' | 'telefone' | 'email' | 'aleatoria'.
// Regra para números: com "(" ou "+" é telefone; com "." ou "/" é CPF/CNPJ; só dígitos:
// 14 = CNPJ; 11 que passa na conta do CPF = CPF; senão 10/11 dígitos de telefone (DDD + número).
export function validarChavePix(entrada) {
  const t = String(entrada ?? '').trim();
  if (!t) throw new Error('Informe a chave Pix.');
  if (t.includes('@')) {
    const email = t.toLowerCase();
    if (email.length > 77 || !RE_EMAIL.test(email)) throw new Error('E-mail da chave Pix inválido.');
    return { tipo: 'email', chave: email };
  }
  const minusculo = t.toLowerCase();
  if (/^[0-9a-f]{8}-/.test(minusculo) || minusculo.length === 36) {
    if (!RE_UUID.test(minusculo)) throw new Error('Chave aleatória inválida. Ela tem 36 caracteres, como 123e4567-e12b-12d1-a456-426655440000.');
    return { tipo: 'aleatoria', chave: minusculo };
  }
  if (!/^[\d\s().+/-]+$/.test(t)) throw new Error('Chave Pix inválida. Use CPF, CNPJ, telefone, e-mail ou chave aleatória.');
  const d = t.replace(/\D/g, '');
  const comoTelefone = () => {
    let n = d;
    if (t.startsWith('+') || ((n.length === 12 || n.length === 13) && n.startsWith('55'))) {
      if (!n.startsWith('55')) throw new Error('Telefone inválido. Use o formato (91) 99999-0000.');
      n = n.slice(2);
    }
    if (!/^[1-9][1-9](9\d{8}|[2-5]\d{7})$/.test(n)) throw new Error('Telefone inválido. Use o formato (91) 99999-0000.');
    return { tipo: 'telefone', chave: '+55' + n };
  };
  if (t.includes('(') || t.startsWith('+')) return comoTelefone();
  if (d.length === 14) {
    if (!digitosCnpjValidos(d)) throw new Error('CNPJ inválido. Confira os números.');
    return { tipo: 'cnpj', chave: d };
  }
  if (d.length === 11) {
    if (digitosCpfValidos(d)) return { tipo: 'cpf', chave: d };
    if (t.includes('.')) throw new Error('CPF inválido. Confira os números.');
    return comoTelefone();
  }
  if (t.includes('.') || t.includes('/')) throw new Error('CPF ou CNPJ inválido. Confira os números.');
  return comoTelefone();
}

// Mostra a chave sem expor tudo: CPF ***.456.789-**, telefone +55 (91) *****-0000, e-mail j***@dominio.com.
export function mascararChave(chave) {
  const c = String(chave ?? '');
  if (/^\d{11}$/.test(c)) return `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**`;
  if (/^\d{14}$/.test(c)) return `**.${c.slice(2, 5)}.${c.slice(5, 8)}/****-**`;
  if (/^\+55\d{10,11}$/.test(c)) { const n = c.slice(3); return `+55 (${n.slice(0, 2)}) *****-${n.slice(-4)}`; }
  if (c.includes('@')) { const [u, dom] = c.split('@'); return `${u.slice(0, 1)}***@${dom}`; }
  if (RE_UUID.test(c)) return `${c.slice(0, 8)}-****-****-****-${c.slice(-4)}`;
  return c ? '****' : '';
}

// ---------- Código Pix (copia e cola) ----------

// Um campo do código: número (2) + tamanho (2, com zero à esquerda) + valor.
function campo(id, valor) {
  if (valor.length > 99) throw new Error(`Campo Pix ${id} muito longo.`);
  return id + String(valor.length).padStart(2, '0') + valor;
}

const ascii = (s) => /^[\x20-\x7E]*$/.test(s);

// 14500 -> "145.00"; 5 -> "0.05".
export function valorParaPix(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos < 0) throw new Error('Valor do Pix inválido.');
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;
}

// Identificador da cobrança: só letras e números (até 25), ou "***" quando não há.
export function txidDoPedido(pedidoId, sequencia) {
  const t = `VC${pedidoId}P${sequencia}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
  return t;
}

// Monta o texto do Pix "copia e cola" (o mesmo que vai dentro do QR Code).
// valorCentavos null/0 = sem valor (quem paga digita). nome e cidade já devem estar normalizados.
export function payloadPix({ chave, nome, cidade, valorCentavos = null, txid = '***' }) {
  if (!chave || !ascii(chave)) throw new Error('Chave Pix inválida.');
  if (!nome || !ascii(nome) || nome.length > MAX_NOME_PIX) throw new Error('Nome do recebedor inválido (até 25 letras, sem acento).');
  if (!cidade || !ascii(cidade) || cidade.length > MAX_CIDADE_PIX) throw new Error('Cidade inválida (até 15 letras, sem acento).');
  const id = txid ?? '***';
  if (id !== '***' && !/^[A-Za-z0-9]{1,25}$/.test(id)) throw new Error('Identificador (txid) inválido: só letras e números, até 25.');
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', chave);
  let p = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986');
  if (valorCentavos) p += campo('54', valorParaPix(valorCentavos));
  p += campo('58', 'BR') + campo('59', nome) + campo('60', cidade) + campo('62', campo('05', id));
  p += '6304';
  return p + crc16(p);
}
