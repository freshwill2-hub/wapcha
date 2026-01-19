import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import FormData from 'form-data';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

// ==================== ë¡œê·¸ ì‹œìŠ¤í…œ ì„¤ì • ====================
const SYDNEY_TIMEZONE = 'Australia/Sydney';
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_RETENTION_DAYS = 5;  // ✅ 5일간만 로그 보관

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getSydneyTime() {
    return new Date().toLocaleString('en-AU', { 
        timeZone: SYDNEY_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function getSydneyTimeForFile() {
    const now = new Date();
    const sydneyDate = new Date(now.toLocaleString('en-US', { timeZone: SYDNEY_TIMEZONE }));
    const year = sydneyDate.getFullYear();
    const month = String(sydneyDate.getMonth() + 1).padStart(2, '0');
    const day = String(sydneyDate.getDate()).padStart(2, '0');
    const hour = String(sydneyDate.getHours()).padStart(2, '0');
    const min = String(sydneyDate.getMinutes()).padStart(2, '0');
    const sec = String(sydneyDate.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}_${hour}-${min}-${sec}`;
}

// ✅ 오래된 로그 자동 삭제 함수
function cleanupOldLogs() {
    const now = Date.now();
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const deletedFiles = [];
    try {
        const files = fs.readdirSync(LOG_DIR);
        for (const file of files) {
            if (!file.endsWith('.log')) continue;
            const filePath = path.join(LOG_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    deletedFiles.push(file);
                }
            } catch (error) {}
        }
    } catch (error) {}
    return deletedFiles;
}

// ✅ 시작 시 오래된 로그 삭제
const deletedLogs = cleanupOldLogs();

const LOG_FILENAME = `phase1_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(...args) {
    const timestamp = `[${getSydneyTime()}]`;
    const message = args.join(' ');
    console.log(timestamp, message);
    logStream.write(`${timestamp} ${message}\n`);
}

// ==================== ì„¤ì • ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mufuxqsjgqcvh80';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// âœ… ë©”ëª¨ë¦¬ ê´€ë¦¬ ì„¤ì •
const BATCH_SIZE = 10;
const MEMORY_CHECK_INTERVAL = 5;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

log('ðŸš€ Phase 1: ì œí’ˆ ìƒì„¸ ìŠ¤í¬ëž˜í•‘ (v2.4 - URL ë³€í™˜ ì œê±°)');
log('='.repeat(70));
log('ðŸ”§ ì„¤ì • í™•ì¸:');
log(`- NocoDB URL: ${NOCODB_API_URL}`);
log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}`);
log(`- OpenAI API: ${OPENAI_API_KEY ? 'âœ… ì„¤ì •ë¨' : 'âŒ ì—†ìŒ'}`);
log(`- ì‹œê°„ëŒ€: ${SYDNEY_TIMEZONE} (ì‹œë“œë‹ˆ)`);
log(`- ë¡œê·¸ íŒŒì¼: ${LOG_PATH}`);
if (deletedLogs.length > 0) {
    log(`🧹 오래된 로그 ${deletedLogs.length}개 삭제됨 (${LOG_RETENTION_DAYS}일 이상)`);
}
log('');
log('ðŸ†• v2.4 ìˆ˜ì • ì‚¬í•­:');
log('   âœ… URL ë³€í™˜ ì™„ì „ ì œê±°! ì›ë³¸ ì¸ë„¤ì¼ URL ê·¸ëŒ€ë¡œ ì‚¬ìš©');
log('   âœ… ì˜¬ë¦¬ë¸Œì˜ì€ /thumbnails/ ê²½ë¡œê°€ ì‹¤ì œ ì´ë¯¸ì§€ URL');
log('   âœ… v2.3ì—ì„œ ë³€í™˜ ì‹œ 404 ì—ëŸ¬ ë°œìƒ â†’ ë³€í™˜ ì œê±°ë¡œ í•´ê²°');
log('');

// ==================== ì „ì—­ ë³€ìˆ˜ ====================
let processedCount = 0;
let successCount = 0;
let skippedCount = 0;
let failedCount = 0;

const stats = {
    titleKrFilled: 0,
    titleEnFilled: 0,
    priceFilled: 0,
    descriptionFilled: 0,
    imagesFilled: 0,
    titleKrSkipped: 0,
    titleEnSkipped: 0,
    priceSkipped: 0,
    descriptionSkipped: 0,
    imagesSkipped: 0,
    imagesDownloadFailed: 0,
    images404Skipped: 0
};

// ==================== ë©”ëª¨ë¦¬ ê´€ë¦¬ í•¨ìˆ˜ ====================
function getMemoryUsage() {
    const used = process.memoryUsage();
    return {
        rss: Math.round(used.rss / 1024 / 1024),
        heapTotal: Math.round(used.heapTotal / 1024 / 1024),
        heapUsed: Math.round(used.heapUsed / 1024 / 1024),
        external: Math.round(used.external / 1024 / 1024)
    };
}

function logMemoryUsage(label = '') {
    const mem = getMemoryUsage();
    log(`ðŸ“Š ë©”ëª¨ë¦¬ ${label}: RSS=${mem.rss}MB, Heap=${mem.heapUsed}/${mem.heapTotal}MB`);
}

async function forceGarbageCollection() {
    if (global.gc) {
        global.gc();
        log('ðŸ§¹ ê°€ë¹„ì§€ ì»¬ë ‰ì…˜ ì‹¤í–‰ë¨');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
}

// ==================== í•„ë“œ ì²´í¬ í•¨ìˆ˜ ====================
function checkMissingFields(product) {
    const missing = {
        needsTitleKr: !product.title_kr || product.title_kr.trim() === '',
        needsTitleEn: !product.title_en || product.title_en.trim() === '',
        needsPriceOriginal: !product.price_original || product.price_original === 0,
        needsPriceDiscount: !product.price_discount || product.price_discount === 0,
        needsDescription: !product.description || product.description.trim() === '',
        needsDescriptionEn: !product.description_en || product.description_en.trim() === '',
        needsImages: !product.product_images || product.product_images.length === 0
    };
    
    missing.needsPageVisit = missing.needsTitleKr || missing.needsPriceOriginal || 
                              missing.needsDescription || missing.needsImages;
    
    missing.isComplete = !missing.needsTitleKr && !missing.needsTitleEn && 
                         !missing.needsPriceOriginal && !missing.needsDescription &&
                         !missing.needsDescriptionEn && !missing.needsImages;
    
    return missing;
}

// ==================== íƒ€ì´í‹€ í´ë¦¬ë‹ í•¨ìˆ˜ ====================
function cleanProductTitle(rawTitle) {
    if (!rawTitle) return '';
    
    let cleaned = rawTitle;
    
    // 1ë‹¨ê³„: "| ì˜¬ë¦¬ë¸Œì˜" ë˜ëŠ” "- ì˜¬ë¦¬ë¸Œì˜" ì œê±°
    cleaned = cleaned.replace(/\s*\|\s*ì˜¬ë¦¬ë¸Œì˜.*$/g, '');
    cleaned = cleaned.replace(/\s*-\s*ì˜¬ë¦¬ë¸Œì˜.*$/g, '');
    cleaned = cleaned.replace(/\s*ì˜¬ë¦¬ë¸Œì˜$/, '');
    
    // 2ë‹¨ê³„: ê´„í˜¸ ì œê±°
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\([^)]*\)/g, '');
    cleaned = cleaned.replace(/ã€[^ã€‘]*ã€‘/g, '');
    cleaned = cleaned.replace(/ã€”[^ã€•]*ã€•/g, '');
    cleaned = cleaned.replace(/\{[^}]*\}/g, '');
    
    // 3ë‹¨ê³„: ì œê±°í•  í‚¤ì›Œë“œ
    const removeKeywords = [
        'ê¸°íšì¦ì •', 'ê¸°íš ì¦ì •', 'ì¦ì •ê¸°íš', 'ì¦ì • ê¸°íš', 'ê¸°íšì„¸íŠ¸', 'ê¸°íš ì„¸íŠ¸',
        'ê¸°íš', 'ì¦ì •', 'í•œì •ê¸°íš', 'í•œì • ê¸°íš', 'í•œì •íŒ', 'í•œì •',
        'ì¶”ê°€ì¦ì •', 'ì¶”ê°€ ì¦ì •', 'ì¶”ê°€', 'ì–´ì›Œì¦ˆ', 'ì˜¬ì˜í”½', 'ì˜¬ì˜ì„¸ì¼',
        'ì˜¬ì˜ë”œ', 'ì˜¬ì˜ì¶”ì²œ', 'ë‹¨ë…ê¸°íš', 'ë‹¨ë…', 'íŠ¹ê°€', 'ì„¸ì¼', 'SALE',
        'í–‰ì‚¬', 'ì´ë²¤íŠ¸', 'ìŠ¤íŽ˜ì…œ', 'Special', 'ë¦¬ë¯¸í‹°ë“œ', 'Limited',
        'ì—ë””ì…˜', 'Edition', 'ì„ ë¬¼ì„¸íŠ¸', 'ì„ ë¬¼ ì„¸íŠ¸', 'í™€ë¦¬ë°ì´', 'Holiday',
        'ë² ìŠ¤íŠ¸', 'Best', 'ì¸ê¸°', 'ì¶”ì²œ', 'NEW', 'ì‹ ìƒ', 'ì‹ ì œí’ˆ', 'ëŸ°ì¹­',
    ];
    
    for (const keyword of removeKeywords) {
        const regex = new RegExp(keyword, 'gi');
        cleaned = cleaned.replace(regex, '');
    }
    
    // 4ë‹¨ê³„: ê³µë°± ì •ë¦¬
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
}

// ==================== íƒ€ì´í‹€ì—ì„œ ìš©ëŸ‰ ì¶”ì¶œ ====================
function extractVolumeFromTitle(title) {
    if (!title) return null;
    
    const volumes = [];
    const volumePattern = /(\d+)\s*(ml|mL|ML|g|G)/gi;
    let match;
    
    while ((match = volumePattern.exec(title)) !== null) {
        volumes.push(match[1] + match[2].toLowerCase());
    }
    
    const countMatch = title.match(/(\d+)\s*(ê°œ|ìž…|ë§¤)/);
    
    if (countMatch && volumes.length > 0) {
        const count = parseInt(countMatch[1]);
        const baseVolume = volumes[0];
        
        if (count > 1) {
            return `${baseVolume} Ã— ${count}`;
        }
    }
    
    if (volumes.length > 1) {
        return volumes.join(' + ');
    }
    
    if (volumes.length === 1) {
        return volumes[0];
    }
    
    return null;
}

// ==================== ìƒì„¸ì„¤ëª… í¬ë§· í•¨ìˆ˜ ====================
function formatDescriptionForShopify(infoTable, cleanedTitle) {
    const sections = [];
    
    const titleVolume = extractVolumeFromTitle(cleanedTitle);
    
    if (titleVolume) {
        sections.push(`**Volume:** ${titleVolume}`);
    } else if (infoTable.volume) {
        sections.push(`**Volume:** ${infoTable.volume}`);
    }
    
    if (infoTable.skinType && infoTable.skinType.length > 2) {
        sections.push(`**Skin Type:** ${infoTable.skinType}`);
    }
    
    if (infoTable.expiry && infoTable.expiry.length > 5) {
        sections.push(`**Shelf Life:** ${infoTable.expiry}`);
    }
    
    if (infoTable.usage && infoTable.usage.length > 10) {
        sections.push(`**How to Use:**\n${infoTable.usage}`);
    }
    
    if (infoTable.ingredients && infoTable.ingredients.length > 30) {
        sections.push(`**Ingredients:**\n${infoTable.ingredients}`);
    }
    
    return sections.join('\n\n');
}

// ==================== OpenAI ë²ˆì—­ í•¨ìˆ˜ ====================
async function translateToEnglish(koreanText) {
    if (!openai || !koreanText) {
        return null;
    }
    
    try {
        log(`   ðŸŒ ë²ˆì—­ ì¤‘: "${koreanText.substring(0, 50)}..."`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional translator specializing in Korean beauty products.
Translate the Korean product name to English.
Keep brand names in their original form (e.g., ì•„ë²¤ëŠ â†’ AvÃ¨ne, VT â†’ VT).
Keep volume/quantity units (ml, g, ë§¤, ìž…, ê°œ) in their common English forms.
Output ONLY the translated text, no explanations.`
                },
                {
                    role: 'user',
                    content: koreanText
                }
            ],
            max_tokens: 200,
            temperature: 0.3
        });
        
        const translatedText = response.choices[0].message.content.trim();
        log(`   âœ… ë²ˆì—­ ì™„ë£Œ: "${translatedText}"`);
        
        return translatedText;
        
    } catch (error) {
        log(`   âŒ ë²ˆì—­ ì‹¤íŒ¨: ${error.message}`);
        return null;
    }
}

async function translateDescriptionToEnglish(koreanDescription) {
    if (!openai || !koreanDescription) {
        return null;
    }
    
    try {
        log(`   ðŸŒ ì„¤ëª… ë²ˆì—­ ì¤‘...`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional translator for Korean beauty product descriptions.
Translate the Korean product description to natural English for a Shopify store.
Keep the markdown format (**bold** headers like **Volume:**, **Skin Type:**, etc.).
For ingredients, translate to their common English cosmetic names.
Keep brand names accurate.
Output ONLY the translated text, no explanations.`
                },
                {
                    role: 'user',
                    content: koreanDescription.substring(0, 1500)
                }
            ],
            max_tokens: 800,
            temperature: 0.3
        });
        
        const translatedText = response.choices[0].message.content.trim();
        log(`   âœ… ì„¤ëª… ë²ˆì—­ ì™„ë£Œ (${translatedText.length}ìž)`);
        
        return translatedText;
        
    } catch (error) {
        log(`   âŒ ì„¤ëª… ë²ˆì—­ ì‹¤íŒ¨: ${error.message}`);
        return null;
    }
}

// ==================== NocoDB: ì œí’ˆ ê°€ì ¸ì˜¤ê¸° ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        log(`ðŸ“¥ NocoDBì—ì„œ ì œí’ˆ ê°€ì ¸ì˜¤ëŠ” ì¤‘ (offset: ${offset}, limit: ${limit})...`);
        
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    offset: offset,
                    limit: limit
                }
            }
        );

        const products = response.data.list;
        log(`âœ… ${products.length}ê°œ ì œí’ˆ ê°€ì ¸ì˜´`);
        
        let needsTitle = 0, needsPrice = 0, needsDescription = 0, needsImages = 0;
        for (const p of products) {
            const missing = checkMissingFields(p);
            if (missing.needsTitleKr) needsTitle++;
            if (missing.needsPriceOriginal) needsPrice++;
            if (missing.needsDescription) needsDescription++;
            if (missing.needsImages) needsImages++;
        }
        
        log(`ðŸ“Š ë¹ˆ í•„ë“œ í˜„í™©:`);
        log(`   - title_kr í•„ìš”: ${needsTitle}ê°œ`);
        log(`   - price_original í•„ìš”: ${needsPrice}ê°œ`);
        log(`   - description í•„ìš”: ${needsDescription}ê°œ`);
        log(`   - product_images í•„ìš”: ${needsImages}ê°œ`);
        log('');
        
        return products;

    } catch (error) {
        log('âŒ ì œí’ˆ ê°€ì ¸ì˜¤ê¸° ì‹¤íŒ¨:', error.response?.data || error.message);
        return [];
    }
}

// ==================== ì´ë¯¸ì§€ ë‹¤ìš´ë¡œë“œ ====================
async function downloadImage(url, retryCount = 0) {
    const MAX_RETRIES = 2;
    
    try {
        if (!url || !url.startsWith('http')) {
            log(`   âš ï¸  ìž˜ëª»ëœ URL: ${url}`);
            return null;
        }
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.oliveyoung.co.kr/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'image',
                'sec-fetch-mode': 'no-cors',
                'sec-fetch-site': 'same-site'
            },
            validateStatus: function (status) {
                return status < 500;
            }
        });
        
        if (response.status === 404) {
            log(`   âš ï¸  404 Not Found - ì´ë¯¸ì§€ ìŠ¤í‚µ`);
            stats.images404Skipped++;
            return null;
        }
        
        if (response.status !== 200) {
            log(`   âš ï¸  HTTP ${response.status} - ì´ë¯¸ì§€ ìŠ¤í‚µ`);
            return null;
        }
        
        const buffer = Buffer.from(response.data);
        
        if (buffer.length < 1024) {
            log(`   âš ï¸  ì´ë¯¸ì§€ê°€ ë„ˆë¬´ ìž‘ìŒ (${buffer.length} bytes) - ìŠ¤í‚µ`);
            return null;
        }
        
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        log(`   ðŸ“¥ ë‹¤ìš´ë¡œë“œ ì™„ë£Œ (${sizeMB} MB)`);
        
        return buffer;

    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            log(`   âš ï¸  ë‹¤ìš´ë¡œë“œ ì‹¤íŒ¨, ìž¬ì‹œë„ ì¤‘... (${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return downloadImage(url, retryCount + 1);
        }
        
        log(`   âŒ ë‹¤ìš´ë¡œë“œ ì‹¤íŒ¨: ${error.message}`);
        stats.imagesDownloadFailed++;
        return null;
    }
}

// ==================== NocoDB: íŒŒì¼ ì—…ë¡œë“œ ====================
async function uploadToNocoDB(fileBuffer, filename) {
    try {
        log(`   ðŸ“¤ NocoDB ì—…ë¡œë“œ: ${filename}`);
        
        const formData = new FormData();
        formData.append('file', fileBuffer, filename);

        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/storage/upload`,
            formData,
            {
                headers: {
                    'xc-token': NOCODB_TOKEN,
                    ...formData.getHeaders()
                },
                timeout: 60000
            }
        );

        log(`   âœ… ì—…ë¡œë“œ ì„±ê³µ`);
        
        const uploadData = Array.isArray(response.data) ? response.data[0] : response.data;
        return uploadData;

    } catch (error) {
        log(`   âŒ ì—…ë¡œë“œ ì‹¤íŒ¨:`, error.response?.data || error.message);
        return null;
    }
}

// ==================== NocoDB: ì œí’ˆ ì—…ë°ì´íŠ¸ ====================
async function updateProduct(recordId, updateData) {
    try {
        log(`ðŸ“ ì œí’ˆ ë ˆì½”ë“œ ì—…ë°ì´íŠ¸ ì¤‘ (ID: ${recordId})...`);
        
        const fields = Object.keys(updateData).filter(k => k !== 'Id');
        log(`ðŸ“‹ ì—…ë°ì´íŠ¸ í•„ë“œ: ${fields.join(', ')}`);
        
        if (updateData.product_images) {
            log(`ðŸ—‘ï¸  ê¸°ì¡´ product_images ì‚­ì œ ì¤‘...`);
            await axios.patch(
                `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
                [{ Id: recordId, product_images: null }],
                { 
                    headers: { 
                        'xc-token': NOCODB_TOKEN,
                        'Content-Type': 'application/json'
                    } 
                }
            );
        }
        
        const scrapedAt = new Date().toISOString();
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ 
                Id: recordId, 
                ...updateData,
                scraped_at: scrapedAt
            }],
            { 
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        log(`âœ… ì œí’ˆ ë ˆì½”ë“œ ì—…ë°ì´íŠ¸ ì™„ë£Œ! (ì‹œê°„: ${scrapedAt})`);
        return true;

    } catch (error) {
        log('âŒ ì—…ë°ì´íŠ¸ ì‹¤íŒ¨:', error.response?.data || error.message);
        return false;
    }
}

// ==================== ì´ë¯¸ì§€ ì²˜ë¦¬ ====================
async function processProductImages(product, imageUrls) {
    try {
        if (imageUrls.length === 0) {
            log('âŒ ì´ë¯¸ì§€ë¥¼ ì°¾ì„ ìˆ˜ ì—†ìŠµë‹ˆë‹¤.');
            return [];
        }
        
        log(`ðŸ“Š ì¶”ì¶œëœ ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì´ë¯¸ì§€: ${imageUrls.length}ê°œ`);
        imageUrls.slice(0, 7).forEach((url, i) => {
            log(`   ${i + 1}. ${url}`);  // ì „ì²´ URL ì¶œë ¥ (ë””ë²„ê¹…ìš©)
        });
        
        const maxImages = Math.min(imageUrls.length, 7);
        log(`ðŸ“¥ ${maxImages}ê°œ ì´ë¯¸ì§€ ë‹¤ìš´ë¡œë“œ & ì—…ë¡œë“œ ì¤‘...`);
        
        const uploadedFiles = [];
        
        for (let i = 0; i < maxImages; i++) {
            const url = imageUrls[i];
            log(`${i + 1}/${maxImages}: ${url}`);  // ì „ì²´ URL ì¶œë ¥
            
            const buffer = await downloadImage(url);
            if (!buffer) {
                continue;
            }
            
            const filename = `gallery-${product.Id}-${i + 1}-${Date.now()}.jpg`;
            const uploadResult = await uploadToNocoDB(buffer, filename);
            
            if (uploadResult) {
                uploadedFiles.push(uploadResult);
            }
            
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        const attachments = uploadedFiles.map((file, index) => {
            let fullUrl = file.url;
            if (!fullUrl && file.path) {
                fullUrl = `${NOCODB_API_URL}/${file.path}`;
            }
            if (!fullUrl && file.signedPath) {
                fullUrl = `${NOCODB_API_URL}/${file.signedPath}`;
            }
            
            return {
                url: fullUrl || '',
                title: file.title || file.name || `gallery-image-${index + 1}.jpg`,
                mimetype: file.mimetype || file.type || 'image/jpeg',
                size: file.size || 0
            };
        });
        
        return attachments;
        
    } catch (error) {
        log(`âŒ ì´ë¯¸ì§€ ì²˜ë¦¬ ì¤‘ ì˜¤ë¥˜:`, error.message);
        return [];
    }
}

// ==================== ë©”ì¸ ====================
async function main() {
    log('ðŸš€ Phase 1: ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì´ë¯¸ì§€ + íƒ€ì´í‹€/ê°€ê²©/ì„¤ëª… ì¶”ì¶œ (v2.2)');
    log('='.repeat(70));
    log('');
    
    logMemoryUsage('ì‹œìž‘');
    
    let crawler = null;
    
    try {
        const products = await getOliveyoungProducts(
            parseInt(process.env.PRODUCT_LIMIT) || 3, 
            0
        );
        
        if (products.length === 0) {
            log('âš ï¸  ì²˜ë¦¬í•  ì œí’ˆì´ ì—†ìŠµë‹ˆë‹¤.');
            return;
        }
        
        const productsToProcess = products.filter(p => {
            const missing = checkMissingFields(p);
            return missing.needsPageVisit;
        });
        
        log(`ðŸ“‹ íŽ˜ì´ì§€ ë°©ë¬¸ í•„ìš”: ${productsToProcess.length}/${products.length}ê°œ`);
        log('');
        
        if (productsToProcess.length === 0) {
            log('âœ… ëª¨ë“  ì œí’ˆì´ ì´ë¯¸ ì™„ì „í•©ë‹ˆë‹¤.');
            return;
        }
        
        const totalProducts = productsToProcess.length;
        
        crawler = new PlaywrightCrawler({
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--single-process',
                        '--disable-extensions',
                        '--disable-background-networking',
                        '--disable-default-apps',
                        '--disable-sync',
                        '--disable-translate',
                        '--metrics-recording-only',
                        '--no-first-run',
                        '--safebrowsing-disable-auto-update',
                        '--js-flags=--max-old-space-size=512'
                    ]
                }
            },
            
            browserPoolOptions: {
                maxOpenPagesPerBrowser: 1,
                retireBrowserAfterPageCount: 5,
            },
            
            requestHandler: async ({ page, request }) => {
                const product = request.userData.product;
                const index = request.userData.index;
                const missingFields = request.userData.missingFields;
                
                log('');
                log('='.repeat(70));
                log(`ðŸ“¦ [${index + 1}/${totalProducts}] ì œí’ˆ ID: ${product.Id}`);
                log(`ðŸ”— URL: ${request.url.substring(0, 80)}...`);
                log(`ðŸ“‹ í•„ìš”í•œ í•„ë“œ: ${[
                    missingFields.needsTitleKr ? 'title_kr' : null,
                    missingFields.needsPriceOriginal ? 'price' : null,
                    missingFields.needsDescription ? 'description' : null,
                    missingFields.needsImages ? 'images' : null
                ].filter(Boolean).join(', ')}`);
                log('='.repeat(70));
                
                if ((index + 1) % MEMORY_CHECK_INTERVAL === 0) {
                    logMemoryUsage(`[${index + 1}/${totalProducts}]`);
                }
                
                try {
                    log(`ðŸ“„ íŽ˜ì´ì§€ ë¡œë”© ì¤‘...`);
                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
                    
                    // JavaScript ë Œë”ë§ ëŒ€ê¸°
                    await page.waitForTimeout(3000);
                    
                    // ì œí’ˆëª… ìš”ì†Œê°€ ë‚˜íƒ€ë‚  ë•Œê¹Œì§€ ì¶”ê°€ ëŒ€ê¸°
                    try {
                        await page.waitForSelector('p.prd_name, .prd_name, [class*="goods_name"]', { 
                            timeout: 5000 
                        });
                        log(`   âœ… ì œí’ˆëª… ìš”ì†Œ ê°ì§€ë¨`);
                    } catch (e) {
                        log(`   âš ï¸  ì œí’ˆëª… ìš”ì†Œ ëŒ€ê¸° ì‹œê°„ ì´ˆê³¼ (ê³„ì† ì§„í–‰)`);
                    }
                    
                    const updateData = {};
                    let hasUpdates = false;
                    
                    if (missingFields.needsTitleKr || missingFields.needsPriceOriginal || missingFields.needsDescription || missingFields.needsImages) {
                        log(`ðŸ“Š ì›¹íŽ˜ì´ì§€ì—ì„œ ì •ë³´ ì¶”ì¶œ ì¤‘...`);
                        
                        // ìƒí’ˆì •ë³´ ì œê³µê³ ì‹œ í´ë¦­í•´ì„œ íŽ¼ì¹˜ê¸°
                        try {
                            const infoToggle = await page.$('text=ìƒí’ˆì •ë³´ ì œê³µê³ ì‹œ');
                            if (infoToggle) {
                                await infoToggle.click();
                                log(`   âœ… ìƒí’ˆì •ë³´ ì œê³µê³ ì‹œ ì„¹ì…˜ íŽ¼ì¹¨`);
                                await page.waitForTimeout(1000);
                            }
                        } catch (e) {
                            log(`   âš ï¸  ìƒí’ˆì •ë³´ ì œê³µê³ ì‹œ í´ë¦­ ì‹¤íŒ¨ (ë¬´ì‹œí•˜ê³  ê³„ì†)`);
                        }
                        
                        const productData = await page.evaluate(() => {
                            const result = {
                                rawTitle: '',
                                priceOriginal: 0,
                                priceDiscount: 0,
                                infoTable: {
                                    volume: '',
                                    skinType: '',
                                    expiry: '',
                                    usage: '',
                                    ingredients: ''
                                },
                                imageUrls: [],
                                expectedImageCount: 0,  // âœ… ì˜ˆìƒ ì´ë¯¸ì§€ ê°œìˆ˜
                                debugInfo: ''           // âœ… ë””ë²„ê·¸ ì •ë³´
                            };
                            
                            // ===== íƒ€ì´í‹€ ì¶”ì¶œ =====
                            const titleSelectors = [
                                'p.prd_name',
                                '.prd_name',
                                '.goods-name',
                                '.prd-info p.prd_name',
                                '.prd_detail_box .prd_name',
                                '.goods_detail_box .prd_name',
                                '[class*="goodsName"]',
                                '[class*="goods_name"]',
                                '.pdtInfoWrap .prd_name',
                                '.prd_info_area .prd_name',
                                '#Contents .prd_name',
                                '[class*="title_name"]',
                                '[class*="product_name"]',
                                '[class*="productName"]',
                                '.goodsDetailInfo_title_name_unity',
                                '[class*="title_name_unity"]',
                                'h1',
                                'h2.prd_name',
                            ];
                            
                            for (const selector of titleSelectors) {
                                try {
                                    const el = document.querySelector(selector);
                                    if (el) {
                                        const text = el.textContent.trim();
                                        if (text.length > 5 && text.length < 150) {
                                            result.rawTitle = text;
                                            break;
                                        }
                                    }
                                } catch (e) {}
                            }
                            
                            // íƒ€ì´í‹€ fallback: meta íƒœê·¸
                            if (!result.rawTitle) {
                                const ogTitle = document.querySelector('meta[property="og:title"]');
                                if (ogTitle && ogTitle.content) {
                                    result.rawTitle = ogTitle.content.trim();
                                }
                            }
                            
                            // íƒ€ì´í‹€ fallback: JSON-LD
                            if (!result.rawTitle) {
                                const jsonLd = document.querySelector('script[type="application/ld+json"]');
                                if (jsonLd) {
                                    try {
                                        const data = JSON.parse(jsonLd.textContent);
                                        if (data.name) {
                                            result.rawTitle = data.name;
                                        } else if (data['@graph']) {
                                            const productItem = data['@graph'].find(item => item['@type'] === 'Product');
                                            if (productItem && productItem.name) {
                                                result.rawTitle = productItem.name;
                                            }
                                        }
                                    } catch (e) {}
                                }
                            }
                            
                            // ===== ê°€ê²© ì¶”ì¶œ =====
                            const priceEl = document.querySelector('[class*="price"]');
                            
                            if (priceEl) {
                                const priceText = priceEl.textContent;
                                const prices = priceText.match(/[\d,]+ì›/g);
                                
                                if (prices && prices.length >= 2) {
                                    result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                    result.priceDiscount = parseInt(prices[1].replace(/[^0-9]/g, ''));
                                } else if (prices && prices.length === 1) {
                                    result.priceOriginal = parseInt(prices[0].replace(/[^0-9]/g, ''));
                                    result.priceDiscount = result.priceOriginal;
                                }
                            }
                            
                            if (result.priceOriginal && result.priceDiscount && 
                                result.priceOriginal < result.priceDiscount) {
                                const temp = result.priceOriginal;
                                result.priceOriginal = result.priceDiscount;
                                result.priceDiscount = temp;
                            }
                            
                            // ===== âœ… v2.2 ìˆ˜ì •: ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì´ë¯¸ì§€ ì¶”ì¶œ (ì •í™•í•œ ì…€ë ‰í„°) =====
                            const seenUrls = new Set();
                            const mainGalleryImages = [];
                            
                            // âœ… 1. íŽ˜ì´ì§€ ì¸ë””ì¼€ì´í„°ì—ì„œ ì˜ˆìƒ ì´ë¯¸ì§€ ê°œìˆ˜ í™•ì¸ (ì˜ˆ: "1 / 5")
                            const paginationEl = document.querySelector('.swiper-pagination, [class*="pagination"]');
                            if (paginationEl) {
                                const paginationText = paginationEl.textContent.trim();
                                const countMatch = paginationText.match(/\d+\s*\/\s*(\d+)/);
                                if (countMatch) {
                                    result.expectedImageCount = parseInt(countMatch[1]);
                                }
                            }
                            
                            // âœ… 2. ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì»¨í…Œì´ë„ˆ (vis-swiper) íƒ€ê²ŸíŒ… - ìµœìš°ì„ !
                            const mainGallerySelectors = [
                                // âœ… ì˜¬ë¦¬ë¸Œì˜ ë©”ì¸ ê°¤ëŸ¬ë¦¬ (2024-2025 êµ¬ì¡°)
                                '.vis-swiper .swiper-slide img',
                                '.vis-swiper [data-swiper-slide-index] img',
                                '[class*="vis-swiper"] .swiper-slide img',
                                
                                // âœ… GoodsDetail_Carousel í´ëž˜ìŠ¤ (React ì»´í¬ë„ŒíŠ¸)
                                '[class*="GoodsDetail_Carousel"] img',
                                '[class*="Carousel_content"] img',
                                
                                // âœ… data-swiper-slide-index ì†ì„±ì´ ìžˆëŠ” ìŠ¬ë¼ì´ë“œë§Œ
                                '.swiper-slide[data-swiper-slide-index] img',
                                
                                // âœ… ë©”ì¸ ì´ë¯¸ì§€ ì˜ì—­ (ì¢Œì¸¡ ìƒë‹¨)
                                '.prd-img .swiper-slide img',
                                '.goods-img .swiper-slide img',
                            ];
                            
                            let foundMethod = '';
                            
                            for (const selector of mainGallerySelectors) {
                                try {
                                    const imgs = document.querySelectorAll(selector);
                                    
                                    if (imgs.length > 0) {
                                        foundMethod = selector;
                                        
                                        imgs.forEach(img => {
                                            // âœ… ì—¬ëŸ¬ ì†ì„±ì—ì„œ URL ì¶”ì¶œ
                                            let src = img.getAttribute('data-src') ||
                                                      img.getAttribute('data-origin') ||
                                                      img.getAttribute('data-lazy') ||
                                                      img.getAttribute('data-original') ||
                                                      img.src ||
                                                      img.getAttribute('src');
                                            
                                            if (!src) return;
                                            
                                            // í”„ë¡œí† ì½œ ì¶”ê°€
                                            if (src.startsWith('//')) {
                                                src = 'https:' + src;
                                            }
                                            
                                            // oliveyoung ì´ë¯¸ì§€ë§Œ
                                            if (!src.includes('oliveyoung.co.kr')) return;
                                            
                                            // âœ… ì œì™¸í•  ì´ë¯¸ì§€ íŒ¨í„´
                                            if (src.includes('/gdasEditor/')) return;   // ìƒì„¸ ì„¤ëª… ì´ë¯¸ì§€
                                            if (src.includes('/display/')) return;       // ë””ìŠ¤í”Œë ˆì´ ë°°ë„ˆ
                                            if (src.includes('/icon/')) return;
                                            if (src.includes('/badge/')) return;
                                            if (src.includes('/banner/')) return;
                                            if (src.includes('/event/')) return;
                                            if (src.includes('/logo/')) return;
                                            if (src.includes('/btn/')) return;
                                            if (src.includes('/common/')) return;
                                            if (src.includes('/review/')) return;
                                            if (src.includes('/point/')) return;
                                            if (src.includes('/coupon/')) return;
                                            
                                            // âœ… v2.4: URL ë³€í™˜ ì œê±°! ì¸ë„¤ì¼ URL ê·¸ëŒ€ë¡œ ì‚¬ìš©
                                            // ì˜¬ë¦¬ë¸Œì˜ì€ /thumbnails/ ê²½ë¡œê°€ ì‹¤ì œ ì´ë¯¸ì§€ URL
                                            // (ë³€í™˜í•˜ë©´ 404 ì—ëŸ¬ ë°œìƒ)
                                            
                                            // ì¤‘ë³µ ì œê±°
                                            if (seenUrls.has(src)) return;
                                            
                                            seenUrls.add(src);
                                            mainGalleryImages.push(src);
                                        });
                                        
                                        // âœ… ë©”ì¸ ê°¤ëŸ¬ë¦¬ì—ì„œ ì´ë¯¸ì§€ë¥¼ ì°¾ì•˜ìœ¼ë©´ ì¤‘ë‹¨
                                        if (mainGalleryImages.length > 0) {
                                            break;
                                        }
                                    }
                                } catch (e) {}
                            }
                            
                            // âœ… 3. ë©”ì¸ ê°¤ëŸ¬ë¦¬ì—ì„œ ëª» ì°¾ì€ ê²½ìš° fallback
                            if (mainGalleryImages.length === 0) {
                                foundMethod = 'fallback: large images';
                                
                                // data-swiper-slide-index ì†ì„±ì´ ìžˆëŠ” ëª¨ë“  ìŠ¬ë¼ì´ë“œì—ì„œ ì´ë¯¸ì§€ ì¶”ì¶œ
                                const allSlides = document.querySelectorAll('[data-swiper-slide-index]');
                                
                                allSlides.forEach(slide => {
                                    const img = slide.querySelector('img');
                                    if (!img) return;
                                    
                                    let src = img.getAttribute('data-src') ||
                                              img.getAttribute('data-origin') ||
                                              img.src;
                                    
                                    if (!src || !src.includes('oliveyoung.co.kr')) return;
                                    
                                    if (src.startsWith('//')) {
                                        src = 'https:' + src;
                                    }
                                    
                                    // ì œì™¸ íŒ¨í„´
                                    if (src.includes('/gdasEditor/')) return;
                                    if (src.includes('/display/')) return;
                                    if (src.includes('/banner/')) return;
                                    
                                    // âœ… v2.4: URL ë³€í™˜ ì œê±° (ì›ë³¸ ê·¸ëŒ€ë¡œ ì‚¬ìš©)
                                    
                                    if (seenUrls.has(src)) return;
                                    seenUrls.add(src);
                                    mainGalleryImages.push(src);
                                });
                            }
                            
                            // âœ… 4. ì—¬ì „ížˆ ëª» ì°¾ìœ¼ë©´ í° ì´ë¯¸ì§€ ìˆ˜ì§‘
                            if (mainGalleryImages.length === 0) {
                                foundMethod = 'fallback: all large oliveyoung images';
                                
                                const allImages = document.querySelectorAll('img');
                                allImages.forEach(img => {
                                    let src = img.getAttribute('data-src') ||
                                              img.getAttribute('data-origin') ||
                                              img.src;
                                    
                                    if (!src || !src.includes('oliveyoung.co.kr')) return;
                                    if (seenUrls.has(src)) return;
                                    
                                    if (src.startsWith('//')) {
                                        src = 'https:' + src;
                                    }
                                    
                                    // ì œì™¸ íŒ¨í„´
                                    if (src.includes('/gdasEditor/')) return;
                                    if (src.includes('/display/')) return;
                                    if (src.includes('/icon/')) return;
                                    if (src.includes('/badge/')) return;
                                    if (src.includes('/banner/')) return;
                                    if (src.includes('/review/')) return;
                                    
                                    // ì´ë¯¸ì§€ í¬ê¸° ì²´í¬
                                    const width = img.naturalWidth || img.width;
                                    const height = img.naturalHeight || img.height;
                                    
                                    if (width >= 400 && height >= 400) {
                                        // âœ… v2.4: URL ë³€í™˜ ì œê±° (ì›ë³¸ ê·¸ëŒ€ë¡œ ì‚¬ìš©)
                                        seenUrls.add(src);
                                        mainGalleryImages.push(src);
                                    }
                                });
                            }
                            
                            result.debugInfo = `Method: ${foundMethod}, Found: ${mainGalleryImages.length}`;
                            result.imageUrls = mainGalleryImages.slice(0, 10);  // ìµœëŒ€ 10ê°œ
                            
                            // ===== ìƒí’ˆì •ë³´ ì œê³µê³ ì‹œ ì¶”ì¶œ =====
                            const EXCLUDE_KEYWORDS = [
                                'ì œì¡°ì—…ìž', 'ìˆ˜ìž…ì—…ìž', 'íŒë§¤ì—…ìž', 'ì±…ìž„íŒë§¤ì—…ìž',
                                'ë§žì¶¤í˜•í™”ìž¥í’ˆíŒë§¤ì—…ìž', 'í’ˆì§ˆë³´ì¦', 'ì†Œë¹„ìžìƒë‹´', 
                                'ì „í™”', 'ê³ ê°ì„¼í„°', '080', '1588', '1577',
                                'í˜‘ë ¥ì‚¬', 'ë³¸ ìƒí’ˆ ì •ë³´', 'ê³µì •ê±°ëž˜', 
                                'ãˆœ', 'ì£¼ì‹íšŒì‚¬', 'ì œì¡°êµ­', 'ì›ì‚°ì§€',
                                'A/S', 'êµí™˜', 'ë°˜í’ˆ', 'ëŒ€í•œë¯¼êµ­', 
                                'ë¶„ìŸí•´ê²°', 'ë³´ìƒí•´ë“œë¦½ë‹ˆë‹¤', 'ìœ„ì›íšŒ ê³ ì‹œ'
                            ];
                            
                            const allRows = document.querySelectorAll('tr');
                            
                            allRows.forEach(row => {
                                const cells = row.querySelectorAll('th, td');
                                if (cells.length < 2) return;
                                
                                const label = (cells[0].textContent || '').trim();
                                const value = (cells[1].textContent || '').trim();
                                
                                const fullText = label + value;
                                if (EXCLUDE_KEYWORDS.some(kw => fullText.includes(kw))) {
                                    return;
                                }
                                
                                if ((label.includes('ìš©ëŸ‰') || label.includes('ì¤‘ëŸ‰') || label.includes('ë‚´ìš©ë¬¼')) && !result.infoTable.volume) {
                                    const volumeMatch = value.match(/(\d+\s*[mMlLgG]+(?:\s*[Ã—x+]\s*\d+\s*[mMlLgG]*)*(?:\s*\+\s*\d+\s*[mMlLgG]+)*)/);
                                    if (volumeMatch) {
                                        result.infoTable.volume = volumeMatch[1].trim();
                                    } else if (value.length < 50) {
                                        result.infoTable.volume = value;
                                    }
                                }
                                
                                if ((label.includes('ì£¼ìš”') || label.includes('ì‚¬ì–‘') || label.includes('í”¼ë¶€')) && !result.infoTable.skinType) {
                                    if (value.length > 2 && value.length < 100) {
                                        result.infoTable.skinType = value;
                                    }
                                }
                                
                                if ((label.includes('ì‚¬ìš©ê¸°í•œ') || label.includes('ê°œë´‰')) && !result.infoTable.expiry) {
                                    if (value.length > 5 && value.length < 100) {
                                        result.infoTable.expiry = value;
                                    }
                                }
                                
                                if (label.includes('ì‚¬ìš©ë°©ë²•') && !result.infoTable.usage) {
                                    let usage = value
                                        .split(/í™”ìž¥í’ˆì œì¡°ì—…ìž|ì œì¡°ì—…ìž|íŒë§¤ì—…ìž|ãˆœ|ì£¼ì‹íšŒì‚¬/)[0]
                                        .trim();
                                    
                                    if (usage.length > 10 && usage.length < 500) {
                                        result.infoTable.usage = usage;
                                    }
                                }
                                
                                if ((label.includes('ëª¨ë“  ì„±ë¶„') || label.includes('ì „ì„±ë¶„') || label.includes('í™”ìž¥í’ˆë²•')) && !result.infoTable.ingredients) {
                                    let ingredients = value
                                        .split(/í™”ìž¥í’ˆì œì¡°ì—…ìž|ì œì¡°ì—…ìž|ê¸°ëŠ¥ì„±|í’ˆì§ˆ/)[0]
                                        .replace(/\s+/g, ' ')
                                        .trim();
                                    
                                    if (ingredients.length > 30) {
                                        result.infoTable.ingredients = ingredients;
                                    }
                                }
                            });
                            
                            // div êµ¬ì¡°ì—ì„œë„ ì¶”ì¶œ ì‹œë„
                            if (!result.infoTable.volume || !result.infoTable.usage) {
                                const allDivs = document.querySelectorAll('div[class*="info"], div[class*="spec"], dl');
                                
                                allDivs.forEach(div => {
                                    const text = div.textContent || '';
                                    
                                    if (EXCLUDE_KEYWORDS.some(kw => text.includes(kw))) {
                                        return;
                                    }
                                    
                                    if (!result.infoTable.volume && (text.includes('ìš©ëŸ‰') || text.includes('ë‚´ìš©ë¬¼'))) {
                                        const match = text.match(/(\d+\s*[mMlLgG]+(?:\s*[Ã—x+]\s*\d+)?)/);
                                        if (match) {
                                            result.infoTable.volume = match[1];
                                        }
                                    }
                                    
                                    if (!result.infoTable.usage && text.includes('ì‚¬ìš©ë°©ë²•')) {
                                        const match = text.match(/ì‚¬ìš©ë°©ë²•\s*[:\s]*(.{20,300}?)(?=\.|í™”ìž¥í’ˆ|ì œì¡°|$)/);
                                        if (match) {
                                            result.infoTable.usage = match[1].trim();
                                        }
                                    }
                                });
                            }
                            
                            return result;
                        });
                        
                        log(`ðŸ“‹ ì¶”ì¶œëœ ì •ë³´:`);
                        log(`   íƒ€ì´í‹€: ${productData.rawTitle ? productData.rawTitle.substring(0, 60) + '...' : 'âŒ ì—†ìŒ'}`);
                        log(`   ì •ê°€: ${productData.priceOriginal ? 'â‚©' + productData.priceOriginal.toLocaleString() : 'âŒ ì—†ìŒ'}`);
                        log(`   í• ì¸ê°€: ${productData.priceDiscount ? 'â‚©' + productData.priceDiscount.toLocaleString() : 'âŒ ì—†ìŒ'}`);
                        log(`   ðŸ–¼ï¸  ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì´ë¯¸ì§€: ${productData.imageUrls.length}ê°œ (ì˜ˆìƒ: ${productData.expectedImageCount || '?'}ê°œ)`);
                        log(`   ðŸ“ ì¶”ì¶œ ë°©ë²•: ${productData.debugInfo}`);
                        log(`   ðŸ“¦ ìƒí’ˆì •ë³´ ì œê³µê³ ì‹œ:`);
                        log(`      ìš©ëŸ‰: ${productData.infoTable.volume || 'âŒ ì—†ìŒ'}`);
                        log(`      í”¼ë¶€íƒ€ìž…: ${productData.infoTable.skinType || 'âŒ ì—†ìŒ'}`);
                        log(`      ì‚¬ìš©ê¸°í•œ: ${productData.infoTable.expiry || 'âŒ ì—†ìŒ'}`);
                        log(`      ì‚¬ìš©ë°©ë²•: ${productData.infoTable.usage ? productData.infoTable.usage.substring(0, 40) + '...' : 'âŒ ì—†ìŒ'}`);
                        log(`      ì„±ë¶„: ${productData.infoTable.ingredients ? productData.infoTable.ingredients.substring(0, 40) + '...' : 'âŒ ì—†ìŒ'}`);
                        
                        // 1. íƒ€ì´í‹€ ì²˜ë¦¬
                        let cleanedTitle = '';
                        if (missingFields.needsTitleKr && productData.rawTitle) {
                            cleanedTitle = cleanProductTitle(productData.rawTitle);
                            updateData.title_kr = cleanedTitle;
                            hasUpdates = true;
                            stats.titleKrFilled++;
                            
                            log(`ðŸ“ íƒ€ì´í‹€ í´ë¦¬ë‹:`);
                            log(`   ì›ë³¸: "${productData.rawTitle.substring(0, 60)}"`);
                            log(`   ì •ì œ: "${cleanedTitle}"`);
                            
                            if (missingFields.needsTitleEn) {
                                const englishTitle = await translateToEnglish(cleanedTitle);
                                if (englishTitle) {
                                    updateData.title_en = englishTitle;
                                    stats.titleEnFilled++;
                                }
                            }
                        } else if (!missingFields.needsTitleKr) {
                            log(`ðŸ“ íƒ€ì´í‹€: ì´ë¯¸ ìžˆìŒ â†’ ìŠ¤í‚µ`);
                            stats.titleKrSkipped++;
                            cleanedTitle = product.title_kr || '';
                            
                            if (missingFields.needsTitleEn && product.title_kr) {
                                const englishTitle = await translateToEnglish(product.title_kr);
                                if (englishTitle) {
                                    updateData.title_en = englishTitle;
                                    hasUpdates = true;
                                    stats.titleEnFilled++;
                                }
                            }
                        }
                        
                        // 2. ê°€ê²© ì²˜ë¦¬
                        if (missingFields.needsPriceOriginal && productData.priceOriginal) {
                            updateData.price_original = productData.priceOriginal;
                            hasUpdates = true;
                            stats.priceFilled++;
                            
                            if (productData.priceDiscount && productData.priceDiscount < productData.priceOriginal) {
                                updateData.price_discount = productData.priceDiscount;
                            } else {
                                updateData.price_discount = productData.priceOriginal;
                            }
                            
                            log(`ðŸ’° ê°€ê²©:`);
                            log(`   ì •ê°€ (price_original): â‚©${updateData.price_original.toLocaleString()}`);
                            log(`   í• ì¸ê°€ (price_discount): â‚©${updateData.price_discount.toLocaleString()}`);
                        } else if (!missingFields.needsPriceOriginal) {
                            log(`ðŸ’° ê°€ê²©: ì´ë¯¸ ìžˆìŒ â†’ ìŠ¤í‚µ`);
                            stats.priceSkipped++;
                        }
                        
                        // 3. ì„¤ëª… ì²˜ë¦¬
                        if (missingFields.needsDescription) {
                            const titleToUse = cleanedTitle || product.title_kr || '';
                            const formattedDesc = formatDescriptionForShopify(productData.infoTable, titleToUse);
                            
                            if (formattedDesc && formattedDesc.length > 10) {
                                updateData.description = formattedDesc;
                                hasUpdates = true;
                                stats.descriptionFilled++;
                                
                                log(`ðŸ“„ ì„¤ëª… (ì‡¼í•‘ëª° í¬ë§·):`);
                                formattedDesc.split('\n').slice(0, 5).forEach(line => {
                                    if (line.trim()) log(`   ${line}`);
                                });
                                
                                if (missingFields.needsDescriptionEn) {
                                    const englishDesc = await translateDescriptionToEnglish(formattedDesc);
                                    if (englishDesc) {
                                        updateData.description_en = englishDesc;
                                    }
                                }
                            } else {
                                log(`âš ï¸  ìƒì„¸ì„¤ëª… ì¶”ì¶œ ì‹¤íŒ¨`);
                            }
                        } else if (!missingFields.needsDescription) {
                            log(`ðŸ“„ ì„¤ëª…: ì´ë¯¸ ìžˆìŒ â†’ ìŠ¤í‚µ`);
                            stats.descriptionSkipped++;
                        }
                        
                        // 4. ì´ë¯¸ì§€ ì²˜ë¦¬
                        if (missingFields.needsImages && productData.imageUrls.length > 0) {
                            log(`ðŸ–¼ï¸  ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì´ë¯¸ì§€ ì²˜ë¦¬ ì¤‘...`);
                            
                            const attachments = await processProductImages(product, productData.imageUrls);
                            
                            if (attachments.length > 0) {
                                updateData.product_images = attachments;
                                hasUpdates = true;
                                stats.imagesFilled++;
                                log(`âœ… ${attachments.length}ê°œ ë©”ì¸ ê°¤ëŸ¬ë¦¬ ì´ë¯¸ì§€ ì²˜ë¦¬ ì™„ë£Œ`);
                            }
                        } else if (!missingFields.needsImages) {
                            log(`ðŸ–¼ï¸  ì´ë¯¸ì§€: ì´ë¯¸ ìžˆìŒ â†’ ìŠ¤í‚µ`);
                            stats.imagesSkipped++;
                        }
                    }
                    
                    // NocoDB ì—…ë°ì´íŠ¸
                    if (hasUpdates) {
                        const success = await updateProduct(product.Id, updateData);
                        if (success) {
                            successCount++;
                        } else {
                            failedCount++;
                        }
                    } else {
                        log(`â„¹ï¸  ì—…ë°ì´íŠ¸í•  ë‚´ìš© ì—†ìŒ`);
                        skippedCount++;
                    }
                    
                    processedCount++;
                    
                } catch (pageError) {
                    log('âš ï¸  íŽ˜ì´ì§€ ì²˜ë¦¬ ì˜¤ë¥˜:', pageError.message);
                    failedCount++;
                    processedCount++;
                }
                
                // ë©”ëª¨ë¦¬ ì •ë¦¬
                if ((index + 1) % BATCH_SIZE === 0) {
                    log(`\nðŸ§¹ ë©”ëª¨ë¦¬ ì •ë¦¬ ì¤‘... (${index + 1}ê°œ ì²˜ë¦¬ ì™„ë£Œ)`);
                    await forceGarbageCollection();
                    logMemoryUsage('ì •ë¦¬ í›„');
                }
            },
            
            maxRequestsPerCrawl: 1000,
            maxConcurrency: 1,
            requestHandlerTimeoutSecs: 180,
            maxRequestRetries: 2,
            navigationTimeoutSecs: 60,
        });
        
        const requests = productsToProcess.map((product, index) => ({
            url: product.product_url,
            userData: {
                product: product,
                index: index,
                missingFields: checkMissingFields(product)
            }
        }));
        
        log(`ðŸŒ Crawler ì‹œìž‘ - ${productsToProcess.length}ê°œ ì œí’ˆ ì²˜ë¦¬`);
        log('');
        
        await crawler.run(requests);
        
        await crawler.teardown();
        await forceGarbageCollection();
        
        // ìµœì¢… ê²°ê³¼
        log('');
        log('='.repeat(70));
        log('ðŸŽ‰ Phase 1 ì™„ë£Œ!');
        log('='.repeat(70));
        log(`âœ… ì„±ê³µ: ${successCount}/${totalProducts}ê°œ ì œí’ˆ`);
        log(`â­ï¸  ìŠ¤í‚µ: ${skippedCount}/${totalProducts}ê°œ ì œí’ˆ`);
        log(`âŒ ì‹¤íŒ¨: ${failedCount}/${totalProducts}ê°œ ì œí’ˆ`);
        
        log(`ðŸ“Š í•„ë“œë³„ í†µê³„:`);
        log(`   - title_kr: ${stats.titleKrFilled}ê°œ ì±„ì›€, ${stats.titleKrSkipped}ê°œ ìŠ¤í‚µ`);
        log(`   - title_en: ${stats.titleEnFilled}ê°œ ì±„ì›€, ${stats.titleEnSkipped}ê°œ ìŠ¤í‚µ`);
        log(`   - price: ${stats.priceFilled}ê°œ ì±„ì›€, ${stats.priceSkipped}ê°œ ìŠ¤í‚µ`);
        log(`   - description: ${stats.descriptionFilled}ê°œ ì±„ì›€, ${stats.descriptionSkipped}ê°œ ìŠ¤í‚µ`);
        log(`   - images: ${stats.imagesFilled}ê°œ ì±„ì›€, ${stats.imagesSkipped}ê°œ ìŠ¤í‚µ`);
        log(`   - images 404: ${stats.images404Skipped}ê°œ ìŠ¤í‚µ`);
        log(`   - images ë‹¤ìš´ë¡œë“œ ì‹¤íŒ¨: ${stats.imagesDownloadFailed}ê°œ`);
        
        logMemoryUsage('ìµœì¢…');
        
        log(`ðŸ“ ë¡œê·¸ íŒŒì¼: ${LOG_PATH}`);
        log(`ðŸ’¡ ë‹¤ìŒ ë‹¨ê³„: Phase 2 ì‹¤í–‰`);
        log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        log('âŒ ì¹˜ëª…ì  ì˜¤ë¥˜:', error.message);
        log(error.stack);
    } finally {
        if (crawler) {
            try {
                await crawler.teardown();
            } catch (e) {
                // ì´ë¯¸ ì¢…ë£Œë¨
            }
        }
        logStream.end();
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('');
    log('âš ï¸  SIGINT ìˆ˜ì‹  - ì•ˆì „í•˜ê²Œ ì¢…ë£Œ ì¤‘...');
    logStream.end();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('');
    log('âš ï¸  SIGTERM ìˆ˜ì‹  - ì•ˆì „í•˜ê²Œ ì¢…ë£Œ ì¤‘...');
    logStream.end();
    process.exit(0);
});

main();