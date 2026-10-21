const fs = require('fs');
const readline = require('readline');
const RepomClient = require('./repom_client');

// =========================================================================
// CONFIGURAÇÕES
// =========================================================================
const CONFIG = {
  REPOM_USER: process.env.REPOM_USER || 'gabriel.ajborges', // <-- Login correto do print
  REPOM_PASS: process.env.REPOM_PASS || 'Gabriel1$',        // <-- Senha informada

  // URL do Web App gerado no Google Apps Script para ler as 97 placas e salvar o resultado
  APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL || '',

  // Intervalo entre consultas (em ms)
  DELAY_MS: 200
};

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Lista fallback com as 97 placas já identificadas para hoje e amanhã
const PLACAS_HOJE_AMANHA = [
  "IPO1C08", "OAQ7D41", "FJW7F31", "EIP2323", "FCF1A67", "GDN8D94", "QNY4F81", "DVS3B21", "AZC9H64",
  "EPU6B39", "FMT5H07", "MKH7B24", "RWA8A24", "TKO5C54", "QXB2I48", "FEI2670", "EJY6C97", "EUW6D09",
  "DDL7A15", "OZS7C19", "FNZ1D68", "PNK2F11", "BCA8H00", "EJZ5A54", "FSF1C66", "MKV5J46", "DYY2H50",
  "FWX7H48", "FDB7E79", "FTN1A76", "GCV3A02", "GAS1I45", "SMH4G93", "DBL9H81", "EGK8J94", "ESU9C64",
  "RUG8E82", "MWZ4B01", "MME4E57", "EJQ7B73", "PRY9054", "RCN9E58", "CUE3E23", "RKV4J69", "QCQ2I50",
  "KQX7C21", "OBC7A50", "IYJ0E00", "OZH7C25", "FXS0B08", "HHK6A34", "MWQ6B36", "FCZ0D42", "CNR8B95",
  "PVK6C69", "QUT6A73", "EKH2A33", "IQS6G33", "PUQ4E30", "GAX5G56", "UDA4H79", "MTG2270", "OPM2E47",
  "QGR9H88", "ESN1886", "MKJ8H90", "BWN0450", "HMV3818", "QRH9G52", "RNX2B48", "FYF1I78", "HFE3C59",
  "DCH0E63", "GCV2B55", "SUL6C23", "JAA5E54", "SVK2H89", "FOL3E75", "DBM7J51", "FPF7962", "FCJ6G26",
  "QNA4A70", "EFO0H90", "CUD7C29", "FTZ1D50", "IZO0J42", "EFO0C99", "DBM4B61", "JAE9H93", "DVT7F89",
  "RZE3J89", "NGW9H74", "MIQ6D40", "PRL0E27", "NRZ0E32", "EGK8B22", "EFU4I90"
];

async function obterPlacas() {
  if (CONFIG.APPS_SCRIPT_URL) {
    try {
      console.log('📥 Buscando placas filtradas via Web App do Google Sheets...');
      const r = await fetch(CONFIG.APPS_SCRIPT_URL);
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        console.log(`📋 Total de ${data.length} placas obtidas dinamicamente da planilha.`);
        return data;
      }
    } catch (e) {
      console.log('⚠️ Erro ao buscar via Apps Script, usando lista local:', e.message);
    }
  }
  return PLACAS_HOJE_AMANHA;
}

function formatarLinhaResultado(placa, tags) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  
  let tagAtiva = null;
  if (Array.isArray(tags) && tags.length > 0) {
    // 1º Prioriza status explicitamente Ativa
    tagAtiva = tags.find(t => {
      const st = String(t.StatusTag || '').trim().toUpperCase();
      return st === 'ATIVA' || st === 'ATIVO';
    });

    // 2º Se não achou, pega uma com número que não seja cancelada/inativa/bloqueada
    if (!tagAtiva) {
      tagAtiva = tags.find(t => {
        const num = String(t.NumeroTag || '').trim();
        const st = String(t.StatusTag || '').trim().toUpperCase();
        const isInativa = (st === 'INATIVA' || st === 'INATIVO' || st === 'CANCELADA' || st === 'BLOQUEADA');
        return num !== '' && !isInativa;
      });
    }
  }

  if (tagAtiva) {
    return [
      hoje,
      placa,
      (tagAtiva.NomeTag || '').replace(/^Tag\s+/i, '').trim(),
      'SIM',
      tagAtiva.NumeroTag || '-',
      tagAtiva.StatusTag || 'Ativa'
    ];
  } else {
    return [
      hoje,
      placa,
      '-',
      'NÃO',
      '-',
      'SEM TAG'
    ];
  }
}
async function main() {
  console.log('========================================================');
  console.log('   ROBÔ DE CONSULTA DE TAGS REPOM (COM SUPORTE A 2FA)  ');
  console.log('========================================================\n');

  let user = CONFIG.REPOM_USER;
  let pass = CONFIG.REPOM_PASS;

  if (!user) user = await prompt('Digite seu Usuário / CPF da Repom: ');
  if (!pass) pass = await prompt('Digite sua Senha da Repom: ');

  const client = new RepomClient();

  // Autenticação (reaproveita sessão salva se existir; se não, loga e pede o 2FA do e-mail)
  await client.login(user, pass);

  // Obtém placas
  const placas = await obterPlacas();
  console.log(`\n🔍 Consultando ${placas.length} placas na Repom...\n`);

  const resultados = [];
  const hoje = new Date().toLocaleDateString('pt-BR');

  for (let i = 0; i < placas.length; i++) {
    const placa = placas[i];
    process.stdout.write(`[${i + 1}/${placas.length}] ${placa}... `);

    try {
      const tags = await client.consultarPlaca(placa);
      const linha = formatarLinhaResultado(placa, tags);
      resultados.push(linha);
      console.log(`✅ ${linha[2]} | TAG: ${linha[3]} | Nº: ${linha[4]} | Status: ${linha[5]}`);
    } catch (err) {
      console.log(`❌ Erro: ${err.message}`);
      resultados.push([hoje, placa, 'ERRO', 'NÃO', '-', 'FALHA']);
    }

    if (CONFIG.DELAY_MS > 0 && i < placas.length - 1) {
      await delay(CONFIG.DELAY_MS);
    }
  }

  // 1. Salva em CSV local
  const csvContent = [
    'Data/Hora,Placa,Operadora,TAG,Número,Status',
    ...resultados.map(r => r.map(c => `"${c}"`).join(','))
  ].join('\n');
  fs.writeFileSync('resultado_consulta_tags.csv', csvContent, 'utf8');
  console.log('\n💾 Resultados salvos localmente em: resultado_consulta_tags.csv');

  // 2. Se a URL do Google Apps Script estiver configurada, grava direto na planilha
  if (CONFIG.APPS_SCRIPT_URL) {
    try {
      console.log('📤 Enviando resultados para a aba CONSULTA TAGS da planilha...');
      await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resultados)
      });
      console.log('✅ Planilha Google atualizada com sucesso!');
    } catch (e) {
      console.error('⚠️ Falha ao enviar para o Google Sheets:', e.message);
    }
  }

  console.log('\n🏁 Processo 100% finalizado!');
}

main().catch(err => {
  console.error('\n❌ Erro:', err.message);
  process.exit(1);
});
