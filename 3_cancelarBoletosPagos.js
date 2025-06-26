// esse código compara os boletos na planilha notion com os registrados no cora.
//aqueles boletos que, na planilha estão com status quitado, mas abertos no cora, ele os cancela mesmo atrasados.
//aqueles boletos que, estão com status quitado, e no cora foram pagos, não faz nada.
//boletos com status cancelado, e abertos no cora, ele os cancela.
//boletos pendentes e abertos no cora, não faz nada.

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const https = require('https');
const { Client } = require('@notionhq/client');
const querystring = require('querystring');

// CONFIGS
const certFolderPath = process.env.CERT_FOLDER_PATH;
const certificateFilename = process.env.CERTIFICATE_FILENAME || 'certificate.pem';
const privateKeyFilename = process.env.PRIVATE_KEY_FILENAME || 'private-key.key';
const privateKeyPassphrase = process.env.PRIVATE_KEY_PASSPHRASE || null;
const coraApiBaseUrl = process.env.CORA_API_BASE_URL;
const coraClientId = process.env.CORA_CLIENT_ID;
const notionToken = process.env.NOTION_TOKEN;
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

// Criação client do Notion
const notion = new Client({ auth: notionToken });

/**
 * Função flexível para obter certificado/key: busca em variável de ambiente ou arquivo
 */
async function getCertOrKey(envVar, folder, filename) {
    if (process.env[envVar]) {
        return Buffer.from(process.env[envVar], 'utf-8');
    }
    return await fs.readFile(path.join(folder, filename));
}

async function createHttpsAgent() {
    const cert = await getCertOrKey('CORACERT', certFolderPath, certificateFilename);
    const key = await getCertOrKey('CORAKEY', certFolderPath, privateKeyFilename);
    return new https.Agent({
        cert: cert,
        key: key,
        passphrase: privateKeyPassphrase,
        rejectUnauthorized: true
    });
}

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

// Função para buscar boletos do Notion (com ID cora e status)
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
            if (idCoraProp && idCoraProp.rich_text && idCoraProp.rich_text.length > 0) {
                idCora = idCoraProp.rich_text[0].plain_text;
            }
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

// Função para buscar o status do boleto no Cora por ID
async function getCoraBoletoStatus(idCora, httpsAgent, token) {
    try {
        const resp = await axios.get(`${coraApiBaseUrl}/v2/invoices/${idCora}`, {
            httpsAgent,
            headers: { 'Authorization': `Bearer ${token}` }
        });
        // Status típicos: "OPEN", "PAID", "CANCELLED", etc.
        return resp.data.status;
    } catch (e) {
        console.error(`Erro ao obter boleto ${idCora} da Cora:`, e?.response?.data || e?.message);
        return null;
    }
}

// Função para cancelar boleto via API Cora
async function cancelarBoletoCora(idCora, httpsAgent, token) {
    try {
        await axios.delete(`${coraApiBaseUrl}/v2/invoices/${idCora}`, {
            httpsAgent,
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`✅ Boleto ${idCora} cancelado com sucesso na Cora!`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao cancelar boleto ${idCora}:`, error?.response?.data || error.message);
        return false;
    }
}

// ...funcao principal
async function main() {
    console.log('[3_cancelarBoletos...] INÍCIO do main');
    console.log('[3_cancelarBoleto...] Entrou na função main');
    
    const httpsAgent = await createHttpsAgent();
    const token = await getAccessToken(httpsAgent);
    console.log('Consultando todas as páginas/boletos do Notion...');
    const boletosNotion = await getNotionBoletos();
    
    let totalCancelados = 0, totalIgnorados = 0, totalErros = 0;
    let countCanceladosCora = 0;
    let countQuitadosCora = 0;
    
    for (const boleto of boletosNotion) {
        const { idCora, status } = boleto;
        if (!idCora) continue;
        
        const statusNotion = (status || '').toUpperCase();
        
        if (['QUITADO', 'CANCELADA'].includes(statusNotion)) {
            const coraStatus = (await getCoraBoletoStatus(idCora, httpsAgent, token) || '').toUpperCase();
            
            if (coraStatus === 'OPEN' || coraStatus === 'LATE') {
                // Só cancela se Quitado ou Cancelado no Notion, mas aberto ou atrasado no Cora
                const ok = await cancelarBoletoCora(idCora, httpsAgent, token);
                if (ok) totalCancelados++;
                else totalErros++;
            }
            else if (coraStatus === 'PAID') {
                countQuitadosCora++;
                totalIgnorados++;
            }
            else if (coraStatus === 'CANCELLED') {
                countCanceladosCora++;
                totalIgnorados++;
            }
            else {
                // Não reconhecido
                totalIgnorados++;
            }
        } else {
            // Status Pendente ou Inativo, não faz nada mesmo que esteja aberto na Cora
            totalIgnorados++;
        }
    }
    
    // Só mostra linhas detalhadas dos boletos realmente manipulados/cancelados
    if (totalCancelados)
        console.log(`✅ ${totalCancelados} boletos cancelados na Cora.`);
    if (countCanceladosCora)
        console.log(`ℹ️ ${countCanceladosCora} boletos já estavam cancelados na Cora (não repetidos no log).`);
    if (countQuitadosCora)
        console.log(`ℹ️ ${countQuitadosCora} boletos já estavam quitados na Cora (não repetidos no log).`);
    if (totalErros)
        console.log(`❌ Erros ao cancelar: ${totalErros}`);
    
    console.log(`Resumo geral: Cancelados ${totalCancelados}, Já cancelados ${countCanceladosCora}, Quitados ${countQuitadosCora}, Ignorados ${totalIgnorados}, Erros ${totalErros}`);
}

// Para usar como módulo ou executar diretamente
if (require.main === module) {
    main();
} else {
    module.exports = main;
}
