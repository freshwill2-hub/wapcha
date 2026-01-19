import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';

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

console.log('🚀 Phase 0: 올리브영 URL 수집기 (v2.0 - Shopify 중복 체크 추가)');
console.log('='.repeat(70));
console.log(`📂 카테고리 URL: ${CATEGORY_URL}`);
console.log(`📊 최대 수집 개수: ${MAX_PRODUCTS}`);
console.log(`📄 최대 페이지 수: ${UNLIMITED_PAGES ? '무제한 (마지막까지)' : MAX_PAGES}`);
console.log(`💾 저장 테이블: ${OLIVEYOUNG_TABLE_ID}`);
console.log(`🛒 Shopify 스토어: ${SHOPIFY_STORE_URL}`);
console.log('='.repeat(70));
console.log('');
console.log('✨ v2.0 변경사항:');
console.log('   ✅ Shopify에 이미 업로드된 SKU 체크 추가');
console.log('   ✅ 스크래핑 전에 미리 중복 제외 → 시간 절약!');
console.log('='.repeat(70) + '\n');

// ==================== ✅ NEW: Shopify에서 기존 SKU 가져오기 ====================
async function getShopifyExistingSkus() {
    if (!SHOPIFY_ACCESS_TOKEN) {
        console.log('⚠️  Shopify Access Token 없음 - Shopify 중복 체크 스킵');
        return new Set();
    }
    
    try {
        console.log('🛒 Shopify에서 기존 제품 SKU 가져오는 중...');
        
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
        
        console.log(`✅ Shopify 기존 SKU ${shopifySkus.size}개 확인됨\n`);
        return shopifySkus;
        
    } catch (error) {
        console.error('⚠️  Shopify SKU 조회 실패:', error.message);
        if (error.response?.status === 401) {
            console.error('   → Access Token을 확인해주세요');
        }
        console.log('   → Shopify 중복 체크 없이 계속 진행합니다\n');
        return new Set();
    }
}

// ==================== NocoDB: 기존 SKU 확인 ====================
async function getExistingSkus() {
    try {
        console.log('📥 NocoDB에서 기존 SKU 목록 가져오는 중...');
        
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
        
        console.log(`✅ NocoDB 기존 SKU ${allSkus.size}개 확인됨\n`);
        return allSkus;
        
    } catch (error) {
        console.error('❌ NocoDB SKU 조회 실패:', error.message);
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
        console.error('❌ 저장 실패:', error.message);
        return null;
    }
}

// ==================== 메인: 카테고리 스크래핑 (경량 버전) ====================
async function collectUrls() {
    if (!CATEGORY_URL) {
        console.error('❌ 카테고리 URL이 필요합니다!');
        console.log('\n사용법:');
        console.log('  node phase0-url-collector.js "카테고리URL" [최대개수] [최대페이지수]');
        return;
    }
    
    // ✅ Step 1: Shopify 기존 SKU 확인 (가장 먼저!)
    const shopifySkus = await getShopifyExistingSkus();
    
    // ✅ Step 2: NocoDB 기존 SKU 확인
    const nocodbSkus = await getExistingSkus();
    
    // ✅ Step 3: 모든 기존 SKU 합치기
    const allExistingSkus = new Set([...shopifySkus, ...nocodbSkus]);
    console.log('📊 중복 체크 요약:');
    console.log(`   - Shopify에 있는 SKU: ${shopifySkus.size}개`);
    console.log(`   - NocoDB에 있는 SKU: ${nocodbSkus.size}개`);
    console.log(`   - 총 제외할 SKU: ${allExistingSkus.size}개\n`);
    
    const collectedProducts = [];  // {url, sku} 형태
    let currentPage = 1;
    let hasMorePages = true;
    let savedCount = 0;
    let skippedCount = 0;
    let skippedShopifyCount = 0;  // ✅ Shopify 중복으로 스킵된 개수
    let skippedNocodbCount = 0;   // ✅ NocoDB 중복으로 스킵된 개수
    
    // Playwright 크롤러 설정 (가벼운 설정)
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
                    '--disable-background-networking'
                ]
            }
        },
        
        maxRequestsPerCrawl: 100,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 120,
        
        requestHandler: async ({ page, request }) => {
            const pageNum = request.userData?.pageNum || 1;
            
            console.log(`\n📄 카테고리 페이지 ${pageNum}${UNLIMITED_PAGES ? '' : '/' + MAX_PAGES} 로딩 중...`);
            
            try {
                await page.waitForLoadState('load', { timeout: 30000 });
            } catch (e) {
                console.log('⚠️  load 타임아웃, domcontentloaded로 재시도...');
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
            }
            
            await page.waitForTimeout(3000);
            
            try {
                await page.waitForSelector('a[href*="goodsNo="]', { timeout: 10000 });
                console.log('✅ 제품 목록 로딩 완료');
            } catch (e) {
                console.log('⚠️  제품 목록 선택자 대기 타임아웃');
            }
            
            console.log('📜 페이지 스크롤 중...');
            
            for (let i = 0; i < 5; i++) {
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(500);
                
                const currentCount = await page.evaluate(() => {
                    return document.querySelectorAll('a[href*="getGoodsDetail.do"]').length;
                });
                
                if (collectedProducts.length + currentCount >= MAX_PRODUCTS) {
                    break;
                }
            }
            
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
            
            console.log(`📊 페이지 ${pageNum}에서 ${products.length}개 제품 발견`);
            
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
            console.log(`🆕 새 제품: ${newProducts.length}개`);
            if (totalSkipped > 0) {
                console.log(`   ⏭️  스킵: ${totalSkipped}개 (Shopify: ${pageSkippedShopify}, NocoDB: ${pageSkippedNocodb})`);
            }
            
            // 최대 개수까지만 추가
            const remainingSlots = MAX_PRODUCTS - collectedProducts.length;
            const productsToAdd = newProducts.slice(0, remainingSlots);
            
            for (const product of productsToAdd) {
                collectedProducts.push(product);
            }
            
            console.log(`📦 현재까지 수집: ${collectedProducts.length}/${MAX_PRODUCTS}개`);
            
            // 다음 페이지 확인
            if (collectedProducts.length >= MAX_PRODUCTS) {
                hasMorePages = false;
            } else if (newProducts.length === 0 && products.length > 0) {
                console.log(`⚠️  새 제품 없음 - 다음 페이지 확인...`);
            } else if (products.length === 0) {
                console.log(`⚠️  제품 없음 - 마지막 페이지로 판단`);
                hasMorePages = false;
            } else if (!UNLIMITED_PAGES && pageNum >= MAX_PAGES) {
                hasMorePages = false;
            }
        },
        
        failedRequestHandler: async ({ request }) => {
            console.error(`❌ 페이지 로드 실패: ${request.url}`);
        }
    });
    
    // 페이지별 URL 수집
    console.log('📥 카테고리 페이지에서 제품 URL 수집\n');
    console.log('─'.repeat(70));
    
    while (hasMorePages && collectedProducts.length < MAX_PRODUCTS) {
        const pageUrl = new URL(CATEGORY_URL);
        pageUrl.searchParams.set('pageIdx', currentPage.toString());
        
        await crawler.run([{
            url: pageUrl.toString(),
            userData: { pageNum: currentPage }
        }]);
        
        if (!UNLIMITED_PAGES && currentPage >= MAX_PAGES) {
            console.log(`\n✅ 최대 페이지 수(${MAX_PAGES}) 도달`);
            break;
        }
        
        currentPage++;
        
        if (hasMorePages && collectedProducts.length < MAX_PRODUCTS) {
            console.log(`⏳ 다음 페이지 로딩 전 2초 대기...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    // 크롤러 정리
    await crawler.teardown();
    
    // 수집된 URL을 NocoDB에 저장
    if (collectedProducts.length > 0) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📥 ${collectedProducts.length}개 제품 URL NocoDB에 저장 중...\n`);
        
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
                    console.log(`   💾 저장 진행: ${savedCount}/${collectedProducts.length}`);
                }
            } else {
                skippedCount++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // 최종 결과
    console.log('\n' + '='.repeat(70));
    console.log('🎉 Phase 0 완료!');
    console.log('='.repeat(70));
    console.log(`📊 결과:`);
    console.log(`   - 스캔한 페이지: ${currentPage}개`);
    console.log(`   - 발견된 제품: ${collectedProducts.length}개`);
    console.log(`   - 저장 성공: ${savedCount}개`);
    console.log(`   - 건너뜀(저장 중복): ${skippedCount}개`);
    console.log('');
    console.log(`📊 중복 체크 결과:`);
    console.log(`   - Shopify 중복으로 스킵: ${skippedShopifyCount}개 ← 🆕 시간 절약!`);
    console.log(`   - NocoDB 중복으로 스킵: ${skippedNocodbCount}개`);
    console.log(`\n💡 다음 단계: node phase1-main-gallery.js`);
    console.log(`   (Phase 1에서 제품 정보 + 이미지를 함께 수집합니다)`);
}

// 실행
collectUrls().catch(console.error);