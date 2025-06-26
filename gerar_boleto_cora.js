// Este código é uma aplicação Node.js que automatiza o processo de geração de boletos
//  usando a API Cora, com dados armazenados e geridos no Notion. 
// Inicialmente, ele carrega variáveis de configuração de um arquivo .env, 
// verifica por dados essenciais, e estabelece uma conexão segura via mTLS. 
// A aplicação busca linhas no Notion que requerem geração de boletos, valida e extrai 
// informações essenciais, e chama a API Cora para criar os boletos. 
// As respostas são então atualizadas no Notion, marcando sucesso ou erro. 
// Ele também manipula dados como CPF e endereços, e loga erros ou sucessos ao longo do processo.


// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();
// Importa os módulos necessários
const { Client } = require('@notionhq/client');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const { randomUUID } = require('crypto'); // Para gerar chaves de idempotência

// --- Configurações do Notion ---
// !! IMPORTANTE: Verifique se os nomes no seu .env correspondem a estes !!
const NOTION_API_KEY = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Nomes EXATOS das colunas no Notion (AJUSTE SE NECESSÁRIO)
const COL_STATUS_GERACAO = 'Status Geração';
const COL_NOME_ALUNO = 'Nome Aluno'; // Tipo Título
const COL_CPF = 'CPF'; // Tipo Texto (Rich Text)
const COL_EMAIL = 'Email'; // Tipo Email
const COL_TELEFONE = 'Telefone'; // Tipo Texto (Rich Text)
const COL_VECTO = 'Vecto'; // Tipo Data
const COL_VALOR = 'Valor'; // Tipo Número
const COL_PARCELA_MES = 'Parcela/Mês'; // Tipo Texto (Rich Text) - Usado para descrição/nome do serviço
// Colunas de Endereço (Tipo Texto/Rich Text)
const COL_END_RUA = 'Rua/Avenida';
const COL_END_NUMERO = 'Número';
const COL_END_COMPLEMENTO = 'Complemento';
const COL_END_BAIRRO = 'Bairro'; // Usado como FALLBACK se a busca por CEP falhar
const COL_END_CIDADE = 'Cidade';
const COL_END_ESTADO = 'Estado'; // Exigido pela Cora (Sigla 2 letras)
const COL_END_CEP = 'CEP';
// Colunas 
const COL_ID_CORA = 'ID Cora'; // Tipo Texto (Rich Text)
const COL_LINK_BOLETO = 'Link Boleto'; // Tipo Texto (Rich Text) - AJUSTADO AQUI
const COL_COD_BARRAS = 'Cod. Barras'; // Tipo Texto (Rich Text)

// Valor que indica que o boleto deve ser gerado
const STATUS_GERAR = 'Gerar Boleto';
// Valor para indicar que o boleto foi gerado com sucesso
const STATUS_GERADO_OK = 'Boleto OK';
// Valor para indicar erro na geração ou dados
const STATUS_ERRO = 'Erro'; // Adicionado para marcar erros

// --- Configurações da API Cora ---
// !! IMPORTANTE: Verifique se os nomes no seu .env correspondem a estes !!
const CERT_FOLDER_PATH = process.env.CERT_FOLDER_PATH;
const CERTIFICATE_FILENAME = process.env.CERTIFICATE_FILENAME || 'certificate.pem';
const PRIVATE_KEY_FILENAME = process.env.PRIVATE_KEY_FILENAME || 'private-key.key';
const PRIVATE_KEY_PASSPHRASE = process.env.PRIVATE_KEY_PASSPHRASE || null;
const CORA_API_BASE_URL = process.env.CORA_API_BASE_URL;
const CORA_CLIENT_ID = process.env.CORA_CLIENT_ID;

// --- Validações Essenciais ---
if (!NOTION_API_KEY || !NOTION_DATABASE_ID || !CERT_FOLDER_PATH || !CORA_API_BASE_URL || !CORA_CLIENT_ID) {
    console.error('❌ Erro Crítico: Variáveis de ambiente essenciais não definidas no .env.');
    console.error(' Verifique NOTION_TOKEN, NOTION_DATABASE_ID, CERT_FOLDER_PATH, CORA_API_BASE_URL, CORA_CLIENT_ID.');
    process.exit(1);
}

// Caminhos completos para os arquivos de certificado e chave
const certificatePath = path.join(CERT_FOLDER_PATH, CERTIFICATE_FILENAME);
const privateKeyPath = path.join(CERT_FOLDER_PATH, PRIVATE_KEY_FILENAME);

// --- Inicialização do Cliente Notion ---
const notion = new Client({ auth: NOTION_API_KEY });

// --- Funções Auxiliares Cora ---
let accessToken = null;
let httpsAgent = null;

async function createHttpsAgent() {
    if (httpsAgent) return httpsAgent; // Retorna o agente se já criado
    try {
        const cert = await fs.readFile(certificatePath);
        const key = await fs.readFile(privateKeyPath);
        console.log('🔑 Certificados Cora lidos com sucesso.');
        httpsAgent = new https.Agent({
            cert: cert,
            key: key,
            passphrase: PRIVATE_KEY_PASSPHRASE,
            rejectUnauthorized: true // Mantenha true em produção
        });
        return httpsAgent;
    } catch (error) {
        console.error('❌ Erro Crítico ao ler arquivos de certificado/chave Cora:', error.message);
        if (error.code === 'ENOENT') {
            console.error(` Verifique o caminho da pasta em CERT_FOLDER_PATH: "${CERT_FOLDER_PATH}"`);
            console.error(` Certificado esperado em: ${certificatePath}`);
            console.error(` Chave privada esperada em: ${privateKeyPath}`);
        }
        throw error; // Interrompe a execução
    }
}

async function getAccessToken() {
    if (accessToken) return accessToken; // Retorna o token se já obtido
    const agent = await createHttpsAgent(); // Garante que o agente foi criado
    console.log('--- Obtendo Token de Acesso da Cora ---');
    const tokenUrl = `${CORA_API_BASE_URL}/token`;
    const requestBody = querystring.stringify({
        grant_type: 'client_credentials',
        client_id: CORA_CLIENT_ID
    });
    try {
        const response = await axios.post(tokenUrl, requestBody, {
            httpsAgent: agent,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (response.data && response.data.access_token) {
            console.log('✅ Token de Acesso Cora obtido com sucesso!');
            accessToken = response.data.access_token;
            // Definir um timeout para invalidar o token antes de expirar (opcional, mas bom)
            // const expiresIn = response.data.expires_in || 3600; // Padrão 1 hora se não vier
            // setTimeout(() => { accessToken = null; console.log('Token Cora expirado (cache local)'); }, (expiresIn - 60) * 1000); // Expira 1 min antes
            return accessToken;
        } else {
            throw new Error('Resposta da API de token Cora inválida ou sem access_token.');
        }
    } catch (error) {
        console.error('❌ Erro ao obter o Token de Acesso Cora:');
        if (error.response) {
            console.error(` Status ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        } else {
            console.error(` Erro: ${error.message}`);
        }
        throw error; // Interrompe a execução
    }
}

// --- Função para buscar endereço pelo CEP (ViaCEP) ---
async function getAddressFromCep(cep) {
    if (!cep || cep.length !== 8) {
        console.warn(` -> CEP inválido para consulta: ${cep}`);
        return null;
    }
    const url = `https://viacep.com.br/ws/${cep}/json/`;
    console.log(` -> Consultando ViaCEP para ${cep}...`);
    try {
        const response = await axios.get(url);
        if (response.data && !response.data.erro) {
            console.log(` -> Endereço encontrado via CEP: Bairro: ${response.data.bairro}, Cidade: ${response.data.localidade}, UF: ${response.data.uf}`);
            return {
                bairro: response.data.bairro,
                cidade: response.data.localidade,
                estado: response.data.uf,
                rua: response.data.logradouro // Pode ser útil para validação futura
            };
        } else {
            console.warn(` -> ViaCEP retornou erro ou não encontrou dados para o CEP ${cep}.`);
            return null;
        }
    } catch (error) {
        console.error(`❌ Erro ao consultar ViaCEP para ${cep}: ${error.message}`);
        return null;
    }
}


// --- Funções de Extração de Dados do Notion ---
function getPlainText(property) {
    // Retorna null se a propriedade ou rich_text for inválido, ou se o texto for vazio
    if (property && property.rich_text && property.rich_text.length > 0 && property.rich_text[0].plain_text) {
        return property.rich_text[0].plain_text;
    }
    return null;
}

function getTitleText(property) {
    if (property && property.title && property.title.length > 0 && property.title[0].plain_text) {
        return property.title[0].plain_text;
    }
    return null;
}

function getNumberValue(property) {
    if (property && typeof property.number === 'number') {
        return property.number;
    }
    return null;
}

function getDateValue(property) {
    if (property && property.date && property.date.start) {
        return property.date.start; // Formato YYYY-MM-DD
    }
    return null;
}

function getEmailValue(property) {
    if (property && property.email) {
        return property.email;
    }
    return null;
}

function getPhoneValue(property) {
    let rawPhone = null;
    // Tenta pegar de 'phone_number' primeiro, se existir
    if (property && property.phone_number) {
        rawPhone = property.phone_number;
    }
    // Se não, tenta pegar de 'rich_text' (como estava antes)
    else if (property && property.rich_text && property.rich_text.length > 0) {
        rawPhone = property.rich_text[0].plain_text;
    }

    if (rawPhone) {
        const cleanedPhone = rawPhone.replace(/\D/g, '');
        if (cleanedPhone.startsWith('55')) {
            return `+${cleanedPhone}`;
        } else if (cleanedPhone.length >= 10) { // Garante DDD + número
            return `+55${cleanedPhone}`;
        } else {
            console.warn(` - Telefone "${rawPhone}" parece inválido ou curto demais após limpeza.`);
            return null;
        }
    }
    return null;
}

// Função para buscar linhas no Notion que precisam gerar boleto
async function findRowsToGenerateBoleto() {
    console.log(`\n--- Buscando linhas no Notion com "${COL_STATUS_GERACAO}" = "${STATUS_GERAR}" ---`);
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            filter: {
                property: COL_STATUS_GERACAO,
                select: {
                    equals: STATUS_GERAR,
                },
            },
        });
        console.log(`✅ Encontradas ${response.results.length} linha(s) para gerar boleto.`);
        return response.results;
    } catch (error) {
        console.error('❌ Erro ao consultar o Notion Database:', error.code || error.body);
        throw error;
    }
}

// --- Função Principal de Geração na Cora ---
async function generateCoraInvoice(notionPageData) {
    const agent = await createHttpsAgent();
    const token = await getAccessToken(); // Garante que temos um token válido
    const invoiceUrl = `${CORA_API_BASE_URL}/v2/invoices`;
    const properties = notionPageData.properties;

    // Extrai dados do Notion
    const nomeAluno = getTitleText(properties[COL_NOME_ALUNO]);
    const cpf = getPlainText(properties[COL_CPF])?.replace(/\D/g, '');
    const email = getEmailValue(properties[COL_EMAIL]);
    const telefone = getPhoneValue(properties[COL_TELEFONE]); // Usando a função atualizada
    const vecto = getDateValue(properties[COL_VECTO]);
    const valor = getNumberValue(properties[COL_VALOR]);
    const parcelaMes = getPlainText(properties[COL_PARCELA_MES]) || 'Mensalidade';
    const rua = getPlainText(properties[COL_END_RUA]);
    const numero = getPlainText(properties[COL_END_NUMERO]);
    const complemento = getPlainText(properties[COL_END_COMPLEMENTO]) || '';
    const bairroNotion = getPlainText(properties[COL_END_BAIRRO])?.trim(); // Bairro do Notion (fallback)
    const cidade = getPlainText(properties[COL_END_CIDADE]);
    const estado = getPlainText(properties[COL_END_ESTADO])?.trim(); // Remove espaços extras
    const cep = getPlainText(properties[COL_END_CEP])?.replace(/\D/g, '');

    let bairroParaCora = null; // Variável para o bairro final

    // 1. Tenta buscar endereço (e bairro) pelo CEP
    if (cep && cep.length === 8) {
        const enderecoViaCep = await getAddressFromCep(cep);
        if (enderecoViaCep && enderecoViaCep.bairro) {
            bairroParaCora = enderecoViaCep.bairro;
            console.log(` -> Bairro definido via CEP (${cep}): "${bairroParaCora}"`);
            // Opcional: Validar se cidade/estado do CEP batem com Notion?
            // if (enderecoViaCep.cidade && cidade && enderecoViaCep.cidade.toLowerCase() !== cidade.toLowerCase()) {
            //     console.warn(` -> Atenção: Cidade do CEP (${enderecoViaCep.cidade}) difere da cidade no Notion (${cidade}).`);
            // }
            // if (enderecoViaCep.estado && estado && enderecoViaCep.estado.toUpperCase() !== estado.toUpperCase()) {
            //     console.warn(` -> Atenção: Estado do CEP (${enderecoViaCep.estado}) difere do estado no Notion (${estado}).`);
            // }
        } else {
            console.warn(` -> Aviso: CEP ${cep} consultado, mas ViaCEP não retornou bairro. Usando bairro do Notion: "${bairroNotion}"`);
            bairroParaCora = bairroNotion;
        }
    } else {
        console.warn(` -> Aviso: CEP inválido ou não fornecido ("${cep}"). Usando bairro do Notion: "${bairroNotion}"`);
        bairroParaCora = bairroNotion;
    }

    // 2. Validação dos dados ESSENCIAIS para a Cora API
    const missingFields = [];
    if (!nomeAluno) missingFields.push(COL_NOME_ALUNO);
    if (!cpf) missingFields.push(COL_CPF);
    if (!vecto) missingFields.push(COL_VECTO);
    if (valor === null || valor === undefined) missingFields.push(COL_VALOR); // Permite valor 0
    if (!rua) missingFields.push(COL_END_RUA);
    if (!numero) missingFields.push(COL_END_NUMERO);
    if (!bairroParaCora) missingFields.push(`${COL_END_BAIRRO} (ViaCEP ou Notion)`); // Verifica o bairro final
    if (!cidade) missingFields.push(COL_END_CIDADE);
    if (!estado) missingFields.push(COL_END_ESTADO);
    if (!cep) missingFields.push(COL_END_CEP);
    if (!email) missingFields.push(COL_EMAIL);
    if (!telefone) missingFields.push(COL_TELEFONE);

    if (missingFields.length > 0) {
        console.warn(`⚠️ Dados incompletos para a linha ID ${notionPageData.id}. Pulando geração.`);
        console.warn(` Campos faltando: ${missingFields.join(', ')}`);
        // Atualiza Notion para indicar erro de dados
        await updateNotionPageStatus(notionPageData.id, STATUS_ERRO, `Dados incompletos: ${missingFields.join(', ')}`);
        return { status: 'skipped', error: `Dados incompletos: ${missingFields.join(', ')}` };
    }

    if (estado.length !== 2) {
        console.warn(`⚠️ Estado "${estado}" inválido para a linha ID ${notionPageData.id}. Deve ser a sigla de 2 letras (ex: SP, RJ). Pulando geração.`);
        await updateNotionPageStatus(notionPageData.id, STATUS_ERRO, `Estado inválido: ${estado}`);
        return { status: 'skipped', error: `Estado inválido: ${estado}` };
    }

    // 3. Monta o corpo da requisição para a Cora
    const requestBody = {
        customer: {
            name: nomeAluno,
            document: { type: 'CPF', identity: cpf },
            email: email,
            phone_number: telefone,
            address: {
                zip_code: cep,
                street: rua,
                number: numero,
                complement: complemento,
                district: bairroParaCora, // Usa o bairro determinado (ViaCEP ou Notion)
                city: cidade,
                state: estado.toUpperCase()
            }
        },
        payment_terms: { due_date: vecto },
        services: [{
            name: parcelaMes,
            amount: Math.round(valor * 100) // Valor em centavos
        }],
        payment_options: { bank_slip: { payment_limit_date: vecto } }
    };

    const idempotencyKey = randomUUID();
    console.log(` -> Tentando gerar boleto para: ${nomeAluno} (Valor: R$ ${valor}, Vecto: ${vecto})`);
    console.log(` -> Usando Idempotency-Key: ${idempotencyKey}`);
    // console.log(' -> Enviando para Cora:', JSON.stringify(requestBody, null, 2)); // Descomente para depurar o payload

    // 4. Envia a requisição para a Cora
    try {
        const response = await axios.post(invoiceUrl, requestBody, {
            httpsAgent: agent,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey
            }
        });

        console.log(` ✅ Boleto gerado com sucesso na Cora! ID: ${response.data.id}`);
        return { status: 'success', data: response.data }; // Retorna sucesso e os dados da Cora

    } catch (error) {
        console.error(` ❌ Erro ao gerar boleto na Cora para ${nomeAluno}:`);
        let errorMessage = `Erro desconhecido: ${error.message}`;
        let errorDetails = '';

        if (error.response) {
            errorMessage = `Status ${error.response.status}: ${JSON.stringify(error.response.data)}`;
            console.error(` ${errorMessage}`);

            // Tenta extrair detalhes do erro da Cora
            if (error.response.data?.errors) {
                errorDetails = error.response.data.errors.map(err => {
                    let fieldName = err.field || err.code || 'N/A';
                    // Mapeamento simples (pode ser expandido)
                    if (fieldName === 'customer.address.district') fieldName = COL_END_BAIRRO; // Mantém o nome da coluna do Notion no log
                    if (fieldName === 'customer.address.zip_code') fieldName = COL_END_CEP;
                    // ... outros mapeamentos ...
                    return `Campo ${fieldName}: ${err.message}`;
                }).join('; ');
                console.error(` - Detalhes: ${errorDetails}`);
            }
        } else {
            console.error(` Erro: ${error.message}`);
        }

        // Atualiza Notion para indicar erro na API Cora
        await updateNotionPageStatus(notionPageData.id, STATUS_ERRO, errorDetails || errorMessage);
        return { status: 'error', error: errorDetails || errorMessage }; // Retorna erro
    }
}

// --- Função para Atualizar a Página no Notion (Sucesso) ---
async function updateNotionPageSuccess(pageId, coraInvoiceData) {
    console.log(` -> Atualizando linha ${pageId} no Notion com sucesso...`);
    const coraId = coraInvoiceData.id;
    const linkBoleto = coraInvoiceData.payment_options?.bank_slip?.url;
    const codBarras = coraInvoiceData.payment_options?.bank_slip?.digitable;

    // Adiciona uma verificação extra para garantir que linkBoleto é uma string válida
    if (!coraId || typeof linkBoleto !== 'string' || !linkBoleto || !codBarras) {
        console.error(` ❌ Dados essenciais faltando ou inválidos na resposta da Cora para ${pageId}. Não foi possível atualizar o Notion completamente.`);
        console.error(` ID Cora: ${coraId}, Link: ${linkBoleto}, Cod Barras: ${codBarras}`);
        // Mesmo com dados faltando, tenta atualizar o que tem e marcar como erro para revisão
        await updateNotionPageStatus(pageId, STATUS_ERRO, 'Dados da Cora incompletos/inválidos após geração.');
        return false;
    }

    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                [COL_ID_CORA]: { rich_text: [{ type: 'text', text: { content: coraId } }] },
                // CORREÇÃO APLICADA AQUI: Envia como rich_text
                [COL_LINK_BOLETO]: { rich_text: [{ type: 'text', text: { content: linkBoleto } }] },
                [COL_COD_BARRAS]: { rich_text: [{ type: 'text', text: { content: codBarras } }] },
                [COL_STATUS_GERACAO]: { select: { name: STATUS_GERADO_OK } },
                // Limpa a coluna de erro, se existir uma coluna para isso
                // [COL_ERRO_GERACAO]: { rich_text: [] } // Descomente e ajuste o nome se tiver essa coluna
            },
        });
        console.log(` ✅ Linha ${pageId} atualizada no Notion com sucesso!`);
        return true;
    } catch (error) {
        console.error(` ❌ Erro ao atualizar a página ${pageId} no Notion:`, error.code || error.body);
        // Log adicional para entender melhor o erro de validação
        if (error.code === 'validation_error') {
             console.error(` Detalhes da validação: ${error.message}`);
        }
        return false;
    }
}


// --- Função para Atualizar o Status e Erro no Notion ---
async function updateNotionPageStatus(pageId, status, errorMessage = '') {
    console.log(` -> Atualizando status da linha ${pageId} para "${status}" no Notion...`);
    try {
        const propertiesToUpdate = {
            [COL_STATUS_GERACAO]: { select: { name: status } },
        };
        // Adiciona a mensagem de erro se houver e se existir a coluna (ajuste o nome se necessário)
        // const COL_ERRO_GERACAO = 'Erro Geração'; // Defina o nome da sua coluna de erro aqui
        // if (errorMessage && COL_ERRO_GERACAO) {
        //     propertiesToUpdate[COL_ERRO_GERACAO] = { rich_text: [{ type: 'text', text: { content: errorMessage.substring(0, 2000) } }] }; // Limita tamanho
        // }

        await notion.pages.update({
            page_id: pageId,
            properties: propertiesToUpdate,
        });
        console.log(` -> Status da linha ${pageId} atualizado para "${status}".`);
        return true;
    } catch (error) {
        console.error(` ❌ Erro ao atualizar status/erro da página ${pageId} no Notion:`, error.code || error.body);
        return false;
    }
}


// --- Função Principal de Execução ---
async function main() {
    console.log('--- Iniciando Script de Geração de Boletos Cora ---');
    let successCount = 0;
    let failureCount = 0; // Falha na API Cora ou ao atualizar Notion após sucesso
    let skippedCount = 0; // Dados incompletos no Notion

    try {
        await createHttpsAgent(); // Cria o agente primeiro
        // await getAccessToken(); // Obtém o token - Removido daqui, será obtido dentro de generateCoraInvoice se necessário

        const pagesToProcess = await findRowsToGenerateBoleto();

        if (pagesToProcess.length === 0) {
            console.log('🏁 Nenhuma linha encontrada para processar.');
            return;
        }

        console.log('\n--- Processando Linhas ---');
        for (const page of pagesToProcess) {
            console.log(`\nProcessando linha Notion ID: ${page.id}`);
            const result = await generateCoraInvoice(page); // Retorna { status: 'success'|'error'|'skipped', data?, error? }

            if (result?.status === 'success') {
                const updateSuccess = await updateNotionPageSuccess(page.id, result.data);
                if (updateSuccess) {
                    successCount++;
                } else {
                    failureCount++; // Boleto gerado, mas falhou ao atualizar Notion
                    console.warn(`⚠️ Boleto gerado na Cora (ID: ${result.data?.id}) mas falhou ao atualizar Notion para a linha ${page.id}.`);
                }
            } else if (result?.status === 'error') {
                failureCount++; // Erro na API da Cora (Notion já atualizado com erro dentro de generateCoraInvoice)
            } else {
                skippedCount++; // Dados incompletos (Notion já atualizado com erro dentro de generateCoraInvoice)
            }

            // Pausa opcional para evitar limites de taxa (rate limiting)
            // await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 segundos
        }

    } catch (error) {
        console.error('\n🛑 Execução interrompida devido a erro crítico inicial (ex: certificados, token inicial).');
        // O erro já foi logado nas funções internas (createHttpsAgent, getAccessToken, findRowsToGenerateBoleto)
    } finally {
        console.log('\n--- Resumo da Execução ---');
        console.log(`✅ Boletos gerados e Notion atualizado: ${successCount}`);
        console.log(`⚠️ Linhas puladas (dados incompletos no Notion): ${skippedCount}`);
        console.log(`❌ Falhas (erro API Cora ou erro ao atualizar Notion): ${failureCount}`);
        console.log('--- Script Finalizado ---');
    }
}

// --- Ponto de Entrada ---
// Verifica dependências antes de rodar
try {
    require.resolve('@notionhq/client');
    require.resolve('axios');
    require.resolve('dotenv');
    require.resolve('crypto'); // Verifica se o módulo crypto está acessível

    main().catch(err => {
        // Captura erros não tratados na função main (embora ela já tenha um try...catch)
        console.error("🛑 Erro inesperado na execução principal:", err);
        process.exit(1); // Sai com código de erro
    });

} catch (e) {
    console.error('❌ Erro: Pacotes necessários não estão instalados ou módulo crypto não encontrado.');
    console.error(' Execute "npm install @notionhq/client axios dotenv"');
    console.error(' Verifique também se o Node.js está instalado corretamente.');
    console.error(' Erro original:', e.message);
    process.exit(1); // Sai com código de erro
}
