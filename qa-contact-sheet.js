import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { execSync } from 'child_process';

dotenv.config();

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL;
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;

const SYDNEY_TIMEZONE = 'Australia/Sydney';
const PAGE_SIZE = 200;
const THUMB_SIZE = 200;
const THUMB_GAP = 10;
const LABEL_WIDTH = 400;
const ROW_HEIGHT = 220;
const MAX_IMAGES_PER_ROW = 6;
const MAX_PRODUCTS_PER_SHEET = 25;
const DOWNLOAD_DELAY_MS = 500;
const OUTPUT_DIR = path.join(process.cwd(), 'qa-sheets');

// ==================== 로깅 ====================
function getTimestamp() {
    return new Date().toLocaleString('en-AU', { timeZone: SYDNEY_TIMEZONE, hour12: false });
}

function log(...args) {
    console.log(`[${getTimestamp()}]`, ...args);
}

// ==================== NocoDB API ====================
function hasAttachments(field) {
    return field && Array.isArray(field) && field.length > 0;
}

function extractImageUrl(img) {
    if (img.url && img.url.startsWith('http')) return img.url;
    if (img.signedPath) return `${NOCODB_API_URL}/${img.signedPath}`;
    if (img.path) return `${NOCODB_API_URL}/${img.path}`;
    return null;
}

async function getAllProducts() {
    const allProducts = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: PAGE_SIZE, offset }
            }
        );

        const list = response.data.list || [];
        const filtered = list.filter(p =>
            hasAttachments(p.validated_images) ||
            hasAttachments(p.ai_product_images) ||
            hasAttachments(p.main_image)
        );
        allProducts.push(...filtered);

        if (list.length < PAGE_SIZE) {
            hasMore = false;
        } else {
            offset += PAGE_SIZE;
        }
        log(`   페이지 로드: offset=${offset}, 이번 ${list.length}건, 유효 ${filtered.length}건`);
    }

    return allProducts;
}

async function getOliveyoungProduct(productId) {
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { where: `(Id,eq,${productId})` }
            }
        );
        if (response.data.list && response.data.list.length > 0) {
            return response.data.list[0];
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ==================== 이미지 수집 ====================
function collectImages(product) {
    const images = [];
    const sourceCounts = {};

    // 1차: validated_images (Phase 3) 또는 ai_product_images (Phase 2 fallback)
    if (hasAttachments(product.validated_images)) {
        product.validated_images.forEach((img, idx) => {
            const url = extractImageUrl(img);
            if (url) images.push({ position: `validated-${idx + 1}`, url, source: 'validated' });
        });
        sourceCounts.validated = product.validated_images.length;
    } else if (hasAttachments(product.ai_product_images)) {
        product.ai_product_images.forEach((img, idx) => {
            const url = extractImageUrl(img);
            if (url) images.push({ position: `ai-${idx + 1}`, url, source: 'ai_product' });
        });
        sourceCounts.ai_product = product.ai_product_images.length;
    }

    // 추가: main_image
    if (hasAttachments(product.main_image)) {
        for (const img of product.main_image) {
            const url = extractImageUrl(img);
            if (url) {
                images.push({ position: 'main', url, source: 'main' });
                sourceCounts.main = 1;
                break;
            }
        }
    }

    // 추가: gallery_images
    if (hasAttachments(product.gallery_images)) {
        let count = 0;
        product.gallery_images.forEach((img, idx) => {
            const url = extractImageUrl(img);
            if (url) {
                images.push({ position: `gallery-${idx + 1}`, url, source: 'gallery' });
                count++;
            }
        });
        if (count > 0) sourceCounts.gallery = count;
    }

    // 소스 표시 문자열
    const sourceStr = Object.entries(sourceCounts)
        .map(([k, v]) => `${k}: ${v}장`)
        .join(', ');

    return { images: images.slice(0, MAX_IMAGES_PER_ROW), sourceStr };
}

// ==================== 이미지 다운로드 + 썸네일 ====================
async function downloadAndResize(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        const buffer = Buffer.from(response.data);
        const resized = await sharp(buffer)
            .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .png()
            .toBuffer();
        return resized;
    } catch (error) {
        // 빨간색 placeholder
        return await createPlaceholder('FAIL');
    }
}

async function createPlaceholder(text) {
    const svg = Buffer.from(`<svg width="${THUMB_SIZE}" height="${THUMB_SIZE}">
        <rect width="${THUMB_SIZE}" height="${THUMB_SIZE}" fill="#ffcccc" stroke="#ff0000" stroke-width="2"/>
        <text x="${THUMB_SIZE / 2}" y="${THUMB_SIZE / 2}" text-anchor="middle" dominant-baseline="middle" font-size="16" fill="#cc0000" font-family="sans-serif">${text}</text>
    </svg>`);
    return await sharp(svg).png().toBuffer();
}

// ==================== 텍스트 라벨 생성 ====================
function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function createLabel(number, title, sourceStr) {
    const shortTitle = title.length > 40 ? title.substring(0, 40) + '...' : title;
    const safeTitle = escapeXml(shortTitle);
    const safeSource = escapeXml(sourceStr);

    const svg = Buffer.from(`<svg width="${LABEL_WIDTH}" height="${ROW_HEIGHT}">
        <rect width="${LABEL_WIDTH}" height="${ROW_HEIGHT}" fill="white"/>
        <text x="10" y="100" font-size="14" fill="black" font-family="sans-serif">${number}. ${safeTitle}</text>
        <text x="10" y="120" font-size="11" fill="gray" font-family="sans-serif">${safeSource}</text>
    </svg>`);
    return await sharp(svg).png().toBuffer();
}

// ==================== 시트 생성 ====================
async function createSheet(productRows, sheetNumber) {
    const sheetWidth = LABEL_WIDTH + (THUMB_SIZE + THUMB_GAP) * MAX_IMAGES_PER_ROW + THUMB_GAP;
    const sheetHeight = ROW_HEIGHT * productRows.length;

    const compositeOps = [];

    for (let ri = 0; ri < productRows.length; ri++) {
        const row = productRows[ri];
        const yBase = ri * ROW_HEIGHT;

        // 라벨
        const labelBuf = await createLabel(row.globalIndex, row.titleEn, row.sourceStr);
        compositeOps.push({ input: labelBuf, top: yBase, left: 0 });

        // 썸네일
        for (let ti = 0; ti < row.thumbnails.length; ti++) {
            const xPos = LABEL_WIDTH + THUMB_GAP + ti * (THUMB_SIZE + THUMB_GAP);
            const yPos = yBase + Math.floor((ROW_HEIGHT - THUMB_SIZE) / 2);
            compositeOps.push({ input: row.thumbnails[ti], top: yPos, left: xPos });
        }
    }

    const sheetPath = path.join(OUTPUT_DIR, `qa-contact-sheet-${sheetNumber}.jpg`);

    await sharp({
        create: {
            width: sheetWidth,
            height: sheetHeight,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    })
        .composite(compositeOps)
        .jpeg({ quality: 85 })
        .toFile(sheetPath);

    const stat = fs.statSync(sheetPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    log(`   📄 시트 ${sheetNumber}: ${sheetPath} (${sizeMB}MB, ${productRows.length}제품)`);

    return sheetPath;
}

// ==================== 메인 ====================
async function main() {
    log('========================================');
    log('QA Contact Sheet 생성 시작');
    log('========================================\n');

    // 출력 디렉토리 생성
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // 1. 제품 수집
    log('📦 NocoDB에서 제품 수집 중...');
    const products = await getAllProducts();
    log(`✅ 총 ${products.length}개 제품 수집 완료\n`);

    if (products.length === 0) {
        log('이미지가 있는 제품이 없습니다.');
        return;
    }

    const totalSheets = Math.ceil(products.length / MAX_PRODUCTS_PER_SHEET);
    log(`📊 예상 시트: ${totalSheets}장 (제품당 최대 ${MAX_IMAGES_PER_ROW}장)\n`);

    // 2. 제품별 처리
    const allRows = [];

    for (let pi = 0; pi < products.length; pi++) {
        const product = products[pi];
        const titleEn = product.title_en || 'Unknown';

        try {
            const { images, sourceStr } = collectImages(product);

            if (images.length === 0) {
                log(`⏭️  [${pi + 1}/${products.length}] ${titleEn.substring(0, 40)} - 이미지 없음`);
                continue;
            }

            // 순차 다운로드
            const thumbnails = [];
            for (let ii = 0; ii < images.length; ii++) {
                const thumb = await downloadAndResize(images[ii].url);
                thumbnails.push(thumb);
                if (ii < images.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, DOWNLOAD_DELAY_MS));
                }
            }

            allRows.push({
                globalIndex: pi + 1,
                titleEn,
                sourceStr,
                thumbnails
            });

            const shortTitle = titleEn.length > 40 ? titleEn.substring(0, 40) + '...' : titleEn;
            log(`📸 [${pi + 1}/${products.length}] ${shortTitle} - ${images.length}장 처리`);

        } catch (error) {
            log(`❌ [${pi + 1}/${products.length}] ${titleEn.substring(0, 40)} - 실패: ${error.message}`);
        }
    }

    if (allRows.length === 0) {
        log('처리된 제품이 없습니다.');
        return;
    }

    // 3. 시트 생성
    log(`\n📐 시트 생성 중... (${allRows.length}개 제품)`);
    const sheetPaths = [];

    for (let si = 0; si < Math.ceil(allRows.length / MAX_PRODUCTS_PER_SHEET); si++) {
        const start = si * MAX_PRODUCTS_PER_SHEET;
        const end = Math.min(start + MAX_PRODUCTS_PER_SHEET, allRows.length);
        const batch = allRows.slice(start, end);

        const sheetPath = await createSheet(batch, si + 1);
        sheetPaths.push(sheetPath);
    }

    // 4. GitHub Push
    log('\n📤 GitHub에 push 중...');
    try {
        execSync('cd /root/copychu-scraper && git add qa-sheets/ && git commit -m "QA: contact sheet images" && git push', { stdio: 'inherit' });
        log('✅ GitHub push 완료!');
        log('\n📎 GitHub에서 확인:');
        sheetPaths.forEach((p, i) => {
            log(`   시트 ${i + 1}: https://raw.githubusercontent.com/freshwill2-hub/wapcha/main/qa-sheets/${path.basename(p)}`);
        });
    } catch (error) {
        log('⚠️  GitHub push 실패:', error.message);
        log('수동으로 push하세요: git add qa-sheets/ && git commit -m "QA: contact sheet images" && git push');
    }

    log('\n========================================');
    log(`📄 총 ${sheetPaths.length}장 시트 생성 완료`);
    sheetPaths.forEach((p, i) => {
        log(`   시트 ${i + 1}: ${p}`);
    });
    log('========================================');
}

main().catch(error => {
    console.error('❌ Contact Sheet 생성 실패:', error);
    process.exit(1);
});
