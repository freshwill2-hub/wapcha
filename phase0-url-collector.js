import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import fs from 'fs';
import path from 'path';

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

// ✅ v2.2: 통합 로그 경로 지원
const UNIFIED_LOG_PATH = process.env.UNIFIED_LOG_PATH || null;

const LOG_FILENAME = `phase0_${getSydneyTimeForFile()}.log`;
const LOG_PATH = path.join(LOG_DIR, LOG_FILENAME);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(...args) {
    const timestamp = `[${getSydneyTime()}]`;
    const message = args.join(' ');
    console.log(timestamp, message);
    logStream.write(`${timestamp} ${message}\n`);
    
    // ✅ v2.2: 통합 로그에도 기록
    if (UNIFIED_LOG_PATH) {
        try {
            fs.appendFileSync(UNIFIED_LOG_PATH, `${timestamp} ${message}\n`);
        } catch (e) {
            // 통합 로그 기록 실패 시 무시
        }
    }
}

// ✅ v2.2: 통합 로그에 Phase 시작 구분선 추가
if (UNIFIED_LOG_PATH) {
    const separator = '═══ PHASE 0: URL 수집 시작 ═══';
    try {
        fs.appendFileSync(UNIFIED_LOG_PATH, `\n${separator}\n`);
    } catch (e) {
        // 무시
    }
}

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;

// ✅ Shopify 설정 추가
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'wap-au.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';

// 환경변수 또는 인자로 받기
const CATEGORY_URL = process.env.CATEGORY_URL || process.argv[2];
const MAX_PRODUCTS = parseInt(process.env.MAX_PRODUCTS) || parseInt(process.argv[3]) || 100;
const MAX_PAGES = parseInt(process.env.MAX_PAGES) || parseInt(process.argv[4]) || 0;
const UNLIMITED_PAGES = MAX_PAGES === 0;

log('🚀 Phase 0: 올리브영 URL 수집기 (v2.2 - 페이지네이션 개선)');
log('='.repeat(70));
log(`📂 카테고리 URL: ${CATEGORY_URL}`);
log(`📊 최대 수집 개수: ${MAX_PRODUCTS}`);
log(`📄 최대 페이지 수: ${UNLIMITED_PAGES ? '무제한 (마지막까지)' : MAX_PAGES}`);
log(`💾 저장 테이블: ${OLIVEYOUNG_TABLE_ID}`);
log(`🛒 Shopify 스토어: ${SHOPIFY_STORE_URL}`);
log(`📝 로그 파일: ${LOG_PATH}`);
if (UNIFIED_LOG_PATH) {
    log(`📝 통합 로그: ${path.basename(UNIFIED_LOG_PATH)}`);
}
if (deletedLogs.length > 0) {
    log(`🧹 오래된 로그 ${deletedLogs.length}개 삭제됨 (${LOG_RETENTION_DAYS}일 이상)`);
}
log('='.repeat(70));
log('');
log('✨ v2.2 변경사항:');
log('   ✅ 연속 빈 페이지 감지 로직 추가 (3번 연속 시 종료)');
log('   ✅ 페이지 변경 후 확인 로직 강화');
log('   ✅ 통합 로그 시스템 지원');
log('   ✅ 페이지당 수집량 로깅 개선');
log('='.repeat(70) + '\n');

// ==================== ✅ NEW: Shopify에서 기존 SKU 가져오기 ====================
async function getShopifyExistingSkus() {
    if (!SHOPIFY_ACCESS_TOKEN) {
        log('⚠️  Shopify Access Token 없음 - Shopify 중복 체크 스킵');
        return new Set();
    }
    
    try {
        log('🛒 Shopify에서 기존 제품 SKU 가져오는 중...');
        
        const shopifySkus = new Set();
        let nextPageUrl = `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,variants`;
        
        while (nextPageUrl) {
            const response = await axios.get(nextPageUrl, {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            
            const products = response.data.products || [];
            
            // 각 제품의 variants에서 SKU 추출
            for (const product of products) {
                if (product.variants && Array.isArray(product.variants)) {
                    for (const variant of product.variants) {
                        if (variant.sku && variant.sku.trim()) {
                            shopifySkus.add(variant.sku.trim());
                        }
                    }
                }
            }
            
            // 페이지네이션: Link 헤더에서 다음 페이지 URL 추출
            const linkHeader = response.headers['link'];
            nextPageUrl = null;
            
            if (linkHeader) {
                const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (nextMatch) {
                    nextPageUrl = nextMatch[1];
                }
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        log(`✅ Shopify 기존 SKU ${shopifySkus.size}개 확인됨\n`);
        return shopifySkus;
        
    } catch (error) {
        log('⚠️  Shopify SKU 조회 실패:', error.message);
        if (error.response?.status === 401) {
            log('   → Access Token을 확인해주세요');
        }
        log('   → Shopify 중복 체크 없이 계속 진행합니다\n');
        return new Set();
    }
}

// ==================== NocoDB: 기존 SKU 확인 ====================
async function getExistingSkus() {
    try {
        log('📥 NocoDB에서 기존 SKU 목록 가져오는 중...');
        
        const allSkus = new Set();
        let offset = 0;
        const limit = 100;
        
        while (true) {
            const response = await axios.get(
                `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
                {
                    headers: { 'xc-token': NOCODB_TOKEN },
                    params: { 
                        limit: limit, 
                        offset: offset,
                        fields: 'sku'
                    }
                }
            );
            
            const records = response.data.list;
            if (records.length === 0) break;
            
            records.forEach(r => {
                if (r.sku) {
                    allSkus.add(r.sku);
                }
            });
            
            offset += limit;
            if (records.length < limit) break;
        }
        
        log(`✅ NocoDB 기존 SKU ${allSkus.size}개 확인됨\n`);
        return allSkus;
        
    } catch (error) {
        log('❌ NocoDB SKU 조회 실패:', error.message);
        return new Set();
    }
}

// ==================== NocoDB: 제품 URL만 저장 (경량) ====================
async function saveProductUrl(productData) {
    try {
        const response = await axios.post(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            productData,
            {
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
        
    } catch (error) {
        // 중복 에러는 무시
        if (error.response?.status === 422 || error.message.includes('duplicate')) {
            return null;
        }
        log('❌ 저장 실패:', error.message);
        return null;
    }
}

// ==================== 메인: 카테고리 스크래핑 (경량 버전) ====================
async function collectUrls() {
    if (!CATEGORY_URL) {
        log('❌ 카테고리 URL이 필요합니다!');
        log('\n사용법:');
        log('  node phase0-url-collector.js "카테고리URL" [최대개수] [최대페이지수]');
        logStream.end();
        return;
    }
    
    // ✅ Step 1: Shopify 기존 SKU 확인 (가장 먼저!)
    const shopifySkus = await getShopifyExistingSkus();
    
    // ✅ Step 2: NocoDB 기존 SKU 확인
    const nocodbSkus = await getExistingSkus();
    
    // ✅ Step 3: 모든 기존 SKU 합치기
    const allExistingSkus = new Set([...shopifySkus, ...nocodbSkus]);
    log('📊 중복 체크 요약:');
    log(`   - Shopify에 있는 SKU: ${shopifySkus.size}개`);
    log(`   - NocoDB에 있는 SKU: ${nocodbSkus.size}개`);
    log(`   - 총 제외할 SKU: ${allExistingSkus.size}개\n`);
    
    const collectedProducts = [];  // {url, sku} 형태
    let currentPage = 1;
    let hasMorePages = true;
    let savedCount = 0;
    let skippedCount = 0;
    let skippedShopifyCount = 0;  // ✅ Shopify 중복으로 스킵된 개수
    let skippedNocodbCount = 0;   // ✅ NocoDB 중복으로 스킵된 개수
    
    // ✅ v2.2: 연속 빈 페이지 감지용 카운터
    let consecutiveEmptyPages = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;  // 3번 연속 빈 페이지면 종료
    
    // ✅ v2.2: 이전 페이지의 첫 번째 SKU 저장 (페이지 변경 확인용)
    let previousFirstSku = null;
    
    // ✅ v2.3: 403 에러 방지를 위한 강화된 설정
    const crawler = new PlaywrightCrawler({
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
                    '--disable-blink-features=AutomationControlled'
                ]
            }
        },

        // ✅ v2.3: 브라우저 풀 설정 - fingerprint 우회
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['chrome'],
                    devices: ['desktop'],
                    operatingSystems: ['windows'],
                    locales: ['ko-KR']
                }
            }
        },

        maxRequestsPerCrawl: 100,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 120,

        // ✅ v2.3: 403 에러 방지 - 세션 풀 사용
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 100,
            sessionOptions: {
                maxUsageCount: 50
            }
        },

        // ✅ v2.3: 요청 전 헤더 설정
        preNavigationHooks: [
            async ({ page }) => {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'max-age=0'
                });

                // 웹드라이버 감지 우회 (Playwright용 addInitScript)
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
                    window.chrome = { runtime: {} };
                });
            }
        ],
        
        requestHandler: async ({ page, request }) => {
            const pageNum = request.userData?.pageNum || 1;
            
            log(`\n📄 카테고리 페이지 ${pageNum}${UNLIMITED_PAGES ? '' : '/' + MAX_PAGES} 로딩 중...`);
            log(`   URL: ${request.url.substring(0, 80)}...`);
            
            try {
                await page.waitForLoadState('load', { timeout: 30000 });
            } catch (e) {
                log('⚠️  load 타임아웃, domcontentloaded로 재시도...');
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
            }
            
            // ✅ v2.2: 페이지 로드 후 더 긴 대기
            await page.waitForTimeout(4000);
            
            try {
                await page.waitForSelector('a[href*="goodsNo="]', { timeout: 10000 });
                log('✅ 제품 목록 로딩 완료');
            } catch (e) {
                log('⚠️  제품 목록 선택자 대기 타임아웃');
            }
            
            log('📜 페이지 스크롤 중...');
            
            // ✅ v2.2: 더 많은 스크롤 수행
            for (let i = 0; i < 8; i++) {
                await page.evaluate(() => window.scrollBy(0, 800));
                await page.waitForTimeout(400);
                
                const currentCount = await page.evaluate(() => {
                    return document.querySelectorAll('a[href*="getGoodsDetail.do"]').length;
                });
                
                if (collectedProducts.length + currentCount >= MAX_PRODUCTS) {
                    break;
                }
            }
            
            // 페이지 맨 위로 돌아가서 모든 이미지 로드 확인
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(1000);
            
            // 제품 URL 및 SKU 추출
            const products = await page.evaluate(() => {
                const links = document.querySelectorAll('a[href*="getGoodsDetail.do"]');
                const items = [];
                const seenSkus = new Set();
                
                links.forEach(link => {
                    let href = link.href;
                    if (href && href.includes('goodsNo=')) {
                        const goodsNoMatch = href.match(/goodsNo=([A-Z0-9]+)/);
                        if (goodsNoMatch && !seenSkus.has(goodsNoMatch[1])) {
                            seenSkus.add(goodsNoMatch[1]);
                            items.push({
                                url: `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${goodsNoMatch[1]}`,
                                sku: goodsNoMatch[1]
                            });
                        }
                    }
                });
                
                return items;
            });
            
            log(`📊 페이지 ${pageNum}에서 ${products.length}개 제품 발견`);
            
            // ✅ v2.2: 페이지 변경 확인
            const currentFirstSku = products.length > 0 ? products[0].sku : null;
            if (previousFirstSku && currentFirstSku === previousFirstSku) {
                log(`⚠️  페이지가 변경되지 않음! (첫 SKU 동일: ${currentFirstSku})`);
                hasMorePages = false;
                return;
            }
            previousFirstSku = currentFirstSku;
            
            // ✅ SKU 기반 중복 체크 (Shopify + NocoDB 통합)
            let pageSkippedShopify = 0;
            let pageSkippedNocodb = 0;
            
            const newProducts = products.filter(p => {
                // 이미 수집한 것
                if (collectedProducts.some(cp => cp.sku === p.sku)) {
                    return false;
                }
                
                // Shopify에 이미 있는 것
                if (shopifySkus.has(p.sku)) {
                    pageSkippedShopify++;
                    return false;
                }
                
                // NocoDB에 이미 있는 것
                if (nocodbSkus.has(p.sku)) {
                    pageSkippedNocodb++;
                    return false;
                }
                
                return true;
            });
            
            skippedShopifyCount += pageSkippedShopify;
            skippedNocodbCount += pageSkippedNocodb;
            
            const totalSkipped = pageSkippedShopify + pageSkippedNocodb;
            log(`🆕 새 제품: ${newProducts.length}개`);
            if (totalSkipped > 0) {
                log(`   ⏭️  스킵: ${totalSkipped}개 (Shopify: ${pageSkippedShopify}, NocoDB: ${pageSkippedNocodb})`);
            }
            
            // ✅ v2.2: 연속 빈 페이지 감지
            if (newProducts.length === 0) {
                consecutiveEmptyPages++;
                log(`⚠️  새 제품 없음 (연속 ${consecutiveEmptyPages}/${MAX_CONSECUTIVE_EMPTY}번)`);
                
                if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
                    log(`🛑 연속 ${MAX_CONSECUTIVE_EMPTY}번 새 제품 없음 - 수집 종료`);
                    hasMorePages = false;
                    return;
                }
            } else {
                // 새 제품이 있으면 카운터 리셋
                consecutiveEmptyPages = 0;
            }
            
            // 최대 개수까지만 추가
            const remainingSlots = MAX_PRODUCTS - collectedProducts.length;
            const productsToAdd = newProducts.slice(0, remainingSlots);
            
            for (const product of productsToAdd) {
                collectedProducts.push(product);
            }
            
            log(`📦 현재까지 수집: ${collectedProducts.length}/${MAX_PRODUCTS}개`);
            
            // 다음 페이지 확인
            if (collectedProducts.length >= MAX_PRODUCTS) {
                log(`✅ 목표 개수(${MAX_PRODUCTS}개) 달성!`);
                hasMorePages = false;
            } else if (products.length === 0) {
                log(`⚠️  제품 없음 - 마지막 페이지로 판단`);
                hasMorePages = false;
            } else if (!UNLIMITED_PAGES && pageNum >= MAX_PAGES) {
                log(`✅ 최대 페이지(${MAX_PAGES}) 도달`);
                hasMorePages = false;
            }
            // ✅ v2.2: newProducts.length === 0인 경우에도 계속 진행 (연속 빈 페이지 체크로 대체)
        },
        
        failedRequestHandler: async ({ request }) => {
            log(`❌ 페이지 로드 실패: ${request.url}`);
            hasMorePages = false;  // ✅ v2.2: 실패 시에도 종료
        }
    });
    
    // 페이지별 URL 수집
    log('📥 카테고리 페이지에서 제품 URL 수집\n');
    log('─'.repeat(70));
    
    while (hasMorePages && collectedProducts.length < MAX_PRODUCTS) {
        const pageUrl = new URL(CATEGORY_URL);
        pageUrl.searchParams.set('pageIdx', currentPage.toString());
        
        await crawler.run([{
            url: pageUrl.toString(),
            userData: { pageNum: currentPage }
        }]);
        
        if (!UNLIMITED_PAGES && currentPage >= MAX_PAGES) {
            log(`\n✅ 최대 페이지 수(${MAX_PAGES}) 도달`);
            break;
        }
        
        // ✅ v2.2: hasMorePages가 false로 설정되었으면 루프 종료
        if (!hasMorePages) {
            break;
        }
        
        currentPage++;
        
        if (hasMorePages && collectedProducts.length < MAX_PRODUCTS) {
            // ✅ v2.2: 더 긴 대기 시간
            log(`⏳ 다음 페이지 로딩 전 3초 대기...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    // 크롤러 정리
    await crawler.teardown();
    
    // 수집된 URL을 NocoDB에 저장
    if (collectedProducts.length > 0) {
        log(`\n${'='.repeat(70)}`);
        log(`📥 ${collectedProducts.length}개 제품 URL NocoDB에 저장 중...\n`);
        
        for (let i = 0; i < collectedProducts.length; i++) {
            const product = collectedProducts[i];
            
            const productData = {
                sku: product.sku,
                product_url: product.url
            };
            
            const saved = await saveProductUrl(productData);
            
            if (saved) {
                savedCount++;
                if (savedCount % 10 === 0 || savedCount === collectedProducts.length) {
                    log(`   💾 저장 진행: ${savedCount}/${collectedProducts.length}`);
                }
            } else {
                skippedCount++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // 최종 결과
    log('\n' + '='.repeat(70));
    log('🎉 Phase 0 완료!');
    log('='.repeat(70));
    log(`📊 결과:`);
    log(`   - 스캔한 페이지: ${currentPage}개`);
    log(`   - 발견된 제품: ${collectedProducts.length}개`);
    log(`   - 저장 성공: ${savedCount}개`);
    log(`   - 건너뜀(저장 중복): ${skippedCount}개`);
    log('');
    log(`📊 중복 체크 결과:`);
    log(`   - Shopify 중복으로 스킵: ${skippedShopifyCount}개 ← 🆕 시간 절약!`);
    log(`   - NocoDB 중복으로 스킵: ${skippedNocodbCount}개`);
    log(`\n📝 로그 파일: ${LOG_PATH}`);
    log(`\n💡 다음 단계: node phase1-main-gallery.js`);
    log(`   (Phase 1에서 제품 정보 + 이미지를 함께 수집합니다)`);
    
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
collectUrls().catch(error => {
    log('❌ 치명적 오류:', error.message);
    logStream.end();
});