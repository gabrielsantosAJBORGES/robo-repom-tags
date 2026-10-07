const { ImapFlow } = require('imapflow');

async function buscarCodigo2FA(emailUser, emailPass, inicioTentativa = null, host = 'imap.titan.email', port = 993) {
  const client = new ImapFlow({
    host: host,
    port: port,
    secure: true,
    auth: {
      user: emailUser,
      pass: emailPass
    },
    logger: false
  });

  console.log(`🔌 Conectando ao servidor IMAP (${host})...`);
  await client.connect();
  console.log('✅ Conexão IMAP estabelecida com sucesso!');

  let lock = await client.getMailboxLock('INBOX');
  let codigo = null;
  const tempoReferencia = inicioTentativa ? new Date(inicioTentativa.getTime() - 20000) : new Date(Date.now() - 120000);

  try {
    console.log('⏳ Monitorando a caixa postal pelo NOVO e-mail da Edenred (esperando até 35s)...');

    for (let rodada = 1; rodada <= 12; rodada++) {
      const mailbox = await client.status('INBOX', { messages: true });
      const total = mailbox.messages;
      const inicio = Math.max(1, total - 4);

      const mensagens = [];
      for await (let msg of client.fetch(`${inicio}:*`, { envelope: true, source: true })) {
        mensagens.push(msg);
      }
      mensagens.reverse();

      for (let msg of mensagens) {
        const de = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
        const assunto = (msg.envelope?.subject || '').toLowerCase();
        const msgData = msg.envelope?.date ? new Date(msg.envelope.date) : new Date();

        if (de.includes('edenred') || de.includes('repom') || assunto.includes('fatores') || assunto.includes('autentica')) {
          // Verifica se o e-mail é da tentativa atual (não é antigo)
          if (msgData >= tempoReferencia) {
            const raw = msg.source.toString('utf8');
            let textoDecodificado = raw;

            const b64Parts = raw.split(/Content-Transfer-Encoding:\s*base64/i);
            if (b64Parts.length > 1) {
              const b64Data = b64Parts[1].split(/--/)[0].replace(/\r?\n/g, '');
              textoDecodificado = Buffer.from(b64Data, 'base64').toString('utf8');
            }

            const match = textoDecodificado.match(/Token de autentica[çc][ãa]o\s+[eé][\s\S]*?(\b\d{6}\b)/i) || 
                          textoDecodificado.match(/C[óo]digo de autentica[çc][ãa]o[\s\S]*?(\b\d{6}\b)/i) ||
                          textoDecodificado.match(/\b\d{6}\b/);

            if (match) {
              codigo = match[1] || match[0];
              console.log(`📧 Novo e-mail recebido em ${msgData.toLocaleTimeString('pt-BR')}!`);
              console.log(`🔑 Código 2FA extraído com sucesso: ${codigo}`);
              return codigo;
            }
          }
        }
      }

      console.log(`... [Tentativa ${rodada}/12] Aguardando a Edenred entregar a nova mensagem...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return codigo;
}

module.exports = { buscarCodigo2FA };
