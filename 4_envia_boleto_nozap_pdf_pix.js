const { Client } = require("@notionhq/client");
require('dotenv').config();

// Configuração do Notion
const notion = new Client({
    auth: process.env.NOTION_API_KEY,
});

const database_id = process.env.NOTION_DATABASE_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const CORA_API_KEY = process.env.CORA_API_KEY;
const NOTION_URL = process.env.NOTION_URL;

// ===============================
// Função de busca otimizada - Apenas mês atual
// ===============================
async function buscarBoletosPendentes() {
    console.log('🔍 Buscando boletos pendentes do mês atual no Notion...');
    
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
    const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().split('T')[0];
    
    let allResults = [];
    let cursor = undefined;
    let pageCount = 0;
    
    try {
        do {
            pageCount++;
            
            const query = {
                database_id: database_id,
                filter: {
                    and: [
                        {
                            property: "Status",
                            select: {
                                equals: "Pendente"
                            }
                        },
                        {
                            property: "Vecto",
                            date: {
                                on_or_after: inicioMes
                            }
                        },
                        {
                            property: "Vecto",
                            date: {
                                on_or_before: fimMes
                            }
                        }
                    ]
                },
                page_size: 100
            };
            
            if (cursor) {
                query.start_cursor = cursor;
            }
            
            const response = await notion.databases.query(query);
            allResults = allResults.concat(response.results);
            cursor = response.next_cursor;
            
            console.log(`📄 Página ${pageCount}: ${response.results.length} registros | Total: ${allResults.length}`);
            
        } while (cursor);
        
        const uniqueResults = allResults.filter((item, index, self) => 
            index === self.findIndex(t => t.id === item.id)
        );
        
        console.log(`✅ Busca finalizada: ${uniqueResults.length} boletos do mês atual encontrados\n`);
        
        return uniqueResults;
        
    } catch (error) {
        console.error('❌ Erro na busca:', error.message);
        return [];
    }
}

// ===============================
// Função de verificação de pagamento no Cora
// ===============================
async function verificarPagamentoCora(idCora) {
    try {
        const response = await fetch(`https://api.cora.com.br/v1/billing/invoices/${idCora}`, {
            headers: {
                'Authorization': `Bearer ${CORA_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            return { pago: false, erro: `Status ${response.status}` };
        }

        const data = await response.json();
        return { 
            pago: data.status === 'paid',
            status: data.status 
        };
    } catch (error) {
        return { pago: false, erro: error.message };
    }
}

// ===============================
// Função de atualização do Notion
// ===============================
async function atualizarStatusNotion(pageId, novoStatus, ultimoLembrete = null) {
    try {
        const updateData = {
            page_id: pageId,
            properties: {
                "Status": {
                    select: {
                        name: novoStatus
                    }
                }
            }
        };

        if (ultimoLembrete) {
            updateData.properties["Último Lembrete"] = {
                date: {
                    start: ultimoLembrete
                }
            };
        }

        await notion.pages.update(updateData);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao atualizar Notion: ${error.message}`);
        return false;
    }
}

// ===============================
// Função de envio WhatsApp
// ===============================
async function enviarWhatsApp(telefone, mensagem) {
    try {
        const phoneNumber = telefone.replace(/\D/g, '');
        
        const response = await fetch(`https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: phoneNumber,
                type: "text",
                text: { body: mensagem }
            })
        });

        return response.ok;
    } catch (error) {
        console.error(`❌ Erro WhatsApp: ${error.message}`);
        return false;
    }
}

// ===============================
// Função de envio de Email
// ===============================
async function enviarEmail(email, assunto, corpo) {
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'Clube de Pregadores <noreply@clubedepregadores.com.br>',
                to: [email],
                subject: assunto,
                html: corpo
            })
        });

        return response.ok;
    } catch (error) {
        console.error(`❌ Erro Email: ${error.message}`);
        return false;
    }
}

// ===============================
// Função de envio de relatório
// ===============================
async function enviarRelatorio(stats, semTelefone) {
    const relatorio = `
        <h2>📊 Relatório de Execução - Script de Lembretes</h2>
        <p><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
        
        <h3>📈 Estatísticas Gerais:</h3>
        <ul>
            <li><strong>Total processados:</strong> ${stats.processados}</li>
            <li><strong>Pagamentos confirmados:</strong> ${stats.pagos}</li>
            <li><strong>WhatsApp enviados:</strong> ${stats.lembretesEnviados}</li>
            <li><strong>E-mails enviados:</strong> ${stats.emailsEnviados}</li>
            <li><strong>Já enviados hoje:</strong> ${stats.jaEnviados}</li>
            <li><strong>Registros pulados:</strong> ${stats.pulados}</li>
            <li><strong>Erros:</strong> ${stats.erros}</li>
        </ul>
        
        <h3>📱 Alunos sem telefone (WhatsApp não enviado):</h3>
        ${semTelefone.length > 0 ? 
            '<ul>' + semTelefone.map(nome => `<li>${nome}</li>`).join('') + '</ul>' :
            '<p>Todos os alunos possuem telefone cadastrado.</p>'
        }
        
        <hr>
        <p><small>Relatório automático - Clube de Pregadores</small></p>
    `;

    await enviarEmail(
        'pregadormanasses@gmail.com', 
        '📊 Relatório - Script de Lembretes', 
        relatorio
    );
}

// ===============================
// Função principal de processamento
// ===============================
async function processarRegistros(registros) {
    const hoje = new Date();
    const hoje_iso = hoje.toISOString().split('T')[0];
    
    let stats = {
        processados: 0,
        pagos: 0,
        lembretesEnviados: 0,
        emailsEnviados: 0,
        jaEnviados: 0,
        pulados: 0,
        erros: 0
    };

    let semTelefone = [];

    console.log(`🚀 Processando ${registros.length} registros do mês atual...`);
    console.log('='.repeat(50));

    for (let i = 0; i < registros.length; i++) {
        const registro = registros[i];
        stats.processados++;

        if (stats.processados % 50 === 1 || stats.processados === registros.length) {
            const percentual = Math.round((stats.processados / registros.length) * 100);
            console.log(`📋 Progresso: ${stats.processados}/${registros.length} (${percentual}%)`);
        }

        try {
            const properties = registro.properties;
            const nome = properties.Nome?.title?.[0]?.text?.content || 'Nome não informado';
            let telefone = properties.Whatsapp?.phone_number || properties.Telefone?.phone_number || '';
            const email = properties.Email?.email || '';
            const valor = properties.Valor?.number || 0;
            const vencimento = properties.Vecto?.date?.start || '';
            const linkBoleto = properties['Link Boleto']?.url || '';
            const pix = properties.PIX?.rich_text?.[0]?.text?.content || '';
            const idCora = properties['ID Cora']?.rich_text?.[0]?.text?.content || '';
            const ultimoLembrete = properties['Último Lembrete']?.date?.start || null;

            // Validações básicas
            if (!nome || nome === 'Nome não informado' || !vencimento || !idCora) {
                stats.pulados++;
                continue;
            }

            // Verificar se já foi pago
            const statusPagamento = await verificarPagamentoCora(idCora);
            if (statusPagamento.pago) {
                await atualizarStatusNotion(registro.id, 'Pago');
                stats.pagos++;
                continue;
            }

            // Calcular dias para vencimento
            const dataVencimento = new Date(vencimento);
            const diasParaVencimento = Math.ceil((dataVencimento - hoje) / (1000 * 60 * 60 * 24));

            // Verificar se precisa enviar lembrete (hoje, 2 dias antes, ou atrasado do mês atual)
            const deveEnviar = (
                (diasParaVencimento === 2) || // 2 dias antes
                (diasParaVencimento === 0) || // Hoje
                (diasParaVencimento < 0)      // Atrasado (qualquer atraso do mês atual)
            );

            // Verificar se já enviou hoje
            const jaEnviouHoje = ultimoLembrete === hoje_iso;

            if (!deveEnviar || jaEnviouHoje) {
                if (jaEnviouHoje) stats.jaEnviados++;
                continue;
            }

            // Preparar mensagens
            let mensagemWhatsApp;
            if (diasParaVencimento > 0) {
                // Vence em dias
                mensagemWhatsApp = `🚨 *LEMBRETE DE PAGAMENTO* 🚨

Olá ${nome}!

Seu boleto de R$ ${valor.toFixed(2)} vence em ${diasParaVencimento} dias!

💳 *Link do Boleto:*
${linkBoleto}

📱 *PIX Copia e Cola:*
${pix}

Por favor, efetue o pagamento para manter seu acesso ativo.

_Mensagem automática - Clube de Pregadores_`;
            } else if (diasParaVencimento === 0) {
                // Vence hoje
                mensagemWhatsApp = `🚨 *PAGAMENTO VENCE HOJE* 🚨

Olá ${nome}!

Seu boleto de R$ ${valor.toFixed(2)} vence HOJE!

💳 *Link do Boleto:*
${linkBoleto}

📱 *PIX Copia e Cola:*
${pix}

Por favor, efetue o pagamento hoje para evitar juros e multa.

_Mensagem automática - Clube de Pregadores_`;
            } else {
                // Atrasado
                const diasAtraso = Math.abs(diasParaVencimento);
                mensagemWhatsApp = `⚠️ *PAGAMENTO EM ATRASO* ⚠️

Olá ${nome}!

Seu boleto de R$ ${valor.toFixed(2)} está em atraso há ${diasAtraso} dias.

💳 *Link do Boleto:*
${linkBoleto}

📱 *PIX Copia e Cola:*
${pix}

Por favor, efetue o pagamento o quanto antes para evitar juros e multa e manter seu acesso ativo.

Caso já tenha pago, desconsidere esta mensagem.

_Mensagem automática - Clube de Pregadores_`;
            }

            // Enviar WhatsApp
            let whatsappEnviado = false;
            if (telefone) {
                whatsappEnviado = await enviarWhatsApp(telefone, mensagemWhatsApp);
                if (whatsappEnviado) stats.lembretesEnviados++;
            } else {
                console.log(`📱 ${nome}: sem telefone, WhatsApp não enviado`);
                semTelefone.push(nome);
            }

            // Enviar email se disponível  
            let emailEnviado = false;
            if (email) {
                const status = diasParaVencimento > 0 ? 'vence' : diasParaVencimento === 0 ? 'vence hoje' : 'em atraso';
                const corpoEmail = `<h2>🚨 LEMBRETE DE PAGAMENTO</h2><p>Olá <strong>${nome}</strong>!</p><p>Seu boleto de <strong>R$ ${valor.toFixed(2)}</strong> ${status}.</p>`;
                
                emailEnviado = await enviarEmail(email, `🚨 Lembrete: Pagamento ${status}`, corpoEmail);
                if (emailEnviado) stats.emailsEnviados++;
            }

            // Atualizar último lembrete se pelo menos um envio foi bem-sucedido
            if (whatsappEnviado || emailEnviado) {
                await atualizarStatusNotion(registro.id, 'Pendente', hoje_iso);
            }

            // Delay entre processamentos
            if (i < registros.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (error) {
            console.error(`❌ Erro no registro ${stats.processados}: ${error.message}`);
            stats.erros++;
        }
    }

    // Enviar relatório por email
    await enviarRelatorio(stats, semTelefone);

    return stats;
}

// ===============================
// Função principal
// ===============================
async function main() {
    const inicioExecucao = new Date();
    
    console.log('🚀 Executando script - Lembretes do Mês Atual...');
    console.log(`🕐 Horário: ${inicioExecucao.toLocaleString('pt-BR')}\n`);

    try {
        const registros = await buscarBoletosPendentes();
        
        if (registros.length === 0) {
            console.log('ℹ️ Nenhum boleto pendente do mês atual encontrado.');
            return;
        }

        const stats = await processarRegistros(registros);

        console.log('='.repeat(50));
        console.log('📊 RESUMO FINAL:');
        console.log(`📋 Processados: ${stats.processados}`);
        console.log(`✅ Pagos: ${stats.pagos}`);
        console.log(`📤 WhatsApp enviados: ${stats.lembretesEnviados}`);
        console.log(`📧 E-mails enviados: ${stats.emailsEnviados}`);
        console.log(`📊 Relatório enviado para: pregadormanasses@gmail.com`);

    } catch (error) {
        console.error('❌ Erro geral:', error);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main, buscarBoletosPendentes, processarRegistros };
