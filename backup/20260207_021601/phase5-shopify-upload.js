import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// ==================== 환경 변수 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;

// Shopify 설정
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'wap-au.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';

// ==================== 로그 시스템 ====================
const SYDNEY_TIMEZONE = 'Australia/Sydney';
const LOG_DIR = path.join(process.cwd(), 'logs');

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

// ✅ 통합 로그 경로 (파이프라인 실행 시 설정됨)
const UNIFIED_LOG_PATH = process.env.UNIFIED_LOG_PATH || null;

const LOG_FILENAME = `phase5_${getSydneyTimeForFile()}.log`;
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
    const separator = '═══ PHASE 5: Shopify 업로드 시작 ═══';
    try {
        fs.appendFileSync(UNIFIED_LOG_PATH, `\n${separator}\n`);
    } catch (e) {
        // 무시
    }
}

// ==================== 초기화 ====================
console.log('🚀 Phase 5: Shopify 제품 업로드 (v2.1 - NocoDB 수정)');
console.log('='.repeat(70));
console.log('🔧 설정 확인:');
console.log(`   - NocoDB URL: ${NOCODB_API_URL}`);
console.log(`   - Shopify Store: ${SHOPIFY_STORE_URL}`);
console.log(`   - Shopify API Version: ${SHOPIFY_API_VERSION}`);
console.log(`   - Shopify Table ID: ${SHOPIFY_TABLE_ID}`);
console.log(`   - 시간대: ${SYDNEY_TIMEZONE}`);
console.log(`   - 로그 파일: ${LOG_PATH}`);
console.log('');
console.log('✨ v2.1 변경사항:');
console.log('   ✅ 이미지를 Base64로 인코딩하여 Shopify에 직접 업로드');
console.log('   ✅ NocoDB 업데이트 시 shopify_status 제외 (SingleSelect 타입 문제)');
console.log('   ✅ NocoDB PATCH 요청을 배열로 감싸서 올바르게 업데이트');
console.log('');

// ==================== 통계 ====================
const stats = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0
};

// ==================== Shopify API 클라이언트 ====================
const shopifyApi = axios.create({
    baseURL: `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
    },
    timeout: 120000  // 이미지 업로드 때문에 타임아웃 증가
});

// ==================== 브랜드명 추출 ====================
function extractBrandFromTitle(title) {
    if (!title) return 'K-Beauty';
    
    const words = title.trim().split(/\s+/);
    if (words.length > 0) {
        const brand = words[0];
        if (brand.length < 2 || /^\d/.test(brand)) {
            return 'K-Beauty';
        }
        return brand;
    }
    return 'K-Beauty';
}

// ==================== NocoDB에서 업로드 대기 제품 가져오기 ====================
async function getProductsToUpload(limit = 10) {
    try {
        log(`📥 NocoDB에서 업로드 대기 제품 가져오는 중 (limit: ${limit})...`);
        
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    limit: limit,
                    where: '(main_image,notnull)~and(shopify_product_id,is,null)'
                }
            }
        );
        
        const products = response.data.list || [];
        log(`✅ ${products.length}개 제품 발견 (업로드 대기)`);
        
        return products;
        
    } catch (error) {
        log(`❌ 제품 조회 실패:`, error.message);
        if (error.response) {
            log(`   응답:`, JSON.stringify(error.response.data));
        }
        return [];
    }
}

// ==================== 이미지 URL 구성 ====================
function getImageUrl(imageData) {
    if (!imageData) return null;
    
    const img = Array.isArray(imageData) ? imageData[0] : imageData;
    
    if (!img) return null;
    
    if (img.url) {
        return img.url;
    }
    
    if (img.path) {
        return `${NOCODB_API_URL}/${img.path}`;
    }
    
    if (img.signedPath) {
        return `${NOCODB_API_URL}/${img.signedPath}`;
    }
    
    return null;
}

// ==================== ✅ 이미지 다운로드 및 Base64 변환 ====================
async function downloadImageAsBase64(imageUrl) {
    try {
        log(`      📥 이미지 다운로드 중: ${imageUrl.substring(0, 60)}...`);
        
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const base64 = Buffer.from(response.data).toString('base64');
        const contentType = response.headers['content-type'] || 'image/png';
        
        log(`      ✅ Base64 변환 완료 (${(base64.length / 1024).toFixed(1)}KB)`);
        
        return base64;
        
    } catch (error) {
        log(`      ❌ 이미지 다운로드 실패: ${error.message}`);
        return null;
    }
}

// ==================== Shopify 제품 생성 (Base64 이미지) ====================
async function createShopifyProduct(product) {
    const { Id, title_en, description_en, price_aud, main_image, gallery_images, oliveyoung_product_id } = product;
    
    log(`\n${'='.repeat(70)}`);
    log(`📦 제품 업로드 시작 - ID: ${Id}`);
    log(`   제품명: ${title_en || 'N/A'}`);
    log(`   가격: $${price_aud || 'N/A'}`);
    log(`   SKU: ${oliveyoung_product_id || 'N/A'}`);
    
    try {
        // 1. 이미지 수집 및 Base64 변환
        const images = [];
        
        // 메인 이미지
        const mainImageUrl = getImageUrl(main_image);
        if (mainImageUrl) {
            log(`   🖼️  메인 이미지 처리 중...`);
            const base64 = await downloadImageAsBase64(mainImageUrl);
            if (base64) {
                images.push({ attachment: base64, position: 1 });
            }
        } else {
            log(`   ⚠️  메인 이미지 없음`);
        }
        
        // 갤러리 이미지
        if (gallery_images && Array.isArray(gallery_images)) {
            for (let i = 0; i < gallery_images.length; i++) {
                const url = getImageUrl(gallery_images[i]);
                if (url) {
                    log(`   🖼️  갤러리 이미지 ${i + 1} 처리 중...`);
                    const base64 = await downloadImageAsBase64(url);
                    if (base64) {
                        images.push({ attachment: base64, position: i + 2 });
                    }
                }
                
                // 이미지 다운로드 사이 딜레이
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        if (images.length === 0) {
            log(`   ❌ 이미지가 없어서 업로드 스킵`);
            stats.skipped++;
            return null;
        }
        
        log(`   ✅ 총 ${images.length}개 이미지 준비 완료`);
        
        // 2. 브랜드명 추출
        const vendor = extractBrandFromTitle(title_en);
        log(`   🏷️  브랜드: ${vendor}`);
        
        // 3. Shopify 제품 데이터 구성
        const productData = {
            product: {
                title: title_en || `Product ${Id}`,
                body_html: description_en || '',
                vendor: vendor,
                product_type: 'K-Beauty',
                status: 'active',
                variants: [
                    {
                        price: String(price_aud || 0),
                        sku: oliveyoung_product_id || `OY-${Id}`,
                        inventory_management: null,
                        inventory_policy: 'continue',
                        requires_shipping: true,
                        weight: 0.5,
                        weight_unit: 'kg'
                    }
                ],
                images: images  // ✅ Base64 인코딩된 이미지
            }
        };
        
        log(`\n   📤 Shopify API 호출 중...`);
        
        // 4. Shopify API 호출
        const response = await shopifyApi.post('/products.json', productData);
        
        const shopifyProduct = response.data.product;
        const shopifyProductId = shopifyProduct.id;
        
        log(`   ✅ Shopify 제품 생성 완료!`);
        log(`   🆔 Shopify Product ID: ${shopifyProductId}`);
        log(`   🖼️  업로드된 이미지: ${shopifyProduct.images?.length || 0}개`);
        log(`   🔗 URL: https://${SHOPIFY_STORE_URL}/admin/products/${shopifyProductId}`);
        
        // 5. NocoDB 업데이트
        await updateNocoDBProduct(Id, shopifyProductId);
        
        stats.success++;
        return shopifyProductId;
        
    } catch (error) {
        log(`   ❌ Shopify 업로드 실패:`, error.message);
        
        if (error.response) {
            log(`   📝 응답 상태: ${error.response.status}`);
            log(`   📝 응답 내용:`, JSON.stringify(error.response.data, null, 2));
            
            if (error.response.status === 401) {
                log(`   ⚠️  인증 실패 - Access Token을 확인해주세요`);
            } else if (error.response.status === 422) {
                log(`   ⚠️  데이터 유효성 오류 - 제품 데이터를 확인해주세요`);
            } else if (error.response.status === 429) {
                log(`   ⚠️  Rate Limit - 잠시 후 다시 시도`);
            }
        }
        
        stats.failed++;
        return null;
    }
}

// ==================== ✅ NocoDB 업데이트 (v2.1 수정됨) ====================
async function updateNocoDBProduct(recordId, shopifyProductId) {
    try {
        log(`   💾 NocoDB 업데이트 중 (ID: ${recordId})...`);
        
        const uploadedAt = new Date().toISOString();
        
        // ✅ v2.1 수정: 배열로 감싸서 전송
        // shopify_status 제외 (SingleSelect 타입 문제)
        // shopify_product_id와 uploaded_at만 업데이트
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            [{  // ✅ 배열로 감싸기!
                Id: recordId,
                shopify_product_id: String(shopifyProductId),
                uploaded_at: uploadedAt
            }],
            {
                headers: { 
                    'xc-token': NOCODB_API_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        log(`   ✅ NocoDB 업데이트 완료`);
        return true;
        
    } catch (error) {
        log(`   ⚠️  NocoDB 업데이트 실패:`, error.message);
        if (error.response) {
            log(`   📝 응답:`, JSON.stringify(error.response.data));
        }
        return false;
    }
}

// ==================== Shopify API 연결 테스트 ====================
async function testShopifyConnection() {
    try {
        log(`🔌 Shopify API 연결 테스트 중...`);
        
        const response = await shopifyApi.get('/shop.json');
        const shop = response.data.shop;
        
        log(`✅ Shopify 연결 성공!`);
        log(`   🏪 스토어명: ${shop.name}`);
        log(`   🌐 도메인: ${shop.domain}`);
        log(`   💰 통화: ${shop.currency}`);
        log(`   🌍 국가: ${shop.country_name}`);
        log('');
        
        return true;
        
    } catch (error) {
        log(`❌ Shopify 연결 실패:`, error.message);
        
        if (error.response) {
            log(`   상태 코드: ${error.response.status}`);
            
            if (error.response.status === 401) {
                log(`   ⚠️  인증 실패! Access Token을 확인해주세요.`);
                log(`   현재 토큰: ${SHOPIFY_ACCESS_TOKEN?.substring(0, 10)}...`);
            }
        }
        
        return false;
    }
}

// ==================== 메인 함수 ====================
async function main() {
    const limit = parseInt(process.env.PRODUCT_LIMIT) || 10;
    
    log('🚀 Phase 5 시작');
    log('='.repeat(70));
    log('');
    
    // 1. Shopify 연결 테스트
    const connected = await testShopifyConnection();
    if (!connected) {
        log('❌ Shopify 연결 실패로 종료');
        logStream.end();
        process.exit(1);
    }
    
    // 2. 업로드 대기 제품 조회
    const products = await getProductsToUpload(limit);
    
    if (products.length === 0) {
        log('ℹ️  업로드할 제품이 없습니다.');
        log('');
        log('💡 조건:');
        log('   - main_image 필드가 있어야 함');
        log('   - shopify_product_id 필드가 비어있어야 함');
        log('');
        log('💡 Phase 4까지 먼저 실행해주세요:');
        log('   node phase4-final-data.js');
        logStream.end();
        return;
    }
    
    stats.total = products.length;
    log(`\n📦 총 ${stats.total}개 제품 업로드 시작`);
    log('='.repeat(70));
    
    // 3. 각 제품 업로드
    for (let i = 0; i < products.length; i++) {
        const product = products[i];
        
        log(`\n[${i + 1}/${products.length}] 처리 중...`);
        
        await createShopifyProduct(product);
        
        // Rate limiting (이미지 업로드 때문에 5초로 증가)
        if (i < products.length - 1) {
            log(`\n⏳ 5초 대기 (Shopify Rate Limit + 이미지 처리)...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    // 4. 최종 결과
    log('');
    log('='.repeat(70));
    log('🎉 Phase 5 완료!');
    log('='.repeat(70));
    log(`📊 결과:`);
    log(`   - 총 제품: ${stats.total}개`);
    log(`   - 성공: ${stats.success}개`);
    log(`   - 실패: ${stats.failed}개`);
    log(`   - 스킵: ${stats.skipped}개`);
    log('');
    log(`📝 로그 파일: ${LOG_PATH}`);
    log('');
    log(`🔗 Shopify Admin에서 확인:`);
    log(`   https://${SHOPIFY_STORE_URL}/admin/products`);
    
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