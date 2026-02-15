import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const execAsync = promisify(exec);

// ==================== 로그 시스템 설정 ====================
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
                const fileAge = now - stats.mtime.getTime();
                
                if (fileAge > maxAge) {
                    fs.unlinkSync(filePath);
                    deletedFiles.push(file);
                }
            } catch (error) {
                // 파일 삭제 실패 시 무시
            }
        }
    } catch (error) {
        // 디렉토리 읽기 실패 시 무시
    }
    
    return deletedFiles;
}

// ✅ 시작 시 오래된 로그 삭제
const deletedLogs = cleanupOldLogs();

// ✅ 통합 로그 경로 (파이프라인 실행 시 설정됨)
const UNIFIED_LOG_PATH = process.env.UNIFIED_LOG_PATH || null;

const LOG_FILENAME = `phase2_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(...args) {
    const timestamp = `[${getSydneyTime()}]`;
    const message = args.join(' ');
    console.log(timestamp, message);
    logStream.write(`${timestamp} ${message}\n`);

    // ✅ 통합 로그에도 기록
    if (UNIFIED_LOG_PATH) {
        try {
            fs.appendFileSync(UNIFIED_LOG_PATH, `${timestamp} ${message}\n`);
        } catch (e) {
            // 통합 로그 기록 실패 시 무시
        }
    }
}

// ✅ 통합 로그에 Phase 시작 구분선 추가
if (UNIFIED_LOG_PATH) {
    const separator = '═══ PHASE 2: 배경 제거 시작 ═══';
    try {
        fs.appendFileSync(UNIFIED_LOG_PATH, `\n${separator}\n`);
    } catch (e) {
        // 무시
    }
}

// ==================== 환경 변수 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;

// rembg 경로 (가상환경 내부)
const REMBG_PATH = '/root/copychu-scraper/rembg-env/bin/rembg';
const PYTHON_PATH = '/root/copychu-scraper/rembg-env/bin/python';

log('🚀 Phase 2: 배경 제거 + 흰색 배경 (rembg - 오픈소스)');
log('='.repeat(70));
log('🔧 설정 확인:');
log(`   - NocoDB URL: ${NOCODB_API_URL}`);
log(`   - Oliveyoung Table: ${OLIVEYOUNG_TABLE_ID}`);
log(`   - Shopify Table: ${SHOPIFY_TABLE_ID}`);
log(`   - rembg 경로: ${REMBG_PATH}`);
log(`   - 로그 파일: ${LOG_PATH}`);
if (deletedLogs.length > 0) {
    log(`🧹 오래된 로그 ${deletedLogs.length}개 삭제됨 (${LOG_RETENTION_DAYS}일 이상)`);
}
log('='.repeat(70) + '\n');

// ==================== 가격 변환 함수 (KRW → AUD) ====================
function convertKRWtoAUD(priceOriginal) {
    if (!priceOriginal || priceOriginal === 0) {
        log(`   ⚠️  가격 정보 없음 → 최저가 $39 적용`);
        return 39;
    }
    
    log(`   💰 가격 변환 시작: ₩${priceOriginal.toLocaleString()}`);
    
    const hundreds = Math.floor((priceOriginal % 1000) / 100);
    const roundedPrice = Math.floor(priceOriginal / 1000) * 1000 + (hundreds > 0 ? 1000 : 0);
    log(`      1단계 (백원 반올림): ₩${priceOriginal.toLocaleString()} → ₩${roundedPrice.toLocaleString()}`);
    
    const step1 = roundedPrice / 1000;
    log(`      2단계 (÷1000): ${step1}`);
    
    const step2 = step1 * 3;
    log(`      3단계 (×3): ${step2}`);
    
    let beforeAdjust = Math.round(step2);
    
    const lastDigit = beforeAdjust % 10;
    let finalPrice;
    
    if (lastDigit === 0) {
        finalPrice = beforeAdjust - 1;
        log(`      4단계 (0으로 끝남 → -1): ${beforeAdjust} → ${finalPrice}`);
    } else {
        finalPrice = Math.floor(beforeAdjust / 10) * 10 + 9;
        log(`      4단계 (마지막 자리 → 9): ${beforeAdjust} → ${finalPrice}`);
    }
    
    if (finalPrice < 39) {
        log(`      5단계 (최저가 체크): ${finalPrice} → 39`);
        finalPrice = 39;
    } else {
        log(`      5단계 (최저가 체크): ${finalPrice} ✓`);
    }
    
    log(`   ✅ 최종 가격: $${finalPrice}`);
    return finalPrice;
}

// 임시 파일 정리
const cleanupFiles = (...files) => {
    files.forEach(file => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
};

// NocoDB에서 제품 가져오기
async function getProducts(limit = 3) {
    log(`\n📥 tb_oliveyoung_products에서 제품 가져오는 중 (limit: ${limit})...`);

    const pageSize = 200;
    let allProducts = [];
    let offset = 0;

    while (true) {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { limit: pageSize, offset: offset, where: '(product_images,notnull)' }
            }
        );

        const records = response.data.list;
        if (records.length === 0) break;
        allProducts = allProducts.concat(records);
        if (records.length < pageSize) break;
        offset += pageSize;
    }

    const productsWithImages = allProducts.filter(p =>
        p.product_images && p.product_images.length > 0
    );

    log(`   📋 이미지 있는 제품: ${productsWithImages.length}개`);

    const processedIds = new Set();
    let shopifyOffset = 0;

    while (true) {
        const shopifyResponse = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    offset: shopifyOffset,
                    limit: pageSize,
                    fields: 'Id,ai_product_images'
                }
            }
        );

        const shopifyProducts = shopifyResponse.data.list;
        if (shopifyProducts.length === 0) break;

        shopifyProducts.forEach(p => {
            // ✅ v14: ai_product_images 유무와 관계없이 Id 존재만으로 처리 완료 판단
            // (레코드가 있으면 getOrCreateShopifyProduct에서 업데이트하므로 중복 생성 방지)
            if (p.ai_product_images && p.ai_product_images.length > 0) {
                processedIds.add(p.Id);
            }
        });

        if (shopifyProducts.length < pageSize) break;
        shopifyOffset += pageSize;
    }

    log(`   ✅ Phase 2 완료된 제품: ${processedIds.size}개`);

    const newProducts = productsWithImages.filter(p => !processedIds.has(p.Id));

    log(`   🆕 Phase 2 처리 필요: ${newProducts.length}개`);

    if (newProducts.length === 0) {
        log('   ℹ️  모든 제품이 이미 Phase 2 처리되었습니다.');
    }

    const result = newProducts.slice(0, limit);
    log(`✅ ${result.length}개 제품 가져옴 (미처리 + 이미지 있음)`);
    return result;
}

// NocoDB에서 Shopify 제품 확인/생성
async function getOrCreateShopifyProduct(oliveyoungProduct) {
    const productId = oliveyoungProduct.Id;
    
    log(`\n🔍 tb_shopify_products에서 제품 확인 중 (ID: ${productId})...`);
    
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: { where: `(Id,eq,${productId})` }
            }
        );
        
        if (response.data.list.length > 0) {
            log('✅ 기존 Shopify 제품 발견 - 필드 업데이트 중...');
            
            const updateData = {
                Id: productId,
                oliveyoung_product_id: oliveyoungProduct.sku || null,
                title_kr: oliveyoungProduct.title_kr || null,
                title_en: oliveyoungProduct.title_en || null,
                description_en: oliveyoungProduct.description_en || null,
                price_aud: convertKRWtoAUD(oliveyoungProduct.price_original)
            };
            
            log(`📋 업데이트할 데이터:`);
            log(`   - oliveyoung_product_id: ${updateData.oliveyoung_product_id}`);
            log(`   - title_kr: ${updateData.title_kr?.substring(0, 30)}...`);
            log(`   - title_en: ${updateData.title_en?.substring(0, 30)}...`);
            log(`   - description_en: ${updateData.description_en ? '✓ (있음)' : '✗ (없음)'}`);
            log(`   - price_aud: $${updateData.price_aud}`);
            
            await axios.patch(
                `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
                [updateData],  // ✅ NocoDB v2: 배열
                { headers: { 'xc-token': NOCODB_API_TOKEN } }
            );
            
            log('✅ Shopify 제품 업데이트 완료');
            return response.data.list[0];
        }
        
        log('📝 새 Shopify 제품 생성 중...');
        
        const priceAUD = convertKRWtoAUD(oliveyoungProduct.price_original);
        
        const newProductData = {
            Id: productId,
            oliveyoung_product_id: oliveyoungProduct.sku || null,
            title_kr: oliveyoungProduct.title_kr || null,
            title_en: oliveyoungProduct.title_en || null,
            description_en: oliveyoungProduct.description_en || null,
            price_aud: priceAUD
        };
        
        log(`📋 생성할 데이터:`);
        log(`   - Id: ${newProductData.Id}`);
        log(`   - oliveyoung_product_id: ${newProductData.oliveyoung_product_id}`);
        log(`   - title_kr: ${newProductData.title_kr?.substring(0, 30)}...`);
        log(`   - title_en: ${newProductData.title_en?.substring(0, 30)}...`);
        log(`   - description_en: ${newProductData.description_en ? '✓ (있음)' : '✗ (없음)'}`);
        log(`   - price_aud: $${newProductData.price_aud}`);
        
        const createResponse = await axios.post(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            newProductData,
            { headers: { 'xc-token': NOCODB_API_TOKEN } }
        );
        
        log('✅ Shopify 제품 생성 완료');
        return createResponse.data;
        
    } catch (error) {
        log('❌ Shopify 제품 확인/생성 실패:', error.message);
        if (error.response) {
            log('   응답 데이터:', JSON.stringify(error.response.data));
        }
        throw error;
    }
}

// 이미지 다운로드
async function downloadImage(imageUrl, outputPath) {
    log(`📥 이미지 다운로드 중...`);
    log(`   URL: ${imageUrl.substring(0, 80)}...`);
    
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    
    fs.writeFileSync(outputPath, response.data);
    const sizeKB = (response.data.length / 1024).toFixed(1);
    log(`   ✅ 다운로드 완료 (${sizeKB}KB)`);
}

// rembg로 배경 제거 + 흰색 배경 추가
async function removeBackgroundWithWhite(inputPath, outputPath) {
    log(`\n🎨 배경 제거 중 (rembg)...`);
    log(`   입력: ${inputPath}`);
    
    try {
        const startTime = Date.now();
        const tempTransparent = outputPath.replace('.png', '_temp.png');
        
        await execAsync(`${REMBG_PATH} i "${inputPath}" "${tempTransparent}"`);
        
        const pythonScriptPath = `/tmp/add_white_bg_${Date.now()}.py`;
        const pythonScript = `from PIL import Image

img = Image.open('${tempTransparent}').convert('RGBA')
white_bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
white_bg.paste(img, (0, 0), img)
white_bg.convert('RGB').save('${outputPath}', 'PNG')
print('✅ 흰색 배경 추가 완료')
`;
        
        fs.writeFileSync(pythonScriptPath, pythonScript);
        await execAsync(`${PYTHON_PATH} "${pythonScriptPath}"`);
        
        cleanupFiles(tempTransparent, pythonScriptPath);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (fs.existsSync(outputPath)) {
            const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
            log(`   ✅ 배경 제거 + 흰색 배경 완료 (${sizeKB}KB, ${duration}초 소요)`);
            return true;
        } else {
            log('   ❌ 출력 파일 생성 실패');
            return false;
        }
        
    } catch (error) {
        log('   ❌ 배경 제거 실패:', error.message);
        if (error.stderr) log('   stderr:', error.stderr);
        return false;
    }
}

// NocoDB에 이미지 업로드
async function uploadToNocoDB(filePath, fileName) {
    log(`\n📤 NocoDB 업로드: ${fileName}`);
    
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), fileName);
        
        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/storage/upload`,
            formData,
            {
                headers: {
                    'xc-token': NOCODB_API_TOKEN,
                    ...formData.getHeaders()
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );
        
        log('   ✅ 업로드 성공');
        return response.data;
        
    } catch (error) {
        log('   ❌ 업로드 실패:', error.message);
        throw error;
    }
}

// Shopify 테이블에 AI 이미지 저장
async function saveAIImages(shopifyProductId, imageDataArray) {
    log(`\n📝 tb_shopify_products에 AI 이미지 저장 중 (ID: ${shopifyProductId})...`);
    
    try {
        log(`🗑️  기존 ai_product_images 삭제 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            [{ Id: shopifyProductId, ai_product_images: null }],  // ✅ 배열
            { headers: { 'xc-token': NOCODB_API_TOKEN } }
        );
        
        log(`💾 새 ai_product_images 저장 중...`);
        const response = await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            [{ Id: shopifyProductId, ai_product_images: imageDataArray }],  // ✅ 배열
            { headers: { 'xc-token': NOCODB_API_TOKEN } }
        );
        
        log(`✅ AI 이미지 저장 완료! (필드: ai_product_images)`);
        return response.data;
        
    } catch (error) {
        log('❌ AI 이미지 저장 실패:', error.message);
        throw error;
    }
}

// 메인 함수
async function main() {
    const limit = parseInt(process.env.PRODUCT_LIMIT) || 1000;
    
    try {
        const products = await getProducts(limit);
        
        if (products.length === 0) {
            log('\n⚠️  처리할 제품이 없습니다.');
            logStream.end();
            return;
        }
        
        let successCount = 0;
        let failedCount = 0;
        
        for (const product of products) {
            log(`\n📦 제품: ${product.title_kr}`);
            log('='.repeat(70));
            
            const shopifyProduct = await getOrCreateShopifyProduct(product);
            
            if (!product.product_images || product.product_images.length === 0) {
                log('⚠️  원본 이미지가 없습니다. 건너뜁니다.');
                continue;
            }
            
            log(`\n🖼️  원본 이미지: ${product.product_images.length}개`);
            
            const processedImages = [];
            
            for (let i = 0; i < product.product_images.length; i++) {
                const img = product.product_images[i];
                log(`\n[${i + 1}/${product.product_images.length}] 이미지 처리 중...`);
                
                let imageUrl = img.url;
                if (!imageUrl && img.path) {
                    imageUrl = `${NOCODB_API_URL}/${img.path}`;
                }
                
                if (!imageUrl) {
                    log('⚠️  이미지 URL을 찾을 수 없습니다. 건너뜁니다.');
                    continue;
                }
                
                const timestamp = Date.now();
                const inputPath = `/tmp/input-${timestamp}-${i}.jpg`;
                const outputPath = `/tmp/output-${timestamp}-${i}.png`;
                
                try {
                    await downloadImage(imageUrl, inputPath);
                    
                    const success = await removeBackgroundWithWhite(inputPath, outputPath);
                    
                    if (success) {
                        const fileName = `white-bg-${product.Id}-${i + 1}-${timestamp}.png`;
                        const uploadedData = await uploadToNocoDB(outputPath, fileName);

                        // ✅ v14: rembg 전 원본 URL 보존
                        const uploadInfo = uploadedData[0];
                        uploadInfo.originalUrl = imageUrl;
                        processedImages.push(uploadInfo);
                        log(`   ✅ 이미지 ${i + 1} 처리 완료`);
                    }
                    
                } catch (error) {
                    log(`   ❌ 이미지 ${i + 1} 처리 실패:`, error.message);
                } finally {
                    cleanupFiles(inputPath, outputPath);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            if (processedImages.length > 0) {
                await saveAIImages(shopifyProduct.Id, processedImages);
                successCount++;
                
                log('\n' + '='.repeat(70));
                log('🎉 완료!');
                log('='.repeat(70));
                log(`📦 제품: ${product.title_kr}`);
                log(`🖼️  원본 이미지: ${product.product_images.length}개`);
                log(`✨ 흰색 배경 이미지: ${processedImages.length}개`);
                log(`💰 가격: $${shopifyProduct.price_aud || 'N/A'}`);
                log(`💰 비용: $0 (오픈소스)`);
                log(`✅ 저장 위치: tb_shopify_products (ID: ${shopifyProduct.Id})`);
            } else {
                log('\n⚠️  처리된 이미지가 없습니다.');
                failedCount++;
            }
        }
        
        log('\n' + '='.repeat(70));
        log('🎉 Phase 2 완료!');
        log('='.repeat(70));
        log(`📊 결과:`);
        log(`   - 성공: ${successCount}개`);
        log(`   - 실패: ${failedCount}개`);
        log(`📝 로그 파일: ${LOG_PATH}`);
        log(`\n💡 다음 단계: node phase3-multi-3products.js`);
        
    } catch (error) {
        log('\n❌ 오류 발생:', error.message);
        if (error.response) {
            log('Response:', JSON.stringify(error.response.data));
        }
    }
    
    logStream.end();
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('');
    log('⚠️  SIGINT 수신 - 안전하게 종료 중...');
    logStream.end();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('');
    log('⚠️  SIGTERM 수신 - 안전하게 종료 중...');
    logStream.end();
    process.exit(0);
});

// 실행
main();
