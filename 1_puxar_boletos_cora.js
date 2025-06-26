// autentica com a Cora API para buscar boletos, valida se eles já existem no
// Notion Database por meio de "ID Cora", e insere novos boletos com informações completas como
// nome, valor, CPF, email, e data de vencimento, utilizando o Notion API.
// ATUALIZAÇÃO: Se telefone do boleto Cora vier vazio, busca na linha-base do Notion (por email/cpf).

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const axios = require('axios');
const { Client } = require('@notionhq/client');
const querystring = require('querystring');

// Configurações do Ambiente
const certFolderPath = process.env.CERT_FOLDER_PATH;
const certificateFilename = process.env.CERTIFICATE_FILENAME || 'certificate.pem';
const privateKeyFilename = process.env.PRIVATE_KEY_FILENAME || 'private-key.key';
const privateKeyPassphrase = process.env.PRIVATE_KEY_PASSPHRASE || null;
const coraApiBaseUrl = process.env.CORA_API_BASE_URL;
const coraClientId = process.env.CORA_CLIENT_ID;
const notionToken = process.env.NOTION_TOKEN;
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

// Cliente do Notion
const notion = new Client({ auth: notionToken });

async function getCertOrKey(envVar, folder, filename) {
    if(process.env[envVar]) {
        return Buffer.from(process.env[envVar], 'utf-8');
    }
    try {
        return await fs.readFile(path.join(folder, filename));
    } catch (e) {
        throw new Error(`Erro ao ler arquivo ${filename}: ${e.message}`);
    }
}

async function createHttpsAgent() {
    try {
        const cert = await getCertOrKey('CORACERT', certFolderPath, certificateFilename);
        const key = await getCertOrKey('CORAKEY', certFolderPath, privateKeyFilename);
        return new https.Agent({
            cert: cert,
            key: key,
            passphrase: privateKeyPassphrase,
            rejectUnauthorized: true
        });
    } catch (error) {
        console.error('Erro ao ler certificado/chave:', error.message);
        throw error;
    }
}

async function getAccessToken(httpsAgent) {
    const tokenUrl = `${coraApiBaseUrl}/token`;
    const requestBody = querystring.stringify({
        grant_type: 'client_credentials',
        client_id: coraClientId
    });
    try {
        const response = await axios.post(tokenUrl, requestBody, {
            httpsAgent: httpsAgent,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Erro ao obter o token de acesso:', error.message);
        throw error;
    }
}

// Função para buscar todos os IDs CORA já cadastrados no Notion (paginando)
async function getAllCoraIdsFromNotion() {
    let coraIds = new Set();
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
        const response = await notion.databases.query({
            database_id: notionDatabaseId,
            start_cursor: startCursor,
            page_size: 100
        });
        for (let page of response.results) {
            const idProp = page.properties['ID Cora'];
            if (idProp && idProp.rich_text && idProp.rich_text.length > 0) {
                coraIds.add(idProp.rich_text[0].plain_text);
            }
        }
        hasMore = response.has_more;
        startCursor = response.next_cursor;
    }
    return coraIds;
}

// NOVO: Buscar linhas-base (cadastro) e montar mapa {cpf|email: telefone}
async function getBaseAlunoTelefoneMap() {
    let hasMore = true;
    let startCursor = undefined;
    const alunoTelefoneMap = {};
    while (hasMore) {
        const response = await notion.databases.query({
            database_id: notionDatabaseId,
            start_cursor: startCursor,
            page_size: 100
        });
        for (let page of response.results) {
            const cpfProp = page.properties['CPF'];
            const emailProp = page.properties['Email'];
            const telefoneProp = page.properties['Telefone'];
            const idCoraProp = page.properties['ID Cora'];
            // Identifica linhas-base (sem boletos; ID Cora vazio) - pode customizar este critério!
            const idCoraEmpty = !idCoraProp || (idCoraProp.rich_text.length === 0) ||
                (idCoraProp.rich_text[0].plain_text.trim() === "");
            if (
                cpfProp && cpfProp.rich_text.length > 0 &&
                emailProp && emailProp.email
                && idCoraEmpty
            ) {
                const cpf = cpfProp.rich_text[0].plain_text.trim();
                const email = emailProp.email.trim().toLowerCase();
                const telefone = telefoneProp && telefoneProp.rich_text.length > 0
                    ? telefoneProp.rich_text[0].plain_text.trim()
                    : "";
                if (cpf && email && telefone) {
                    alunoTelefoneMap[`${cpf}|${email}`] = telefone;
                }
            }
        }
        hasMore = response.has_more;
        startCursor = response.next_cursor;
    }
    return alunoTelefoneMap;
}

async function fetchAllBoletos(httpsAgent, token, coraIdsInNotion, alunoTelefoneMap) {
    let page = 1;
    const perPage = 200;
    try {
        let totalItemsProcessed = 0;
        let totalItems = 0;
        do {
            const response = await axios.get(`${coraApiBaseUrl}/v2/invoices`, {
                httpsAgent: httpsAgent,
                headers: { 'Authorization': `Bearer ${token}` },
                params: {
                    page: page,
                    perPage: perPage,
                    start: '2025-01-01',
                    end: '2026-12-31',
                }
            });
            const items = response.data.items;
            totalItems = response.data.totalItems || items.length;
            if (!items || items.length === 0) {
                break;
            }
            const startDate = new Date('2025-01-01');
            const endDate = new Date('2026-12-31');
            for (let item of items) {
                const dueDate = new Date(item.due_date);
                if (dueDate >= startDate && dueDate <= endDate) {
                    const detailUrl = `${coraApiBaseUrl}/v2/invoices/${item.id}`;
                    const detailResponse = await axios.get(detailUrl, {
                        httpsAgent: httpsAgent,
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const boleto = detailResponse.data;
                    if (boleto.status === "CANCELLED") {
                        continue;
                    }
                    const alunoNome = boleto.customer?.name || '';
                    const email = boleto.customer?.email || null;
                    let telefone = boleto.customer?.telephone || null;
                    let cpf = '';
                    if (
                        boleto.customer &&
                        boleto.customer.document &&
                        boleto.customer.document.type &&
                        boleto.customer.document.type.toUpperCase() === 'CPF' &&
                        boleto.customer.document.identity
                    ) {
                        cpf = boleto.customer.document.identity.toString();
                    }
                    // Valor
                    let valorCents = boleto.total_amount ?? 0;
                    let valorFormatado = Number((valorCents / 100).toFixed(2));
                    // PIX
                    const pix = boleto.pix?.emv ?? '';
                    // Link do boleto
                    const boletoLink = boleto.payment_options?.bank_slip?.url ?? '';
                    // Parcela/Mês: últimos 13 caracteres de services[0].name
                    let parcelaMes = '';
                    if (boleto.services && boleto.services.length > 0 && boleto.services[0].name) {
                        let nomeService = boleto.services[0].name;
                        parcelaMes = nomeService.slice(-13);
                    }
                    const idCora = boleto.id;
                    // Caso telefone do boleto não exista, busca nas linhas-base Notion (cpf+email)
                    if ((!telefone || telefone.trim() === "") && cpf && email) {
                        const key = `${cpf.trim()}|${email.trim().toLowerCase()}`;
                        if (alunoTelefoneMap[key]) {
                            telefone = alunoTelefoneMap[key];
                        }
                    }
                    // Cria boleto se não existe
                    if (!coraIdsInNotion.has(idCora)) {
                        await createNotionEntry(
                            alunoNome, dueDate, valorFormatado, boletoLink,
                            idCora, cpf, telefone, email, pix, parcelaMes
                        );
                        coraIdsInNotion.add(idCora);
                    }
                }
            }
            totalItemsProcessed += items.length;
            page++; // Próxima página
        } while (totalItemsProcessed < totalItems);
    } catch (error) {
        console.error('Erro ao buscar detalhes dos boletos:', error.message);
    }
}

let totalNovos = 0;
async function createNotionEntry(
    alunoNome, dueDate, valorFormatado, boletoLink,
    idCora, cpf, telefone, email, pix, parcelaMes
) {
    try {
        const formattedDate = dueDate.toISOString().split('T')[0];
        const properties = {
            'Nome Aluno': { title: [{ text: { content: alunoNome } }] },
            'Vecto': { date: { start: formattedDate } },
            'Valor': { number: valorFormatado },
            'Link Boleto': { rich_text: [{ text: { content: boletoLink } }] },
            'ID Cora': { rich_text: [{ text: { content: idCora } }] },
            'Email': { email: email },
            'CPF': { rich_text: [{ text: { content: cpf } }] },
            'Telefone': { rich_text: [{ text: { content: telefone ?? "" } }] },
            'PIX': { rich_text: [{ text: { content: pix } }] },
            'Parcela/Mês': { rich_text: [{ text: { content: parcelaMes } }] },
            'Status': { select: { name: "Pendente" } },
            'Status Geração': { select: { name: "Boleto OK" } },
        };
        await notion.pages.create({
            parent: { database_id: notionDatabaseId },
            properties: properties
        });
        console.log(`Adicionado ao Notion: ${alunoNome} | Vcto: ${formattedDate} | ID Cora: ${idCora}`);
         totalNovos++;
    } catch (error) {
        console.error('Erro ao criar entrada no Notion:', error.message);
    }
}

// Função principal
async function main() {
    console.log('[1_puxar_boletos_cora.js] INÍCIO do main');
    try {
        const httpsAgent = await createHttpsAgent();
        const token = await getAccessToken(httpsAgent);
        const coraIdsInNotion = await getAllCoraIdsFromNotion();
        // Busca o mapa com telefones dos alunos (das linhas base)
        const alunoTelefoneMap = await getBaseAlunoTelefoneMap();
        await fetchAllBoletos(httpsAgent, token, coraIdsInNotion, alunoTelefoneMap);
    } catch (error) {
        console.error('Erro crítico durante a execução:', error.message);
    }
    console.log(`Execução concluída. Boletos novos adicionados: ${totalNovos}.`);
}

// Para usar como módulo ou executar diretamente
if (require.main === module) {
    main();
} else {
    module.exports = main;
}
