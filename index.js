const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3333;
const certDir = path.join(__dirname, 'cert_key_cora_production_2025_04_29');
const API_SECRET_INDEX = process.env.API_SECRET_INDEX || 'parangaricutirimirruaru';

// Função para autenticar API Key
function authenticateApiKey(req, res, next) {
    const chave = req.headers['x-api-key'] || req.query.secret;
    if (!chave || chave !== API_SECRET_INDEX) {
        return res.status(401).json({ erro: 'Não autorizado!' });
    }
    next();
}

// Função para registrar processamento de boletos
function logProcessamento() {
    try {
        const logEntry = `${new Date().toISOString()} - BOLETOS_PROCESSADOS - Success\n`;
        fs.appendFileSync('./processamento-log.txt', logEntry);
        console.log('📝 Log de processamento registrado:', new Date().toISOString());
    } catch (error) {
        console.error('Erro ao salvar log:', error);
    }
}

// Função assíncrona: garante existência do diretório e dos arquivos de certificado/chave
async function prepararArquivosCertificado() {
    // 1. Diretório
    if (!fs.existsSync(certDir)) {
        fs.mkdirSync(certDir, { recursive: true });
    }
    // 2. Certificado
    const certPath = path.join(certDir, 'certificate.pem');
    if (process.env.CERTIFICATE_FILENAME) {
        await fs.promises.writeFile(certPath, process.env.CERTIFICATE_FILENAME, { encoding: 'utf8', mode: 0o600 });
        console.log('Arquivo certificate.pem criado com sucesso!');
    }
    // 3. Chave
    const keyPath = path.join(certDir, 'private-key.key');
    if (process.env.PRIVATE_KEY_FILENAME) {
        await fs.promises.writeFile(keyPath, process.env.PRIVATE_KEY_FILENAME, { encoding: 'utf8', mode: 0o600 });
        console.log('Arquivo private-key.key criado com sucesso!');
    }
}

// Função para garantir que certificado e chave já estão prontos no filesystem
function garantirArquivosProntos() {
    const certPath = path.join(certDir, 'certificate.pem');
    const keyPath = path.join(certDir, 'private-key.key');
    const certOk = fs.existsSync(certPath);
    const keyOk = fs.existsSync(keyPath);
    if (!certOk || !keyOk) {
        const msg = "Certificado ou chave ainda não estão prontos no filesystem. Bloqueando execução dos scripts.";
        console.error(msg);
        throw new Error(msg);
    }
    // Leitura (fail fast)
    try {
        fs.readFileSync(certPath);
        fs.readFileSync(keyPath);
    } catch (e) {
        const msg = "Erro ao ler arquivos de certificado/chave. Bloqueando execução.";
        console.error(msg, e);
        throw new Error(msg);
    }
}

// Utilidade robusta para execução de scripts exportando função async (com log adicional)
async function runScript(file) {
    try {
        console.log(`\n==> Executando: ${file}`);
        const scriptFunc = require(`./${file}`);
        if (typeof scriptFunc === 'function') {
            const inicio = Date.now();
            console.log(`[${file}] Chamando função principal exportada...`);
            await scriptFunc();
            const duracao = ((Date.now() - inicio) / 1000).toFixed(2);
            console.log(`✅ Finalizado: ${file} (em ${duracao}s)`);
        } else {
            console.warn(`⚠️ O script ${file} não exporta uma função! Pule ou ajuste a estrutura.`);
        }
    } catch (error) {
        console.error(`❌ Erro ao executar ${file}:`, error, error?.stack);
    }
}

// Função principal: executa scripts de 1 a 4 de modo confiável
async function executarScriptsSequenciais() {
    const scripts = [
        '1_puxar_boletos_cora.js',
        '2_marcar_quitados.js',
        '3_cancelarBoletosPagos.js',
        '4_envia_boleto_nozap_pdf_pix.js'
    ];
    for (const script of scripts) {
        await runScript(script);
    }
    console.log('🚀 Todos os scripts rodaram sequencialmente!\n');
}

app.use(cors());
app.use(express.json());

// Mostra status se app está "pronto" (arquivos criados) no GET /
app.get('/', (req, res) => {
    try {
        garantirArquivosProntos();
        res.send('Quita Notion worker online e PRONTO PARA PROCESSAR.');
    } catch (e) {
        res.send('Quita Notion worker ONLINE MAS INICIALIZANDO. Aguarde e tente novamente.');
    }
});

// Novo endpoint para verificar se boletos foram processados recentemente
app.get('/status/last-processing', authenticateApiKey, async (req, res) => {
    try {
        console.log('🔍 Verificando status do último processamento...');
        
        // Verificar se houve processamento nas últimas 2 horas
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const logFile = './processamento-log.txt';
        
        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8');
            const lines = logs.split('\n').filter(line => line.trim());
            
            // Verificar se há log de processamento recente
            const recentProcessing = lines.some(line => {
                if (line.includes('BOLETOS_PROCESSADOS')) {
                    const timestampMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
                    if (timestampMatch) {
                        const processingTime = new Date(timestampMatch[0]);
                        return processingTime > twoHoursAgo;
                    }
                }
                return false;
            });
            
            console.log(`📊 Processamento executado recentemente: ${recentProcessing}`);
            
            return res.json({
                processing_executed_recently: recentProcessing,
                last_check: new Date().toISOString(),
                status: 'success',
                check_period: '2 hours'
            });
        }
        
        // Se não há arquivo de log, assume que não foi processado
        console.log('⚠️ Arquivo de log não encontrado');
        res.json({
            processing_executed_recently: false,
            last_check: new Date().toISOString(),
            status: 'no_log_file',
            check_period: '2 hours'
        });
        
    } catch (error) {
        console.error('❌ Erro ao verificar status do processamento:', error);
        res.status(500).json({
            processing_executed_recently: false,
            error: 'Erro interno do servidor',
            status: 'error'
        });
    }
});

// ROTA SEGURA para execução sob demanda dos scripts sequenciais
app.post('/processar-lembretes', authenticateApiKey, async (req, res) => {
    console.log('🚀 Iniciando processamento de lembretes...');
    
    try {
        garantirArquivosProntos();
        
        console.log('📋 Executando scripts sequenciais...');
        await executarScriptsSequenciais();
        
        // Registrar que o processamento foi executado com sucesso
        logProcessamento();
        
        console.log('✅ Scripts finalizados com sucesso!');
        res.json({ 
            status: 'OK', 
            mensagem: 'Scripts finalizados com sucesso.',
            processing_executed: true,
            timestamp: new Date().toISOString()
        });
        
    } catch (err) {
        console.error('❌ Erro na execução dos scripts:', err, err?.stack);
        res.status(500).json({ 
            status: 'ERRO', 
            mensagem: err.message,
            processing_executed: false,
            timestamp: new Date().toISOString()
        });
    }
});

// Só começa a ouvir requests DEPOIS que arquivos foram criados!
prepararArquivosCertificado().then(() => {
    app.listen(PORT, () => {
        console.log(`🌐 Servidor ouvindo na porta ${PORT} (mantendo serviço ativo para Render Free Plan).`);
    });
}).catch((e) => {
    console.error('Falha ao preparar arquivos essenciais:', e);
    process.exit(1); // falha fatal, não inicia app!
});
