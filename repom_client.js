const fs = require('fs');
const readline = require('readline');
const { buscarCodigo2FA } = require('./leitor_email_imap');

class RepomClient {
  constructor(sessionFile = 'sessao_repom.json') {
    this.sessionFile = sessionFile;
    this.cookies = new Map();
    this.carregarCookiesSecret();
    this.carregarSessao();
  }

  carregarCookiesSecret() {
    const rawCookie = process.env.REPOM_SESSION_COOKIE;
    if (rawCookie) {
      rawCookie.split(';').forEach(c => {
        const parts = c.split('=');
        if (parts.length >= 2) {
          this.cookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
      });
      console.log('🔑 Cookies carregados diretamente do REPOM_SESSION_COOKIE (GitHub Secrets)!');
    }
  }

  carregarSessao() {
    if (fs.existsSync(this.sessionFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          this.cookies.set(k, v);
        }
        console.log('📂 Sessão anterior carregada do disco.');
      } catch (e) {
        console.log('⚠️ Falha ao ler sessão salva, iniciando nova.');
      }
    }
  }

  salvarSessao() {
    const obj = Object.fromEntries(this.cookies.entries());
    fs.writeFileSync(this.sessionFile, JSON.stringify(obj, null, 2), 'utf8');
  }

  saveCookies(headers) {
    if (headers && headers.getSetCookie) {
      headers.getSetCookie().forEach(c => {
        const parts = c.split(';')[0].split('=');
        if (parts.length >= 2) {
          this.cookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
      });
    }
  }

  getCookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async fetchWithCookies(url, options = {}, tentativas = 3) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      ...(options.headers || {})
    };

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers['cookie'] = cookieHeader;
    }

    for (let i = 1; i <= tentativas; i++) {
      try {
        const res = await fetch(url, { ...options, headers });
        this.saveCookies(res.headers);
        return res;
      } catch (err) {
        console.log(`⚠️ Tentativa ${i}/${tentativas} falhou ao conectar em ${url} (${err.message}).`);
        if (i === tentativas) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  promptTerminal(texto) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(texto, ans => {
      rl.close();
      resolve(ans.trim());
    }));
  }

  async estaLogado() {
    if (this.cookies.size === 0) return false;
    try {
      const res = await this.fetchWithCookies('https://www.repom.com.br/Repom.Frete.Web/ConsultaTag/ConsultaTagPedagio', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/javascript, */*; q=0.01',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest'
        },
        body: 'placa=IPO1C08'
      }, 1);
      if (res && res.status === 200) {
        const text = await res.text();
        return !text.startsWith('<');
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async login(username, password) {
    console.log('Verificando se há sessão ativa salva...');
    const jaLogado = await this.estaLogado();
    if (jaLogado) {
      console.log('🚀 SESSÃO ATIVA CONFIRMADA! Entrando direto na consulta de tags (SEM LOGIN / SEM 2FA).');
      return;
    }

    console.log('Sessão expirou ou não encontrada. Iniciando login no portal da Repom...');
    let currUrl = 'https://www.repom.com.br/Repom.Frete.Web/';
    let lastHtml = '';

    for (let i = 0; i < 6; i++) {
      const res = await this.fetchWithCookies(currUrl, { redirect: 'manual' });
      const loc = res.headers.get('location');
      if (!loc) {
        lastHtml = await res.text();
        break;
      }
      currUrl = new URL(loc, currUrl).href;
    }

    const tokenMatch = lastHtml.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
    const returnUrlMatch = lastHtml.match(/name="ReturnUrl" value="([^"]+)"/);

    if (!tokenMatch || !returnUrlMatch) {
      throw new Error('Não foi possível localizar os parâmetros de login.');
    }

    const token = tokenMatch[1];
    const returnUrl = returnUrlMatch[1].replace(/&amp;/g, '&');

    console.log('Enviando credenciais...');
    const loginParams = new URLSearchParams({
      Username: username,
      Password: password,
      ReturnUrl: returnUrl,
      RememberLogin: 'true',
      button: 'login',
      __RequestVerificationToken: token
    });

    const loginRes = await this.fetchWithCookies(currUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: loginParams.toString()
    });

    let redirectAfterLogin = loginRes.headers.get('location');
    if (!redirectAfterLogin) {
      throw new Error('Falha no login: verifique seu usuário e senha.');
    }

    let nextUrl = new URL(redirectAfterLogin, currUrl).href;

    if (nextUrl.includes('LoginWith2fa')) {
      console.log('\n🔒 2FA acionado pela Repom!');
      const res2fa = await this.fetchWithCookies(nextUrl, { redirect: 'manual' });
      const html2fa = await res2fa.text();

      const codeInputMatch = html2fa.match(/<input[^>]+name="([^"]*code[^"]*)"/i) || html2fa.match(/<input[^>]+type="text"[^>]+name="([^"]+)"/i);
      const codeInputName = codeInputMatch ? codeInputMatch[1] : 'TwoFactorCode';

      const token2faMatch = html2fa.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
      const returnUrl2faMatch = html2fa.match(/name="ReturnUrl" value="([^"]+)"/);
      const token2fa = token2faMatch ? token2faMatch[1] : token;
      const returnUrl2fa = returnUrl2faMatch ? returnUrl2faMatch[1].replace(/&amp;/g, '&') : returnUrl;

      const inicioTentativa = new Date();
      let codigo2fa = null;
      try {
        const emailUser = process.env.EMAIL_USER || 'gabriel.santos@ajborges.com';
        const emailPass = process.env.EMAIL_PASS || 'Gabriel321!';
        codigo2fa = await buscarCodigo2FA(emailUser, emailPass, inicioTentativa);
        console.log(`🤖 [AGENTE 2FA] Código capturado: ${codigo2fa}`);
      } catch (eImap) {
        console.log('⚠️ Leitura IMAP falhou:', eImap.message);
      }

      if (!codigo2fa) {
        codigo2fa = await this.promptTerminal('👉 Digite o código de 6 dígitos: ');
      }

      const params2fa = new URLSearchParams();
      params2fa.append('RememberMe', 'True');
      params2fa.append('Provider', 'E-mail');
      params2fa.append('ReturnUrl', returnUrl2fa);
      params2fa.append('TwoFactorCode', codigo2fa.replace(/\s+/g, ''));
      params2fa.append('RememberMachine', 'true');
      params2fa.append('__RequestVerificationToken', token2fa);

      const form2faActionMatch = html2fa.match(/<form[^>]+action="([^"]*)"/i);
      const postTargetUrl = form2faActionMatch && form2faActionMatch[1] ? new URL(form2faActionMatch[1].replace(/&amp;/g, '&'), nextUrl).href : nextUrl;

      const submit2faRes = await this.fetchWithCookies(postTargetUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params2fa.toString()
      });

      let redirectPos2fa = submit2faRes.headers.get('location');
      const res2faText = await submit2faRes.text();

      if (!redirectPos2fa) {
        const metaMatch = res2faText.match(/data-url="([^"]+)"/i) || res2faText.match(/url=([^"'>\s]+)/i);
        if (metaMatch) {
          redirectPos2fa = metaMatch[1].replace(/&amp;/g, '&');
        }
      }

      if (!redirectPos2fa || redirectPos2fa.includes('LoginWith2fa')) {
        throw new Error('Falha no 2FA da Repom.');
      }

      nextUrl = new URL(redirectPos2fa, postTargetUrl).href;
    }

    // Handshake OpenID
    const callbackRes = await this.fetchWithCookies(nextUrl, { redirect: 'manual' });
    const callbackHtml = await callbackRes.text();

    const formActionMatch = callbackHtml.match(/<form[^>]+action="([^"]+)"/i);
    const codeMatch = callbackHtml.match(/name="code" value="([^"]+)"/i);
    const stateMatch = callbackHtml.match(/name="state" value="([^"]+)"/i);

    if (formActionMatch && codeMatch && stateMatch) {
      const subperfilUrl = formActionMatch[1].replace(/&amp;/g, '&');
      const authFormBody = new URLSearchParams({
        code: codeMatch[1],
        state: stateMatch[1]
      });

      const finalAuthRes = await this.fetchWithCookies(subperfilUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: authFormBody.toString()
      });

      let subperfilHtml = await finalAuthRes.text();
      let locSub = finalAuthRes.headers.get('location');

      if (locSub) {
        const u = new URL(locSub, subperfilUrl).href;
        const rLoc = await this.fetchWithCookies(u);
        subperfilHtml = await rLoc.text();
      }

      if (subperfilHtml.includes('Acessar') || subperfilHtml.includes('AJBORGES') || subperfilHtml.includes('LoginListaSubperfil')) {
        const linkAcessar = subperfilHtml.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?Acessar/i) || subperfilHtml.match(/href="([^"]*Selecionar[^"]*)"/i);
        if (linkAcessar) {
          const urlAcessar = new URL(linkAcessar[1].replace(/&amp;/g, '&'), 'https://www.repom.com.br/Repom.Frete.Web/Account/LoginListaSubperfil').href;
          const rAcessar = await this.fetchWithCookies(urlAcessar, { redirect: 'manual' });
          let nextL = rAcessar.headers.get('location');
          while (nextL) {
            const dest = new URL(nextL, urlAcessar).href;
            const rFollow = await this.fetchWithCookies(dest, { redirect: 'manual' });
            nextL = rFollow.headers.get('location');
          }
        }
      }
    }

    this.salvarSessao();
    console.log('🎉 Sessão iniciada com sucesso!');
  }

  async consultarPlaca(placa) {
    const placaLimpa = placa.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const url = 'https://www.repom.com.br/Repom.Frete.Web/ConsultaTag/ConsultaTagPedagio';

    const res = await this.fetchWithCookies(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'referer': 'https://www.repom.com.br/Repom.Frete.Web/ConsultaTag/ConsultaTag'
      },
      body: `placa=${encodeURIComponent(placaLimpa)}`
    });

    if (!res.ok) {
      throw new Error(`Erro HTTP ${res.status}`);
    }

    const text = await res.text();
    if (text.startsWith('<')) {
      throw new Error('Sessão expirada (retornou HTML)');
    }

    return JSON.parse(text);
  }
}

module.exports = RepomClient;
