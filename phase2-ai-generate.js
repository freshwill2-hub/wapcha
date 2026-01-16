import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const execAsync = promisify(exec);

// 환경 변수
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;

// rembg 경로 (가상환경 내부)
const REMBG_PATH = '/root/copychu-scraper/rembg-env/bin/rembg';
const PYTHON_PATH = '/root/copychu-scraper/rembg-env/bin/python';

console.log('🔧 설정 확인:');
console.log(`- NocoDB URL: ${NOCODB_API_URL}`);
console.log(`- Oliveyoung Table: ${OLIVEYOUNG_TABLE_ID}`);
console.log(`- Shopify Table: ${SHOPIFY_TABLE_ID}`);
console.log(`- rembg 경로: ${REMBG_PATH}`);

console.log('\n🚀 Phase 2: 배경 제거 + 흰색 배경 (rembg - 오픈소스)');
console.log('='.repeat(70));

// ==================== 가격 변환 함수 (KRW → AUD) ====================
function convertKRWtoAUD(priceOriginal) {
    if (!priceOriginal || priceOriginal === 0) {
        console.log(`   ⚠️  가격 정보 없음 → 최저가 $39 적용`);
        return 39; // 최저가
    }
    
    console.log(`   💰 가격 변환 시작: ₩${priceOriginal.toLocaleString()}`);
    
    // 1단계: 백원 단위 반올림
    // 백원 자리가 1~9이면 천원 올림, 0이면 그대로
    const hundreds = Math.floor((priceOriginal % 1000) / 100);
    const roundedPrice = Math.floor(priceOriginal / 1000) * 1000 + (hundreds > 0 ? 1000 : 0);
    console.log(`      1단계 (백원 반올림): ₩${priceOriginal.toLocaleString()} → ₩${roundedPrice.toLocaleString()} (백원자리: ${hundreds})`);
    
    // 2단계: 1000으로 나누기
    const step1 = roundedPrice / 1000;
    console.log(`      2단계 (÷1000): ${step1}`);
    
    // 3단계: 2 곱하기
    const step2 = step1 * 2;
    console.log(`      3단계 (×2): ${step2}`);
    
    // 4단계: 10 더하기
    let beforeAdjust = Math.round(step2 + 10);
    console.log(`      4단계 (+10): ${beforeAdjust}`);
    
    // 5단계: 마지막 자리를 9로 만들기
    const lastDigit = beforeAdjust % 10;
    let finalPrice;
    
    if (lastDigit === 0) {
        // 0으로 끝나면 -1
        // 80 → 79, 90 → 89, 110 → 109
        finalPrice = beforeAdjust - 1;
        console.log(`      5단계 (0으로 끝남 → -1): ${beforeAdjust} → ${finalPrice}`);
    } else {
        // 그 외 숫자로 끝나면 마지막 자리를 9로 변경
        // 81 → 89, 91 → 99, 111 → 119, 121 → 129
        finalPrice = Math.floor(beforeAdjust / 10) * 10 + 9;
        console.log(`      5단계 (마지막 자리 → 9): ${beforeAdjust} → ${finalPrice}`);
    }
    
    // 6단계: 최저가 체크
    if (finalPrice < 39) {
        console.log(`      6단계 (최저가 체크): ${finalPrice} → 39`);
        finalPrice = 39;
    } else {
        console.log(`      6단계 (최저가 체크): ${finalPrice} ✓`);
    }
    
    console.log(`   ✅ 최종 가격: $${finalPrice}`);
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
    console.log(`\n📥 tb_oliveyoung_products에서 제품 가져오는 중 (limit: ${limit})...`);
    
    const response = await axios.get(
        `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
        {
            headers: { 'xc-token': NOCODB_API_TOKEN },
            params: {
                limit: limit
            }
        }
    );
    
    // 이미지가 있는 제품만 필터링
    const productsWithImages = response.data.list.filter(p => 
        p.product_images && p.product_images.length > 0
    );
    
    console.log(`✅ ${productsWithImages.length}개 제품 가져옴 (이미지 있음)`);
    return productsWithImages;
}

// ==================== NocoDB에서 Shopify 제품 확인/생성 (개선!) ====================
async function getOrCreateShopifyProduct(oliveyoungProduct) {
    const productId = oliveyoungProduct.Id;
    
    console.log(`\n🔍 tb_shopify_products에서 제품 확인 중 (ID: ${productId})...`);
    
    try {
        const response = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN },
                params: {
                    where: `(Id,eq,${productId})`
                }
            }
        );
        
        if (response.data.list.length > 0) {
            console.log('✅ 기존 Shopify 제품 발견 - 필드 업데이트 중...');
            
            // ✅ 기존 제품이 있어도 필드 업데이트
            const updateData = {
                Id: productId,
                oliveyoung_product_id: oliveyoungProduct.sku || null,
                title_kr: oliveyoungProduct.title_kr || null,
                title_en: oliveyoungProduct.title_en || null,
                description_en: oliveyoungProduct.description_en || null,
                price_aud: convertKRWtoAUD(oliveyoungProduct.price_original)
            };
            
            console.log(`📋 업데이트할 데이터:`);
            console.log(`   - oliveyoung_product_id: ${updateData.oliveyoung_product_id}`);
            console.log(`   - title_kr: ${updateData.title_kr?.substring(0, 30)}...`);
            console.log(`   - title_en: ${updateData.title_en?.substring(0, 30)}...`);
            console.log(`   - description_en: ${updateData.description_en ? '✓ (있음)' : '✗ (없음)'}`);
            console.log(`   - price_aud: $${updateData.price_aud}`);
            
            await axios.patch(
                `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
                updateData,
                {
                    headers: { 'xc-token': NOCODB_API_TOKEN }
                }
            );
            
            console.log('✅ Shopify 제품 업데이트 완료');
            return response.data.list[0];
        }
        
        // ✅ 새 제품 생성 (모든 필드 포함)
        console.log('📝 새 Shopify 제품 생성 중...');
        
        const priceAUD = convertKRWtoAUD(oliveyoungProduct.price_original);
        
        const newProductData = {
            Id: productId,
            oliveyoung_product_id: oliveyoungProduct.sku || null,
            title_kr: oliveyoungProduct.title_kr || null,
            title_en: oliveyoungProduct.title_en || null,
            description_en: oliveyoungProduct.description_en || null,
            price_aud: priceAUD
        };
        
        console.log(`📋 생성할 데이터:`);
        console.log(`   - Id: ${newProductData.Id}`);
        console.log(`   - oliveyoung_product_id: ${newProductData.oliveyoung_product_id}`);
        console.log(`   - title_kr: ${newProductData.title_kr?.substring(0, 30)}...`);
        console.log(`   - title_en: ${newProductData.title_en?.substring(0, 30)}...`);
        console.log(`   - description_en: ${newProductData.description_en ? '✓ (있음)' : '✗ (없음)'}`);
        console.log(`   - price_aud: $${newProductData.price_aud}`);
        
        const createResponse = await axios.post(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            newProductData,
            {
                headers: { 'xc-token': NOCODB_API_TOKEN }
            }
        );
        
        console.log('✅ Shopify 제품 생성 완료');
        return createResponse.data;
        
    } catch (error) {
        console.error('❌ Shopify 제품 확인/생성 실패:', error.message);
        if (error.response) {
            console.error('   응답 데이터:', error.response.data);
        }
        throw error;
    }
}

// 이미지 다운로드
async function downloadImage(imageUrl, outputPath) {
    console.log(`📥 이미지 다운로드 중...`);
    console.log(`   URL: ${imageUrl.substring(0, 80)}...`);
    
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer'
    });
    
    fs.writeFileSync(outputPath, response.data);
    const sizeKB = (response.data.length / 1024).toFixed(1);
    console.log(`   ✅ 다운로드 완료 (${sizeKB}KB)`);
}

// rembg로 배경 제거 + 흰색 배경 추가
async function removeBackgroundWithWhite(inputPath, outputPath) {
    console.log(`\n🎨 배경 제거 중 (rembg)...`);
    console.log(`   입력: ${inputPath}`);
    
    try {
        const startTime = Date.now();
        const tempTransparent = outputPath.replace('.png', '_temp.png');
        
        // 1단계: 배경 제거 (투명)
        await execAsync(
            `${REMBG_PATH} i "${inputPath}" "${tempTransparent}"`
        );
        
        // 2단계: Python 스크립트 파일 생성
        const pythonScriptPath = `/tmp/add_white_bg_${Date.now()}.py`;
        const pythonScript = `from PIL import Image

# 투명 PNG 열기
img = Image.open('${tempTransparent}').convert('RGBA')

# 흰색 배경 생성
white_bg = Image.new('RGBA', img.size, (255, 255, 255, 255))

# 합성
white_bg.paste(img, (0, 0), img)

# RGB로 변환하여 저장
white_bg.convert('RGB').save('${outputPath}', 'PNG')
print('✅ 흰색 배경 추가 완료')
`;
        
        fs.writeFileSync(pythonScriptPath, pythonScript);
        
        // Python 스크립트 실행
        await execAsync(`${PYTHON_PATH} "${pythonScriptPath}"`);
        
        // 임시 파일 삭제
        cleanupFiles(tempTransparent, pythonScriptPath);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (fs.existsSync(outputPath)) {
            const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
            console.log(`   ✅ 배경 제거 + 흰색 배경 완료 (${sizeKB}KB, ${duration}초 소요)`);
            return true;
        } else {
            console.error('   ❌ 출력 파일 생성 실패');
            return false;
        }
        
    } catch (error) {
        console.error('   ❌ 배경 제거 실패:', error.message);
        if (error.stderr) console.error('   stderr:', error.stderr);
        return false;
    }
}

// NocoDB에 이미지 업로드
async function uploadToNocoDB(filePath, fileName) {
    console.log(`\n📤 NocoDB 업로드: ${fileName}`);
    
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
        
        console.log('   ✅ 업로드 성공');
        return response.data;
        
    } catch (error) {
        console.error('   ❌ 업로드 실패:', error.message);
        throw error;
    }
}

// Shopify 테이블에 AI 이미지 저장 (✅ 수정됨)
async function saveAIImages(shopifyProductId, imageDataArray) {
    console.log(`\n📝 tb_shopify_products에 AI 이미지 저장 중 (ID: ${shopifyProductId})...`);
    
    try {
        // ✅ 1단계: 기존 데이터 삭제
        console.log(`🗑️  기존 ai_product_images 삭제 중...`);
        await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                Id: shopifyProductId,
                ai_product_images: null
            },
            {
                headers: { 'xc-token': NOCODB_API_TOKEN }
            }
        );
        
        // ✅ 2단계: 새 데이터 저장
        console.log(`💾 새 ai_product_images 저장 중...`);
        const response = await axios.patch(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                Id: shopifyProductId,
                ai_product_images: imageDataArray
            },
            {
                headers: { 'xc-token': NOCODB_API_TOKEN }
            }
        );
        
        console.log(`✅ AI 이미지 저장 완료! (필드: ai_product_images)`);
        return response.data;
        
    } catch (error) {
        console.error('❌ AI 이미지 저장 실패:', error.message);
        throw error;
    }
}

// 메인 함수
async function main() {
    const limit = 3; // ✅ 3개 제품 처리
    
    try {
        // 1. 올리브영 제품 가져오기
        const products = await getProducts(limit);
        
        if (products.length === 0) {
            console.log('\n⚠️  처리할 제품이 없습니다.');
            return;
        }
        
        for (const product of products) {
            console.log(`\n📦 제품: ${product.title_kr}`);
            console.log('='.repeat(70));
            
            // 2. ✅ Shopify 제품 확인/생성 (개선된 버전!)
            const shopifyProduct = await getOrCreateShopifyProduct(product);
            
            // 3. 원본 이미지 확인
            if (!product.product_images || product.product_images.length === 0) {
                console.log('⚠️  원본 이미지가 없습니다. 건너뜁니다.');
                continue;
            }
            
            console.log(`\n🖼️  원본 이미지: ${product.product_images.length}개`);
            
            // 4. 각 이미지에 대해 배경 제거
            const processedImages = [];
            
            for (let i = 0; i < product.product_images.length; i++) {
                const img = product.product_images[i];
                console.log(`\n[${i + 1}/${product.product_images.length}] 이미지 처리 중...`);
                
                // 이미지 URL 구성
                let imageUrl = img.url;
                if (!imageUrl && img.path) {
                    imageUrl = `${NOCODB_API_URL}/${img.path}`;
                }
                
                if (!imageUrl) {
                    console.log('⚠️  이미지 URL을 찾을 수 없습니다. 건너뜁니다.');
                    continue;
                }
                
                // 임시 파일 경로
                const timestamp = Date.now();
                const inputPath = `/tmp/input-${timestamp}-${i}.jpg`;
                const outputPath = `/tmp/output-${timestamp}-${i}.png`;
                
                try {
                    // 이미지 다운로드
                    await downloadImage(imageUrl, inputPath);
                    
                    // 배경 제거 + 흰색 배경
                    const success = await removeBackgroundWithWhite(inputPath, outputPath);
                    
                    if (success) {
                        // NocoDB에 업로드
                        const fileName = `white-bg-${product.Id}-${i + 1}-${timestamp}.png`;
                        const uploadedData = await uploadToNocoDB(outputPath, fileName);
                        
                        processedImages.push(uploadedData[0]);
                        console.log(`   ✅ 이미지 ${i + 1} 처리 완료`);
                    }
                    
                } catch (error) {
                    console.error(`   ❌ 이미지 ${i + 1} 처리 실패:`, error.message);
                } finally {
                    // 임시 파일 정리
                    cleanupFiles(inputPath, outputPath);
                }
                
                // Rate limiting (1초 대기)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // 5. Shopify 테이블에 저장
            if (processedImages.length > 0) {
                await saveAIImages(shopifyProduct.Id, processedImages);
                
                console.log('\n' + '='.repeat(70));
                console.log('🎉 완료!');
                console.log('='.repeat(70));
                console.log(`📦 제품: ${product.title_kr}`);
                console.log(`🖼️  원본 이미지: ${product.product_images.length}개`);
                console.log(`✨ 흰색 배경 이미지: ${processedImages.length}개`);
                console.log(`💰 가격: $${shopifyProduct.price_aud || 'N/A'}`);
                console.log(`💰 비용: $0 (오픈소스)`);
                console.log(`✅ 저장 위치: tb_shopify_products (ID: ${shopifyProduct.Id})`);
                console.log(`   → oliveyoung_product_id: ${shopifyProduct.oliveyoung_product_id || product.sku}`);
                console.log(`   → title_en: ${shopifyProduct.title_en ? '✓' : '✗'}`);
                console.log(`   → description_en: ${shopifyProduct.description_en ? '✓' : '✗'}`);
                console.log(`   → ai_product_images: ${processedImages.length}개`);
            } else {
                console.log('\n⚠️  처리된 이미지가 없습니다.');
            }
        }
        
    } catch (error) {
        console.error('\n❌ 오류 발생:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

// 실행
main();