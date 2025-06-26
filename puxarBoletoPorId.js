require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const axios = require('axios');
const querystring = require('querystring');

// Configurações do Ambiente (.env)
const certFolderPath = process.env.CERT_FOLDER_PATH;
const certificateFilename = process.env.CERTIFICATE_FILENAME || 'certificate.pem';
const privateKeyFilename = process.env.PRIVATE_KEY_FILENAME || 'private-key.key';
const privateKeyPassphrase = process.env.PRIVATE_KEY_PASSPHRASE || null;
const coraApiBaseUrl = process.env.CORA_API_BASE_URL;
const coraClientId = process.env.CORA_CLIENT_ID;

// Função para criar HTTPS Agent com mTLS
async function createHttpsAgent() {
    const cert = await fs.readFile(path.join(certFolderPath, certificateFilename));
    const key = await fs.readFile(path.join(certFolderPath, privateKeyFilename));
    return new https.Agent({
        cert: cert,
        key: key,
        passphrase: privateKeyPassphrase,
        rejectUnauthorized: true
    });
}

// Função para obter token Cora
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

// Função principal para busca e exibição
async function consultarBoletoPorId(boletoId) {
    if (!boletoId) {
        console.log('Por favor, informe o ID do boleto como argumento no terminal.');
        console.log('Exemplo: node consultar-boleto.js inv_S2iiOIscTTKximxFuycwAA');
        process.exit(1);
    }

    try {
        const httpsAgent = await createHttpsAgent();
        const token = await getAccessToken(httpsAgent);

        const detailUrl = `${coraApiBaseUrl}/v2/invoices/${boletoId}`;

        const response = await axios.get(detailUrl, {
            httpsAgent: httpsAgent,
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const boleto = response.data;
        console.log(`Exibindo o boleto de ID: ${boleto.id}`);
        console.dir(boleto, { depth: null, colors: true });    // Exibe objeto completo, colorido, aninhado

    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.error('Boleto não encontrado. Verifique o ID.');
        } else {
            console.error('Erro ao consultar boleto:', error.message);
        }
        process.exit(1);
    }
}

// Pega ID do boleto da linha de comando
const boletoId = process.argv[2];
consultarBoletoPorId(boletoId);

