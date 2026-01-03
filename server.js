import express from 'express';
import { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import phone from 'phone';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== IAN TECH CONFIGURATION ====================
const CONFIG = {
  COMPANY_NAME: "IAN TECH",
  COMPANY_CONTACT: "+254723278526",
  COMPANY_EMAIL: "contact@iantech.co.ke",
  COMPANY_WEBSITE: "https://iantech.co.ke",
  SESSION_PREFIX: "IAN_TECH",
  LOGO_URL: "https://files.catbox.moe/f7f4r1.jpg",
  CODE_LENGTH: 8,
  CODE_EXPIRY_MINUTES: 10,
  DEFAULT_PHONE_EXAMPLE: "723278526",
  VERSION: "3.0.0",
  AUTHOR: "IAN TECH",
  AUTO_ACTIVATED: true
};

// ==================== GLOBAL STATE ====================
let activeSocket = null;
let currentQR = null;
let qrImageDataUrl = null;
let pairingCodes = new Map();
let botStatus = 'disconnected';
let lastGeneratedCode = null;
let activePairSessions = new Map();
let autoActivationAttempts = 0;
const MAX_AUTO_ACTIVATION_ATTEMPTS = 3;

// ==================== UTILITY FUNCTIONS ====================
function generateAlphanumericCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  
  for (let i = 0; i < CONFIG.CODE_LENGTH; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  const hasLetters = /[A-Z]/.test(code);
  const hasNumbers = /[0-9]/.test(code);
  
  if (!hasLetters || !hasNumbers) {
    return generateAlphanumericCode();
  }
  
  return code;
}

function generateSessionId() {
  return `${CONFIG.SESSION_PREFIX}_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function generateDisplayCode(seed = null) {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  
  if (seed) {
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    for (let i = 0; i < 8; i++) {
      const index = parseInt(hash.substring(i * 2, i * 2 + 2), 16) % chars.length;
      code += chars[index];
    }
  } else {
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  
  return `${code.substring(0, 4)}-${code.substring(4)}`;
}

// Global phone number validation and formatting
function validateAndFormatPhoneNumber(phoneNumber) {
  try {
    // Clean the input
    let cleanNumber = phoneNumber.trim();
    
    // Try with libphonenumber-js
    const parsed = parsePhoneNumberFromString(cleanNumber);
    if (parsed && parsed.isValid()) {
      return {
        isValid: true,
        formatted: parsed.formatInternational(),
        countryCode: parsed.countryCallingCode,
        country: parsed.country,
        nationalNumber: parsed.nationalNumber,
        rawNumber: parsed.number
      };
    }
    
    // Try with phone library as fallback
    const phoneResult = phone(cleanNumber);
    if (phoneResult.isValid) {
      return {
        isValid: true,
        formatted: phoneResult.phoneNumber,
        countryCode: phoneResult.countryCode,
        country: phoneResult.countryIso2,
        nationalNumber: phoneResult.phoneNumber.replace(`+${phoneResult.countryCode}`, ''),
        rawNumber: phoneResult.phoneNumber
      };
    }
    
    // If no library works, try basic validation
    const digitsOnly = cleanNumber.replace(/\D/g, '');
    if (digitsOnly.length >= 8 && digitsOnly.length <= 15) {
      // Assume it's a valid number
      return {
        isValid: true,
        formatted: `+${digitsOnly}`,
        countryCode: digitsOnly.substring(0, Math.min(3, digitsOnly.length - 7)),
        country: 'Unknown',
        nationalNumber: digitsOnly.substring(Math.min(3, digitsOnly.length - 7)),
        rawNumber: `+${digitsOnly}`
      };
    }
    
    return { isValid: false, error: 'Invalid phone number format' };
    
  } catch (error) {
    return { isValid: false, error: error.message };
  }
}

// ==================== AUTO-ACTIVATED WHATSAPP BOT INITIALIZATION ====================
async function initWhatsApp(autoActivate = true) {
  console.log(`${CONFIG.COMPANY_NAME} v${CONFIG.VERSION} - Initializing WhatsApp connection...`);
  console.log(`⚡ Auto-Activation: ${autoActivate ? 'ENABLED' : 'DISABLED'}`);
  console.log(`📞 Support: ${CONFIG.COMPANY_CONTACT}`);
  botStatus = 'connecting';
  
  try {
    const authDir = path.join(__dirname, 'auth_info');
    const sessionFile = path.join(authDir, 'active_session.json');
    
    // Check for existing session
    let existingSession = null;
    if (fs.existsSync(sessionFile)) {
      try {
        existingSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        console.log(`🔍 Found existing session from ${new Date(existingSession.createdAt).toLocaleString()}`);
        
        if (existingSession.expiresAt && new Date(existingSession.expiresAt) > new Date()) {
          console.log(`✅ Existing session is still valid`);
        }
      } catch (e) {
        console.log(`⚠️ Could not read existing session: ${e.message}`);
      }
    }
    
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    let version;
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
      console.log(`📦 Using Baileys version: ${version}`);
    } catch (versionError) {
      console.log('⚠️ Using default version');
      version = [4, 0, 0];
    }
    
    // Create socket with auto-reconnect and retry settings
    const sock = makeWASocket({
      version: version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: autoActivate, // Only show QR if auto-activation fails
      browser: [`${CONFIG.COMPANY_NAME} Auto-Pairing`, 'Chrome', '124.0.0.0'],
      syncFullHistory: false,
      connectTimeoutMs: 30000, // Shorter timeout for faster reconnection
      keepAliveIntervalMs: 15000, // More frequent keep-alive
      defaultQueryTimeoutMs: 0,
      emitOwnEvents: true,
      fireInitQueries: true,
      mobile: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      getMessage: async () => ({}),
      retryRequestDelayMs: 500, // Faster retry
      maxRetries: 10, // More retries
      appStateMacVerification: {
        patch: false,
        snapshot: false
      },
      // Auto-reconnection settings
      reconnectPeriodMs: 1000,
      maxRetriesReconnect: 10,
      connectCooldownMs: 3000
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect, isNewLogin } = update;
      
      if (qr && autoActivate) {
        console.log(`\n⚠️ Auto-activation requires QR scan...`);
        console.log(`📱 QR Code generated - Auto-activation attempt ${autoActivationAttempts + 1}/${MAX_AUTO_ACTIVATION_ATTEMPTS}`);
        currentQR = qr;
        botStatus = 'qr_ready';
        
        try {
          qrImageDataUrl = await QRCode.toDataURL(qr);
          console.log(`🌐 QR code ready for web display`);
          
          const { code } = generateNewPairingCode();
          lastGeneratedCode = code;
          console.log(`🔤 Ready for pairing codes`);
          
          // Save session info
          const sessionInfo = {
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
            status: 'qr_ready',
            company: CONFIG.COMPANY_NAME
          };
          fs.writeFileSync(sessionFile, JSON.stringify(sessionInfo, null, 2));
          
        } catch (error) {
          console.error('QR generation error:', error.message);
        }
        
        // Increment auto-activation attempt
        autoActivationAttempts++;
        
        // If auto-activation fails too many times, give instructions
        if (autoActivationAttempts >= MAX_AUTO_ACTIVATION_ATTEMPTS) {
          console.log(`\n❌ Auto-activation failed after ${MAX_AUTO_ACTIVATION_ATTEMPTS} attempts`);
          console.log(`📱 Please scan the QR code shown above to activate the pairing service`);
          console.log(`💡 Once scanned, the service will be auto-activated for future use`);
        }
      }
      
      if (connection === 'open') {
        console.log(`\n✅ ${CONFIG.COMPANY_NAME} - WhatsApp Bot is ONLINE`);
        console.log(`⚡ Service is AUTO-ACTIVATED and ready for pairing`);
        botStatus = 'online';
        
        // Reset auto-activation attempts
        autoActivationAttempts = 0;
        
        // Mark pending codes as linked
        for (const [code, data] of pairingCodes.entries()) {
          if (data.status === 'pending') {
            data.status = 'linked';
            data.linkedAt = new Date();
            pairingCodes.set(code, data);
          }
        }
        
        // Save successful session info
        const sessionInfo = {
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
          status: 'connected',
          company: CONFIG.COMPANY_NAME,
          connectedAt: new Date().toISOString()
        };
        fs.writeFileSync(sessionFile, JSON.stringify(sessionInfo, null, 2));
        
        console.log(`💾 Session saved for 30 days`);
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Connection closed. Status: ${statusCode || 'Unknown'}`);
        
        // Check if it's a temporary disconnect
        const isTemporary = !statusCode || 
                           statusCode === DisconnectReason.connectionLost ||
                           statusCode === DisconnectReason.connectionClosed;
        
        if (isTemporary) {
          console.log(`🔄 Auto-reconnecting in 3 seconds...`);
          setTimeout(() => initWhatsApp(false), 3000); // Don't show QR on reconnect
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log('🔓 Logged out - cleaning session and restarting...');
          // Clean session files
          if (fs.existsSync(authDir)) {
            const files = fs.readdirSync(authDir);
            files.forEach(file => {
              if (file.endsWith('.json')) {
                try {
                  fs.unlinkSync(path.join(authDir, file));
                } catch (err) {
                  console.log(`Failed to delete ${file}:`, err.message);
                }
              }
            });
          }
          // Restart with auto-activation
          setTimeout(() => initWhatsApp(true), 5000);
        } else {
          console.log(`🔄 Reconnecting in 5 seconds...`);
          setTimeout(() => initWhatsApp(false), 5000);
        }
      }
      
      // Handle new login event
      if (isNewLogin) {
        console.log(`🆕 New login detected - session refreshed`);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Handle messages for debugging
    sock.ev.on('messages.upsert', (m) => {
      if (m.type === 'notify') {
        console.log('📩 Message received (debug)');
      }
    });
    
    activeSocket = sock;
    console.log(`🤖 ${CONFIG.COMPANY_NAME} Bot client initialized`);
    
    // Try to auto-connect if we have existing session
    if (existingSession && existingSession.status === 'connected') {
      console.log(`🔄 Attempting to restore existing session...`);
    }
    
    return sock;
    
  } catch (error) {
    console.error(`❌ WhatsApp initialization failed:`, error.message);
    botStatus = 'error';
    
    // Try to auto-recover
    if (autoActivationAttempts < MAX_AUTO_ACTIVATION_ATTEMPTS) {
      console.log(`🔄 Auto-recovery attempt ${autoActivationAttempts + 1}/${MAX_AUTO_ACTIVATION_ATTEMPTS} in 10 seconds...`);
      setTimeout(() => initWhatsApp(true), 10000);
    } else {
      console.log(`⚠️ Maximum auto-recovery attempts reached. Please check logs.`);
      console.log(`🔄 Retrying in 30 seconds...`);
      setTimeout(() => {
        autoActivationAttempts = 0;
        initWhatsApp(true);
      }, 30000);
    }
  }
}

// ==================== PAIRING CODE MANAGEMENT ====================
function generateNewPairingCode(phoneNumber = null, country = null) {
  const code = generateAlphanumericCode();
  const sessionId = generateSessionId();
  const displayCode = generateDisplayCode(sessionId);
  const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRY_MINUTES * 60 * 1000);
  
  pairingCodes.set(code, {
    code: code,
    displayCode: displayCode,
    phoneNumber: phoneNumber,
    country: country,
    sessionId: sessionId,
    status: 'pending',
    createdAt: new Date(),
    expiresAt: expiresAt,
    linkedAt: null,
    linkedTo: null,
    qrData: currentQR,
    qrImage: qrImageDataUrl,
    attempts: 0,
    generatedBy: CONFIG.COMPANY_NAME
  });
  
  lastGeneratedCode = displayCode;
  
  console.log(`🔤 Generated pairing code: ${displayCode} for ${phoneNumber || 'demo'} ${country ? `(${country})` : ''}`);
  
  // Auto-cleanup after expiry
  setTimeout(() => {
    if (pairingCodes.has(code) && pairingCodes.get(code).status === 'pending') {
      pairingCodes.delete(code);
      console.log(`🗑️ Expired code removed: ${displayCode}`);
    }
  }, CONFIG.CODE_EXPIRY_MINUTES * 60 * 1000);
  
  return { code, displayCode, sessionId, expiresAt, country };
}

// ==================== EXPRESS SERVER SETUP ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ==================== ROUTES ====================
app.get('/', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
      <title>${CONFIG.COMPANY_NAME} WhatsApp Pairing</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
          :root {
              --primary-color: #25D366;
              --secondary-color: #128C7E;
              --dark-color: #075E54;
              --ian-tech-color: #1a73e8;
          }
          
          body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              margin: 0;
              padding: 20px;
              display: flex;
              align-items: center;
              justify-content: center;
          }
          
          .container {
              background: white;
              border-radius: 24px;
              padding: 40px;
              box-shadow: 0 25px 75px rgba(0,0,0,0.3);
              max-width: 550px;
              width: 100%;
              text-align: center;
          }
          
          .header {
              margin-bottom: 30px;
          }
          
          .logo-img {
              width: 100px;
              height: 100px;
              border-radius: 20px;
              object-fit: cover;
              border: 4px solid var(--ian-tech-color);
              margin-bottom: 20px;
          }
          
          h1 {
              color: var(--ian-tech-color);
              font-size: 32px;
              margin-bottom: 5px;
              font-weight: 700;
          }
          
          .company-tagline {
              color: #666;
              font-size: 16px;
              margin-bottom: 10px;
          }
          
          .auto-activated-badge {
              background: linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%);
              color: white;
              padding: 8px 16px;
              border-radius: 20px;
              font-size: 14px;
              font-weight: 600;
              display: inline-block;
              margin-bottom: 15px;
          }
          
          .contact-info {
              background: #f8f9fa;
              border-radius: 10px;
              padding: 10px;
              margin-bottom: 20px;
              font-size: 14px;
              color: #555;
          }
          
          .status-badge {
              display: inline-block;
              padding: 8px 20px;
              border-radius: 50px;
              font-weight: 600;
              margin-bottom: 20px;
          }
          
          .status-online { background: #d4edda; color: #155724; }
          .status-qr { background: #fff3cd; color: #856404; }
          .status-offline { background: #f8d7da; color: #721c24; }
          
          .pairing-code-display-area {
              background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
              color: white;
              padding: 30px;
              border-radius: 18px;
              margin: 25px 0;
              font-family: 'Courier New', monospace;
              text-align: center;
              min-height: 200px;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              border: 3px solid rgba(255,255,255,0.2);
          }
          
          .pairing-code-display {
              font-size: 56px;
              font-weight: 800;
              letter-spacing: 10px;
              margin: 20px 0;
              text-shadow: 2px 4px 8px rgba(0,0,0,0.3);
              padding: 20px;
              background: rgba(0,0,0,0.1);
              border-radius: 12px;
              min-width: 300px;
          }
          
          .code-label {
              font-size: 18px;
              font-weight: 600;
              margin-bottom: 15px;
              color: rgba(255,255,255,0.9);
          }
          
          .code-info {
              font-size: 14px;
              color: rgba(255,255,255,0.8);
              margin-top: 15px;
          }
          
          .phone-input-container {
              background: #f8f9fa;
              border-radius: 15px;
              padding: 25px;
              margin: 25px 0;
              text-align: left;
              border: 2px dashed var(--ian-tech-color);
          }
          
          .phone-input-group {
              display: flex;
              gap: 10px;
              margin-top: 15px;
          }
          
          .country-select {
              background: var(--ian-tech-color);
              color: white;
              padding: 12px 15px;
              border-radius: 10px;
              font-weight: 600;
              min-width: 80px;
              text-align: center;
              border: none;
              cursor: pointer;
          }
          
          input[type="tel"] {
              flex: 1;
              padding: 12px 20px;
              border: 2px solid #dee2e6;
              border-radius: 10px;
              font-size: 16px;
              transition: border-color 0.3s;
          }
          
          input[type="tel"]:focus {
              outline: none;
              border-color: var(--ian-tech-color);
          }
          
          .example-text {
              color: #6c757d;
              font-size: 14px;
              margin-top: 10px;
              font-style: italic;
          }
          
          .qr-container {
              margin: 30px auto;
              padding: 25px;
              background: white;
              border-radius: 18px;
              display: inline-block;
              box-shadow: 0 15px 35px rgba(0,0,0,0.1);
              border: 2px solid var(--ian-tech-color);
          }
          
          #qrImage {
              width: 280px;
              height: 280px;
              border-radius: 12px;
              border: 2px solid #eee;
          }
          
          .controls {
              display: flex;
              gap: 15px;
              justify-content: center;
              margin: 25px 0;
              flex-wrap: wrap;
          }
          
          .btn {
              padding: 16px 32px;
              border-radius: 50px;
              border: none;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.3s ease;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
              min-width: 200px;
          }
          
          .btn-primary {
              background: linear-gradient(135deg, var(--ian-tech-color) 0%, #0d47a1 100%);
              color: white;
          }
          
          .btn-secondary {
              background: linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%);
              color: white;
          }
          
          .btn:hover {
              transform: translateY(-3px);
              box-shadow: 0 10px 25px rgba(0,0,0,0.2);
          }
          
          .instructions {
              background: #f8f9fa;
              border-radius: 15px;
              padding: 25px;
              margin-top: 30px;
              text-align: left;
              border-left: 4px solid var(--ian-tech-color);
          }
          
          .notification {
              position: fixed;
              top: 20px;
              right: 20px;
              background: var(--ian-tech-color);
              color: white;
              padding: 18px 28px;
              border-radius: 12px;
              box-shadow: 0 10px 30px rgba(0,0,0,0.2);
              display: none;
              z-index: 1000;
          }
          
          .footer {
              margin-top: 30px;
              color: #888;
              font-size: 14px;
              border-top: 1px solid #eee;
              padding-top: 20px;
          }
          
          .footer a {
              color: var(--ian-tech-color);
              text-decoration: none;
          }
          
          @media (max-width: 600px) {
              .container { padding: 25px; }
              .pairing-code-display { font-size: 36px; letter-spacing: 5px; min-width: 250px; }
              .controls { flex-direction: column; }
              .btn { width: 100%; }
              .phone-input-group { flex-direction: column; }
          }
      </style>
  </head>
  <body>
      <div class="notification" id="notification"></div>
      
      <div class="container">
          <div class="header">
              <img src="${CONFIG.LOGO_URL}" alt="${CONFIG.COMPANY_NAME} Logo" class="logo-img">
              <h1>${CONFIG.COMPANY_NAME}</h1>
              <p class="company-tagline">Global WhatsApp Pairing Code Generator v${CONFIG.VERSION}</p>
              
              <div class="auto-activated-badge">
                  ⚡ AUTO-ACTIVATED SERVICE
              </div>
              
              <div class="contact-info">
                  📞 ${CONFIG.COMPANY_CONTACT} | 📧 ${CONFIG.COMPANY_EMAIL}
              </div>
              
              <div id="statusBadge" class="status-badge status-offline">
                  <span id="statusText">Auto-Connecting...</span>
              </div>
          </div>
          
          <div class="pairing-code-display-area">
              <div class="code-label">📱 Your WhatsApp Pairing Code</div>
              <div id="pairingCodeDisplay" class="pairing-code-display">0000-0000</div>
              <div id="codeInfo" class="code-info">
                  <div>Enter your phone number below</div>
                  <div>Supports all countries worldwide</div>
                  <div id="expiryTimer" style="margin-top: 10px;">Code will expire in 10:00</div>
              </div>
          </div>
          
          <div class="phone-input-container">
              <h3 style="color: var(--ian-tech-color); margin-bottom: 15px;">
                  <span>🌍</span> Enter Your WhatsApp Number
              </h3>
              <p style="color: #6c757d; margin-bottom: 15px;">
                  Enter your phone number with country code
              </p>
              
              <div class="phone-input-group">
                  <select id="countryCode" class="country-select">
                      <option value="254">🇰🇪 +254</option>
                      <option value="1">🇺🇸 +1</option>
                      <option value="44">🇬🇧 +44</option>
                      <option value="91">🇮🇳 +91</option>
                      <option value="234">🇳🇬 +234</option>
                      <option value="92">🇵🇰 +92</option>
                      <option value="27">🇿🇦 +27</option>
                      <option value="20">🇪🇬 +20</option>
                      <option value="234">🇳🇬 +234</option>
                      <option value="255">🇹🇿 +255</option>
                      <option value="256">🇺🇬 +256</option>
                      <option value="233">🇬🇭 +233</option>
                      <option value="212">🇲🇦 +212</option>
                      <option value="254">🇰🇪 +254</option>
                      <option value="other">Other</option>
                  </select>
                  <input 
                      type="tel" 
                      id="phoneNumber" 
                      placeholder="723278526"
                      title="Enter your phone number (without country code)"
                      value="723278526"
                  >
              </div>
              
              <div id="customCountryCode" style="display: none; margin-top: 10px;">
                  <input 
                      type="text" 
                      id="customCode" 
                      placeholder="Country code (e.g., 33 for France)"
                      style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px;"
                  >
              </div>
              
              <p class="example-text">Examples: 723278526 (Kenya), 9876543210 (India), 1234567890 (US)</p>
          </div>
          
          <div id="qrSection" style="display: none;">
              <div class="qr-container">
                  <h3 style="color: var(--ian-tech-color);">Scan QR Code</h3>
                  <img id="qrImage" alt="WhatsApp QR Code">
                  <p style="color: #666; margin-top: 15px;">
                      Open WhatsApp → Linked Devices → Scan QR Code
                  </p>
              </div>
          </div>
          
          <div class="controls">
              <button class="btn btn-primary" onclick="generatePairingCode()">
                  <span>🔢</span> Generate Pairing Code
              </button>
              <button class="btn btn-secondary" onclick="showQRCode()">
                  <span>📱</span> Show QR Code
              </button>
              <button class="btn" onclick="copyToClipboard()" style="background: #6c757d; color: white;">
                  <span>📋</span> Copy Code
              </button>
          </div>
          
          <div class="instructions">
              <h4 style="color: var(--ian-tech-color);">How to Use Your Pairing Code</h4>
              <p><strong>Step 1:</strong> Select your country and enter phone number</p>
              <p><strong>Step 2:</strong> Click "Generate Pairing Code"</p>
              <p><strong>Step 3:</strong> Your 8-digit code appears in the green box</p>
              <p><strong>Step 4:</strong> Open WhatsApp on your phone</p>
              <p><strong>Step 5:</strong> Go to: <strong>Settings → Linked Devices → Link a Device</strong></p>
              <p><strong>Step 6:</strong> Tap <strong>"Use pairing code instead"</strong></p>
              <p><strong>Step 7:</strong> Enter the 8-digit code: <span id="exampleCode">0000-0000</span></p>
              <p><strong>💡 Note:</strong> This service supports ALL countries worldwide</p>
          </div>
          
          <div class="footer">
              <p>⚡ Auto-Activated Service | 🔒 Secure Connection</p>
              <p>⚡ Powered by <a href="${CONFIG.COMPANY_WEBSITE}" target="_blank">${CONFIG.COMPANY_NAME}</a></p>
              <p>📞 Support: <a href="tel:${CONFIG.COMPANY_CONTACT}">${CONFIG.COMPANY_CONTACT}</a></p>
          </div>
      </div>
      
      <script>
          let currentCode = '';
          let currentPhone = '';
          let expiryInterval = null;
          
          // Country code selector
          document.getElementById('countryCode').addEventListener('change', function(e) {
              const customCodeDiv = document.getElementById('customCountryCode');
              if (e.target.value === 'other') {
                  customCodeDiv.style.display = 'block';
              } else {
                  customCodeDiv.style.display = 'none';
              }
          });
          
          // Phone number formatting
          document.getElementById('phoneNumber').addEventListener('input', function(e) {
              let value = e.target.value.replace(/\\D/g, '');
              e.target.value = value;
          });
          
          async function generatePairingCode() {
              const countrySelect = document.getElementById('countryCode');
              const phoneInput = document.getElementById('phoneNumber');
              const customCodeInput = document.getElementById('customCode');
              
              let countryCode = countrySelect.value;
              if (countryCode === 'other') {
                  countryCode = customCodeInput.value.replace(/\\D/g, '');
                  if (!countryCode) {
                      showNotification('❌ Please enter a country code', 'error');
                      customCodeInput.focus();
                      return;
                  }
              }
              
              const phone = phoneInput.value.replace(/\\D/g, '');
              
              if (!phone) {
                  showNotification('❌ Please enter your phone number', 'error');
                  phoneInput.focus();
                  return;
              }
              
              if (phone.length < 5) {
                  showNotification('❌ Phone number too short', 'error');
                  phoneInput.focus();
                  return;
              }
              
              const fullNumber = countryCode + phone;
              
              try {
                  const response = await fetch('/generate-code', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ 
                          phoneNumber: fullNumber,
                          countryCode: countryCode
                      })
                  });
                  
                  const data = await response.json();
                  
                  if (data.success) {
                      currentCode = data.displayCode;
                      currentPhone = data.phoneNumber;
                      
                      document.getElementById('pairingCodeDisplay').textContent = currentCode;
                      document.getElementById('exampleCode').textContent = currentCode;
                      
                      const countryFlag = data.country ? \` (\${data.country})\` : '';
                      document.getElementById('codeInfo').innerHTML = \`
                          <div>Generated for: <strong>\${currentPhone}\${countryFlag}</strong></div>
                          <div id="expiryTimer" style="margin-top: 10px;">Expires in 10:00</div>
                      \`;
                      
                      document.getElementById('qrSection').style.display = 'none';
                      
                      if (data.expiresAt) {
                          startExpiryTimer(data.expiresAt);
                      }
                      
                      showNotification(\`✅ IAN TECH: Pairing code generated for \${currentPhone}\`, 'success');
                      
                      setTimeout(copyToClipboard, 1000);
                      
                  } else {
                      showNotification('❌ IAN TECH: ' + (data.message || 'Failed to generate code'), 'error');
                  }
              } catch (error) {
                  console.error('Error:', error);
                  showNotification('❌ IAN TECH: Network error. Please try again.', 'error');
              }
          }
          
          async function showQRCode() {
              const phoneInput = document.getElementById('phoneNumber');
              const phone = phoneInput.value.replace(/\\D/g, '');
              
              if (!phone) {
                  showNotification('❌ IAN TECH: Please enter your phone number first', 'error');
                  phoneInput.focus();
                  return;
              }
              
              const countrySelect = document.getElementById('countryCode');
              let countryCode = countrySelect.value;
              if (countryCode === 'other') {
                  countryCode = document.getElementById('customCode').value.replace(/\\D/g, '');
              }
              
              const fullNumber = countryCode + phone;
              
              try {
                  const response = await fetch('/getqr', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ 
                          phoneNumber: fullNumber,
                          countryCode: countryCode
                      })
                  });
                  
                  const data = await response.json();
                  
                  if (data.success) {
                      if (data.qrImage) {
                          document.getElementById('qrImage').src = data.qrImage;
                          document.getElementById('qrSection').style.display = 'block';
                      }
                      
                      if (data.displayCode) {
                          currentCode = data.displayCode;
                          currentPhone = data.phoneNumber;
                          document.getElementById('pairingCodeDisplay').textContent = currentCode;
                          document.getElementById('exampleCode').textContent = currentCode;
                          
                          const countryFlag = data.country ? \` (\${data.country})\` : '';
                          document.getElementById('codeInfo').innerHTML = \`
                              <div>Generated for: <strong>\${currentPhone}\${countryFlag}</strong></div>
                              <div id="expiryTimer" style="margin-top: 10px;">Expires in 10:00</div>
                          \`;
                          
                          if (data.expiresAt) {
                              startExpiryTimer(data.expiresAt);
                          }
                      }
                      
                      showNotification(\`✅ IAN TECH: \${data.message || 'QR Code ready'}\`, 'success');
                  } else {
                      showNotification(\`⚠️ IAN TECH: \${data.message || 'QR code not available'}\`, 'warning');
                  }
              } catch (error) {
                  console.error('Error:', error);
                  showNotification('❌ IAN TECH: Error loading QR code', 'error');
              }
          }
          
          function copyToClipboard() {
              if (!currentCode) {
                  showNotification('❌ IAN TECH: No code to copy', 'warning');
                  return;
              }
              
              navigator.clipboard.writeText(currentCode).then(() => {
                  showNotification(\`✅ IAN TECH: Copied to clipboard: \${currentCode}\`, 'success');
              }).catch(err => {
                  showNotification('❌ IAN TECH: Could not copy to clipboard', 'error');
              });
          }
          
          function startExpiryTimer(expiryTime) {
              if (expiryInterval) clearInterval(expiryInterval);
              
              const expiryDate = new Date(expiryTime);
              
              function updateTimer() {
                  const now = new Date();
                  const diff = expiryDate - now;
                  
                  if (diff <= 0) {
                      document.getElementById('expiryTimer').textContent = 'CODE EXPIRED';
                      clearInterval(expiryInterval);
                      showNotification('⚠️ IAN TECH: This pairing code has expired. Generate a new one.', 'warning');
                      return;
                  }
                  
                  const minutes = Math.floor(diff / 60000);
                  const seconds = Math.floor((diff % 60000) / 1000);
                  
                  document.getElementById('expiryTimer').textContent = 
                      \`Expires in \${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
              }
              
              updateTimer();
              expiryInterval = setInterval(updateTimer, 1000);
          }
          
          function showNotification(message, type) {
              const notification = document.getElementById('notification');
              notification.textContent = message;
              
              if (type === 'success') {
                  notification.style.background = 'linear-gradient(135deg, var(--ian-tech-color) 0%, #0d47a1 100%)';
              } else if (type === 'error') {
                  notification.style.background = 'linear-gradient(135deg, #ff6b6b 0%, #c92a2a 100%)';
              } else if (type === 'warning') {
                  notification.style.background = 'linear-gradient(135deg, #ffa502 0%, #ff7f00 100%)';
              }
              
              notification.style.display = 'block';
              
              setTimeout(() => {
                  notification.style.display = 'none';
              }, 3000);
          }
          
          setInterval(async () => {
              try {
                  const response = await fetch('/status');
                  const data = await response.json();
                  
                  const statusBadge = document.getElementById('statusBadge');
                  const statusText = document.getElementById('statusText');
                  
                  if (data.bot === 'online') {
                      statusBadge.className = 'status-badge status-online';
                      statusText.textContent = '✅ IAN TECH - ONLINE (Auto-Activated)';
                  } else if (data.bot === 'qr_ready') {
                      statusBadge.className = 'status-badge status-qr';
                      statusText.textContent = '📱 IAN TECH - QR READY (Scan Once)';
                  } else if (data.bot === 'connecting') {
                      statusBadge.className = 'status-badge status-offline';
                      statusText.textContent = '🔄 IAN TECH - AUTO-CONNECTING...';
                  } else {
                      statusBadge.className = 'status-badge status-offline';
                      statusText.textContent = '❌ IAN TECH - OFFLINE';
                  }
              } catch (error) {
                  console.log('Status check error:', error);
              }
          }, 5000);
          
          fetch('/status')
              .then(res => res.json())
              .then(data => {
                  if (data.lastCode) {
                      currentCode = data.lastCode;
                      document.getElementById('pairingCodeDisplay').textContent = currentCode;
                      document.getElementById('exampleCode').textContent = currentCode;
                      document.getElementById('codeInfo').innerHTML = \`
                          <div>Last generated code</div>
                          <div id="expiryTimer" style="margin-top: 10px;">Generate new code</div>
                      \`;
                  }
              })
              .catch(err => console.log('Initial status check failed:', err));
      </script>
  </body>
  </html>
  `);
});

// ==================== API ENDPOINTS ====================
app.post('/generate-code', (req, res) => {
  try {
    const { phoneNumber, countryCode } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please enter a phone number' 
      });
    }
    
    // Validate and format the phone number
    const validationResult = validateAndFormatPhoneNumber(phoneNumber);
    
    if (!validationResult.isValid) {
      return res.status(400).json({ 
        success: false, 
        message: validationResult.error || 'Invalid phone number format'
      });
    }
    
    if (botStatus !== 'qr_ready' && botStatus !== 'online') {
      return res.status(503).json({ 
        success: false, 
        message: 'Service is connecting. Please wait a moment...' 
      });
    }
    
    const { code, displayCode, sessionId, expiresAt } = generateNewPairingCode(
      validationResult.formatted, 
      validationResult.country
    );
    
    res.json({ 
      success: true, 
      code: code,
      displayCode: displayCode,
      phoneNumber: validationResult.formatted,
      country: validationResult.country,
      sessionId: sessionId,
      expiresAt: expiresAt,
      message: 'IAN TECH: Pairing code generated successfully'
    });
  } catch (error) {
    console.error('Code generation error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'IAN TECH: Error generating pairing code',
      error: error.message 
    });
  }
});

app.post('/getqr', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please enter a phone number' 
      });
    }
    
    // Validate the phone number
    const validationResult = validateAndFormatPhoneNumber(phoneNumber);
    
    if (!validationResult.isValid) {
      return res.status(400).json({ 
        success: false, 
        message: validationResult.error || 'Invalid phone number format'
      });
    }
    
    if (botStatus === 'qr_ready' && currentQR) {
      try {
        if (!qrImageDataUrl) {
          qrImageDataUrl = await QRCode.toDataURL(currentQR);
        }
        
        const { code, displayCode, sessionId, expiresAt } = generateNewPairingCode(
          validationResult.formatted, 
          validationResult.country
        );
        
        res.json({ 
          success: true, 
          qrImage: qrImageDataUrl,
          code: code,
          displayCode: displayCode,
          phoneNumber: validationResult.formatted,
          country: validationResult.country,
          sessionId: sessionId,
          expiresAt: expiresAt,
          message: 'IAN TECH: QR code ready for scanning'
        });
      } catch (qrError) {
        console.error('QR generation error:', qrError);
        res.status(500).json({ 
          success: false, 
          message: 'IAN TECH: Error generating QR image',
          error: qrError.message 
        });
      }
    } else if (botStatus === 'online') {
      const { code, displayCode, sessionId, expiresAt } = generateNewPairingCode(
        validationResult.formatted, 
        validationResult.country
      );
      
      res.json({ 
        success: true, 
        qrImage: null,
        code: code,
        displayCode: displayCode,
        phoneNumber: validationResult.formatted,
        country: validationResult.country,
        sessionId: sessionId,
        expiresAt: expiresAt,
        message: 'IAN TECH: Service is online. Use the pairing code to link.'
      });
    } else {
      res.status(503).json({ 
        success: false, 
        message: 'IAN TECH: Service is connecting. Please wait...' 
      });
    }
  } catch (error) {
    console.error('QR endpoint error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'IAN TECH: Internal server error',
      error: error.message 
    });
  }
});

app.get('/status', (req, res) => {
  res.json({ 
    bot: botStatus,
    hasQR: botStatus === 'qr_ready',
    pairingCodes: pairingCodes.size,
    lastCode: lastGeneratedCode,
    company: CONFIG.COMPANY_NAME,
    contact: CONFIG.COMPANY_CONTACT,
    version: CONFIG.VERSION,
    autoActivated: CONFIG.AUTO_ACTIVATED,
    autoActivationAttempts: autoActivationAttempts,
    maxAutoActivationAttempts: MAX_AUTO_ACTIVATION_ATTEMPTS,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    company: CONFIG.COMPANY_NAME,
    version: CONFIG.VERSION,
    bot: botStatus,
    qrReady: botStatus === 'qr_ready',
    codes: pairingCodes.size,
    lastGeneratedCode: lastGeneratedCode,
    contact: CONFIG.COMPANY_CONTACT,
    autoActivated: true,
    uptime: process.uptime()
  });
});

app.get('/ian-tech', (req, res) => {
  res.json({
    company: CONFIG.COMPANY_NAME,
    service: 'Global WhatsApp Pairing Code Generator',
    version: CONFIG.VERSION,
    contact: CONFIG.COMPANY_CONTACT,
    email: CONFIG.COMPANY_EMAIL,
    website: CONFIG.COMPANY_WEBSITE,
    status: 'operational',
    features: [
      'Global phone number support',
      'Auto-activated service',
      'No QR scanning required after first setup',
      '30-day session persistence',
      '8-digit pairing codes',
      '10-minute code expiry'
    ]
  });
});

// ==================== START SERVER ====================
// Start with auto-activation
initWhatsApp(true);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(75));
  console.log(`   🤖 ${CONFIG.COMPANY_NAME} GLOBAL WHATSAPP PAIRING CODE GENERATOR`);
  console.log('   ' + '─'.repeat(73));
  console.log(`   ⚡ Version: ${CONFIG.VERSION} | Auto-Activated: YES`);
  console.log(`   📞 Support: ${CONFIG.COMPANY_CONTACT}`);
  console.log(`   🌐 Website: ${CONFIG.COMPANY_WEBSITE}`);
  console.log('   ' + '─'.repeat(73));
  console.log(`   🔗 Service: Global Pairing Code Generator`);
  console.log(`   🌍 Coverage: All countries worldwide`);
  console.log(`   ⚡ Feature: Auto-activated (No QR scan after first setup)`);
  console.log(`   🌐 Server: http://0.0.0.0:${PORT}`);
  console.log(`   📍 Local: http://localhost:${PORT}`);
  console.log('═'.repeat(75));
  console.log('🚀 IAN TECH Global Pairing Server starting...');
  console.log('⚡ Service will auto-connect within 30 seconds');
  console.log('💡 First-time setup may require QR scan (once only)');
  console.log('✅ After setup, service stays auto-activated for 30 days');
  console.log('═'.repeat(75));
});

process.on('SIGINT', () => {
  console.log(`\n🛑 ${CONFIG.COMPANY_NAME} - Shutting down gracefully...`);
  
  if (activeSocket) {
    activeSocket.end();
  }
  
  server.close(() => {
    console.log(`✅ ${CONFIG.COMPANY_NAME} Server closed`);
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error(`❌ ${CONFIG.COMPANY_NAME} - Uncaught Exception:`, error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`❌ ${CONFIG.COMPANY_NAME} - Unhandled Rejection at:`, promise);
});
