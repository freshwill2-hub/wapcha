import 'dotenv/config';
import axios from 'axios';
import { PlaywrightCrawler } from 'crawlee';
import FormData from 'form-data';

// ==================== 설정 ====================
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID || 'mufuxqsjgqcvh80';

console.log('🔧 설정 확인:');
console.log(`- NocoDB URL: ${NOCODB_API_URL}`);
console.log(`- Table ID: ${OLIVEYOUNG_TABLE_ID}\n`);

// ==================== 전역 변수 ====================
let processedCount = 0;
let successCount = 0;
let failedCount = 0;
const productResults = new Map(); // URL -> 추출된 이미지 매핑

// ==================== NocoDB: 제품 가져오기 ====================
async function getOliveyoungProducts(limit = 100, offset = 0) {
    try {
        console.log(`📥 NocoDB에서 제품 가져오는 중 (offset: ${offset}, limit: ${limit})...`);
        
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

        console.log(`✅ ${response.data.list.length}개 제품 가져옴\n`);
        return response.data.list;

    } catch (error) {
        console.error('❌ 제품 가져오기 실패:', error.response?.data || error.message);
        return [];
    }
}

// ==================== 이미지 다운로드 ====================
async function downloadImage(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.oliveyoung.co.kr/'
            }
        });
        
        const buffer = Buffer.from(response.data);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        console.log(`   📥 다운로드 완료 (${sizeMB} MB)`);
        
        return buffer;

    } catch (error) {
        console.error(`   ❌ 다운로드 실패: ${error.message}`);
        return null;
    }
}

// ==================== NocoDB: 파일 업로드 ====================
async function uploadToNocoDB(fileBuffer, filename) {
    try {
        console.log(`   📤 NocoDB 업로드: ${filename}`);
        
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

        console.log(`   ✅ 업로드 성공`);
        
        const uploadData = Array.isArray(response.data) ? response.data[0] : response.data;
        return uploadData;

    } catch (error) {
        console.error(`   ❌ 업로드 실패:`, error.response?.data || error.message);
        return null;
    }
}

// ==================== NocoDB: 제품 업데이트 (✅ 수정됨) ====================
async function updateProductImages(recordId, uploadedFiles) {
    try {
        console.log(`\n📝 제품 레코드 업데이트 중 (ID: ${recordId})...`);
        console.log(`📋 업로드된 파일 ${uploadedFiles.length}개`);
        
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
        
        console.log(`\n📋 첫 번째 attachment 예시:`);
        console.log(JSON.stringify(attachments[0], null, 2));
        
        const scrapedAt = new Date().toISOString();
        
        // ✅ 1단계: 기존 데이터 삭제
        console.log(`🗑️  기존 product_images 삭제 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ 
                Id: recordId, 
                product_images: null
            }],
            { 
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        // ✅ 2단계: 새 데이터 저장
        console.log(`💾 새 product_images 저장 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            [{ 
                Id: recordId, 
                product_images: attachments,
                scraped_at: scrapedAt
            }],
            { 
                headers: { 
                    'xc-token': NOCODB_TOKEN,
                    'Content-Type': 'application/json'
                } 
            }
        );
        
        console.log(`✅ 제품 레코드 업데이트 완료! (시간: ${scrapedAt})\n`);
        return true;

    } catch (error) {
        console.error('❌ 업데이트 실패:', error.response?.data || error.message);
        return false;
    }
}

// ==================== 단일 제품 처리 (이미지 다운로드 & 업로드) ====================
async function processProductImages(product, galleryImages) {
    try {
        if (galleryImages.length === 0) {
            console.log('❌ 메인 갤러리 이미지를 찾을 수 없습니다.\n');
            return false;
        }
        
        console.log(`📊 추출된 이미지: ${galleryImages.length}개`);
        galleryImages.forEach((img, i) => {
            console.log(`   ${i + 1}. ${img.src.substring(0, 70)}... (${img.width}×${img.height})`);
        });
        
        const maxImages = Math.min(galleryImages.length, 7);
        console.log(`\n📥 ${maxImages}개 이미지 다운로드 & 업로드 중...\n`);
        
        const uploadedFiles = [];
        
        for (let i = 0; i < maxImages; i++) {
            const img = galleryImages[i];
            console.log(`\n${i + 1}/${maxImages}: ${img.src.substring(0, 60)}...`);
            
            const buffer = await downloadImage(img.src);
            if (!buffer) continue;
            
            const filename = `gallery-${product.Id}-${i + 1}-${Date.now()}.jpg`;
            const uploadResult = await uploadToNocoDB(buffer, filename);
            
            if (uploadResult) {
                uploadedFiles.push(uploadResult);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (uploadedFiles.length > 0) {
            const updateSuccess = await updateProductImages(product.Id, uploadedFiles);
            
            if (updateSuccess) {
                console.log(`✅ 총 ${uploadedFiles.length}개 이미지 저장 완료\n`);
                return true;
            } else {
                console.log(`❌ NocoDB 업데이트 실패\n`);
                return false;
            }
        } else {
            console.log(`❌ 업로드된 이미지가 없습니다.\n`);
            return false;
        }
        
    } catch (error) {
        console.error(`\n❌ 처리 중 오류:`, error.message);
        return false;
    }
}

// ==================== 메인 ====================
async function main() {
    console.log('🚀 Phase 1: 메인 갤러리 이미지 추출\n');
    console.log('=' .repeat(70) + '\n');
    
    try {
        // 1. NocoDB에서 제품 가져오기
        const products = await getOliveyoungProducts(3, 0);
        
        if (products.length === 0) {
            console.log('⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        const totalProducts = products.length;
        
        // 2. Crawlee 설정 (✅ 1번만 생성!)
        const crawler = new PlaywrightCrawler({
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--single-process'
                    ]
                }
            },
            
            // ✅ 핵심: 각 URL 처리 시 실행되는 함수
            requestHandler: async ({ page, request }) => {
                const product = request.userData.product;
                const index = request.userData.index;
                
                console.log(`\n${'='.repeat(70)}`);
                console.log(`📦 [${index + 1}/${totalProducts}] 제품: ${product.title_kr}`);
                console.log(`🔗 URL: ${request.url.substring(0, 100)}...`);
                console.log('='.repeat(70) + '\n');
                console.log(`📄 페이지 로딩 중...\n`);
                
                try {
                    await page.waitForLoadState('networkidle', { timeout: 30000 });
                    await page.waitForTimeout(3000);
                    
                    // 이미지 추출
                    const images = await page.evaluate(() => {
                        const results = [];
                        
                        const gallerySelectors = [
                            '.prd-detail-img img',
                            '.goods-img img',
                            '.detail-img img',
                            '.prd-img img',
                            '.swiper-slide img',
                            '.slider img',
                            '.gallery img',
                            '[class*="prdImg"] img',
                            '[class*="goodsImg"] img',
                            '[class*="detailImg"] img'
                        ];
                        
                        for (const selector of gallerySelectors) {
                            const imgs = Array.from(document.querySelectorAll(selector));
                            if (imgs.length > 0) {
                                const filteredImages = imgs
                                    .map(img => ({
                                        src: img.src,
                                        width: img.naturalWidth || img.width,
                                        height: img.naturalHeight || img.height,
                                        alt: img.alt
                                    }))
                                    .filter(img => {
                                        if (img.width < 500 || img.height < 500) return false;
                                        const aspectRatio = img.width / img.height;
                                        if (aspectRatio > 2 || aspectRatio < 0.5) return false;
                                        if (img.src.includes('/display/')) return false;
                                        return true;
                                    });
                                
                                results.push({
                                    method: `CSS: ${selector}`,
                                    images: filteredImages
                                });
                                break;
                            }
                        }
                        
                        if (results.length === 0) {
                            const allImages = Array.from(document.querySelectorAll('img'));
                            const largeImages = allImages.filter(img => {
                                const width = img.naturalWidth || img.width;
                                const height = img.naturalHeight || img.height;
                                const rect = img.getBoundingClientRect();
                                return width >= 500 && height >= 500 && rect.top < 1000;
                            });
                            
                            if (largeImages.length > 0) {
                                results.push({
                                    method: 'Large images (top area)',
                                    images: largeImages.map(img => ({
                                        src: img.src,
                                        width: img.naturalWidth || img.width,
                                        height: img.naturalHeight || img.height,
                                        alt: img.alt
                                    }))
                                });
                            }
                        }
                        
                        if (results.length === 0) {
                            const counterElements = Array.from(document.querySelectorAll('*')).filter(el => {
                                const text = el.textContent?.trim();
                                return text && /^\d+\s*\/\s*\d+$/.test(text);
                            });
                            
                            if (counterElements.length > 0) {
                                const counter = counterElements[0];
                                const container = counter.closest('div');
                                const imgs = container?.querySelectorAll('img') || [];
                                
                                if (imgs.length > 0) {
                                    results.push({
                                        method: 'Near page counter',
                                        images: Array.from(imgs).map(img => ({
                                            src: img.src,
                                            width: img.naturalWidth || img.width,
                                            height: img.naturalHeight || img.height,
                                            alt: img.alt
                                        }))
                                    });
                                }
                            }
                        }
                        
                        return results;
                    });
                    
                    let galleryImages = [];
                    
                    if (images.length > 0) {
                        const result = images[0];
                        console.log(`✅ 메인 갤러리 추출 성공: ${result.method}`);
                        console.log(`📸 ${result.images.length}개 이미지 발견\n`);
                        
                        galleryImages = result.images.filter(img => 
                            img.src.includes('oliveyoung.co.kr') ||
                            img.src.includes('image.oliveyoung')
                        );
                        
                        console.log(`✅ 올리브영 이미지만 필터링: ${galleryImages.length}개\n`);
                    } else {
                        console.log('⚠️  메인 갤러리를 찾을 수 없습니다.\n');
                    }
                    
                    // ✅ 이미지 다운로드 & 업로드
                    const success = await processProductImages(product, galleryImages);
                    
                    if (success) {
                        successCount++;
                    } else {
                        failedCount++;
                    }
                    
                    processedCount++;
                    
                } catch (pageError) {
                    console.error('⚠️  페이지 처리 오류:', pageError.message);
                    failedCount++;
                    processedCount++;
                }
            },
            
            // ✅ 설정
            maxRequestsPerCrawl: 1000,  // 충분히 큰 값
            maxConcurrency: 1,  // 한 번에 1개씩 처리
            requestHandlerTimeoutSecs: 180  // 3분 타임아웃
        });
        
        // 3. ✅ 모든 URL을 한 번에 전달!
        const requests = products.map((product, index) => ({
            url: product.product_url,
            userData: {  // ✅ 제품 정보를 userData로 전달!
                product: product,
                index: index
            }
        }));
        
        console.log(`🌐 Crawler 시작 - ${products.length}개 제품 처리\n`);
        
        await crawler.run(requests);
        
        // ✅ Playwright 완전 종료
        await crawler.teardown();

        // 4. 최종 결과
        console.log('\n' + '='.repeat(70));
        console.log('🎉 Phase 1 완료!');
        console.log('='.repeat(70));
        console.log(`✅ 성공: ${successCount}/${totalProducts}개 제품`);
        console.log(`❌ 실패: ${failedCount}/${totalProducts}개 제품`);
        console.log(`\n💡 다음 단계: Phase 2 실행`);
        console.log(`   node phase2-ai-generate.js`);
        
    } catch (error) {
        console.error('\n❌ 치명적 오류:', error.message);
        console.error(error.stack);
    }
}

main();