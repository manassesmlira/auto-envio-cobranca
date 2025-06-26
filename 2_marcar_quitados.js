//esse codigo verifica no cora quais boletos estão pagos e atualiza a planilha do notion
// marcando status como Quitado caso não esteja

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const https = require('https');
const { Client } = require('@notionhq/client');
const querystring = require('querystring');

// Variáveis de ambiente
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
        // Opcional: Buffer para robustez universal!
        return Buffer.from(process.env[envVar], 'utf-8');
    }
    return await fs.readFile(path.join(folder, filename));
}

async function createHttpsAgent() {
    const cert = await getCertOrKey('CORACERT', certFolderPath, certificateFilename);
    const key = await getCertOrKey('CORAKEY', certFolderPath, privateKeyFilename);
    return new https.Agent({
        cert,
        key,
        passphrase: privateKeyPassphrase,
        rejectUnauthorized: true
    });
}

// Pega token de acesso na Cora
async function getAccessToken(httpsAgent) {
    const tokenUrl = `${coraApiBaseUrl}/token`;
    const requestBody = querystring.stringify({
        grant_type: 'client_credentials',
        client_id: coraClientId
    });
    const response = await axios.post(tokenUrl, requestBody, {
        httpsAgent: httpsAgent,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data.access_token;
}

// Busca todos os boletos do Notion
async function getNotionBoletos() {
    let boletos = [];
    let cursor = undefined;
    let hasMore = true;
    while (hasMore) {
        const response = await notion.databases.query({
            database_id: notionDatabaseId,
            start_cursor: cursor,
            page_size: 100
        });
        for (const page of response.results) {
            const idCoraProp = page.properties['ID Cora'];
            const statusProp = page.properties['Status'];
            let idCora = '';
            if (idCoraProp && idCoraProp.rich_text && idCoraProp.rich_text.length > 0)
                idCora = idCoraProp.rich_text[0].plain_text;
            let status = '';
            if (statusProp) {
                // Pega status de "select" ou "rich_text"
                if (statusProp.select) status = statusProp.select.name;
                else if (statusProp.rich_text && statusProp.rich_text.length > 0) status = statusProp.rich_text[0].plain_text;
            }
            if (idCora && status)
                boletos.push({
                    idCora: idCora.trim(),
                    status: status.trim(),
                    pageId: page.id
                });
        }
        hasMore = response.has_more;
        cursor = response.next_cursor;
    }
    return boletos;
}

// Consulta status do boleto na Cora
async function getCoraBoletoStatus(idCora, httpsAgent, token) {
    try {
        const resp = await axios.get(`${coraApiBaseUrl}/v2/invoices/${idCora}`, {
            httpsAgent,
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return resp.data.status;
    } catch (e) {
        console.error(`Erro ao obter boleto ${idCora} na Cora:`, e?.response?.data || e?.message);
        return null;
    }
}

// Atualiza status do boleto para Quitado no Notion
async function marcarComoQuitadoNoNotion(pageId) {
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                // Se o campo de status no seu Notion for 'select':
                'Status': { select: { name: 'Quitado' } }
                // Se for rich_text, use:
                // 'Status': { rich_text: [{ text: { content: 'Quitado' } }] }
            }
        });
       // console.log(`✅ Status marcado como Quitado no Notion (${pageId})`);
    } catch (error) {
        console.error(`Erro ao atualizar status do Notion para Quitado (pageId: ${pageId})`, error?.response?.data || error.message);
    }
}

// Função principal
async function main() {
    console.log('[2_marcar_quita...] INÍCIO do main');
    console.log('[2_marcar_quita...] Entrou na função main');
    
    const httpsAgent = await createHttpsAgent();
    const token = await getAccessToken(httpsAgent);
    let boletosNotion = await getNotionBoletos();
    let totalAtualizados = 0;
    let totalVerificados = 0;
    
    for (const boleto of boletosNotion) {
        // Só tentamos atualizar caso NÃO esteja já Quitado
        if (boleto.status.toUpperCase() !== 'QUITADO') {
            const coraStatus = (await getCoraBoletoStatus(boleto.idCora, httpsAgent, token) || '').toUpperCase();
            if (coraStatus === 'PAID') {
                await marcarComoQuitadoNoNotion(boleto.pageId);
                totalAtualizados++;
            }
            totalVerificados++;
        }
    }
    console.log(`Processo concluído: ${totalAtualizados} marcados como Quitado (de ${totalVerificados} verificados).`);
}

// Para usar como módulo ou executar diretamente
if (require.main === module) {
    main();
} else {
    module.exports = main;
}
