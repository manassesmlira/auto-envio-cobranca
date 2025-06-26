
# Quita Notion - Automação Financeira
## 📌 Módulos Principais
### 1. Integração Cora-Notion
#### Javascript
-- consultar_boleto_cora.js
-- Sincroniza boletos da Cora → Notion
-- Filtra por status "CANCELLED"
-- Atualiza database com novos IDs

### 2. Gerador de Boletos
#### Javascript
// gerar_boleto_cora.js
// Cria boletos na Cora baseado em:
// - Nome, CPF, Valor, Vencimento
// - Endereço (com validação via ViaCEP)
// Atualiza status para "Boleto OK"

### 3. Sistema de Lembretes
#### Javascript
// lembretes_zap.js
// Envia automaticamente:
// - WhatsApp: 5 e 2 dias antes do vencimento
// - E-mail: 5 dias antes (com PDF anexo)
// Mensagens personalizadas com emojis

### ⚙️ Configuração Obrigatória

.env (exemplo completo):

Ini
# NOTION
NOTION_TOKEN="secret_xxxxxxxx"
NOTION_DATABASE_ID="xxxxxxxxxx"

# CORA 
CORA_API_BASE_URL="https://api.cora.com.br"
CERT_FOLDER_PATH="./certificados"
CORA_CLIENT_ID="client_xxxx"

# WHATSAPP
WHASCALE_API_URL="https://api.whatsapp.com"
WASCRIPT_TOKEN="token_xxxxxx"

### 📂 Estrutura de Arquivos

/quita-notion

├── /certificados

│ ├── certificate.pem

│ └── private-key.key

├── /src

│ ├── consultarboletocora.js

│ ├── gerarboletocora.js

│ ├── lembretes_zap.js

│ └── webhook.js

└── .env

### 💻 Comandos Essenciais
Bash

#### Instalação
npm install @notionhq/client axios dotenv moment nodemailer

#### Execução
node src/gerar_boleto_cora.js --prod
node src/lembretes_zap.js --dry-run

### 🔍 Troubleshooting

Problema comum:

Log
Erro 403 na API Cora


Solução:

Bash
1. Verifique certificados em /certificados
2. Renove token .env
3. Valide horário do servidor
