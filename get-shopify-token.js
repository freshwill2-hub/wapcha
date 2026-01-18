import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import open from 'open';

// ==================== 설정 ====================
const CLIENT_ID = '54e46d57e3807eb28a0b5919e586db21';
const CLIENT_SECRET = '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';
const SHOP = 'wap-au.myshopify.com';
const REDIRECT_URI = 'http://77.42.67.165:3456/callback';
const SCOPES = 'write_products,read_products';

console.log('🚀 Shopify OAuth Token 생성기');
console.log('='.repeat(70));
console.log('');

// ==================== Express 서버 ====================
const app = express();
const PORT = 3456;

// ==================== Step 1: Authorization URL 생성 ====================
const authUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${REDIRECT_URI}`;

console.log('📋 OAuth 인증 프로세스:');
console.log('');
console.log('1️⃣ 브라우저에서 다음 URL을 열어주세요:');
console.log('');
console.log(authUrl);
console.log('');
console.log('2️⃣ "Install app" 버튼을 클릭하세요');
console.log('3️⃣ 자동으로 토큰이 생성됩니다!');
console.log('');
console.log('='.repeat(70));
console.log('');

// ==================== Step 2: Callback 처리 ====================
app.get('/callback', async (req, res) => {
    const { code, shop } = req.query;
    
    if (!code) {
        res.send('❌ Error: No authorization code received');
        return;
    }
    
    console.log('✅ Authorization code 받음:', code);
    console.log('🔄 Access token 요청 중...');
    console.log('');
    
    try {
        // Step 3: Access Token 교환
        const response = await axios.post(
            `https://${SHOP}/admin/oauth/access_token`,
            {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code: code
            }
        );
        
        const accessToken = response.data.access_token;
        
        console.log('🎉 성공!');
        console.log('='.repeat(70));
        console.log('');
        console.log('📝 .env 파일에 다음을 추가하세요:');
        console.log('');
        console.log(`SHOPIFY_ACCESS_TOKEN=${accessToken}`);
        console.log(`SHOPIFY_STORE_URL=${SHOP}`);
        console.log('');
        console.log('='.repeat(70));
        
        res.send(`
            <html>
                <body style="font-family: Arial; padding: 40px; background: #f0f0f0;">
                    <div style="background: white; padding: 30px; border-radius: 8px; max-width: 600px; margin: 0 auto;">
                        <h1 style="color: #5c6ac4;">✅ 토큰 생성 완료!</h1>
                        <p>다음 정보를 복사해서 <code>.env</code> 파일에 추가하세요:</p>
                        <pre style="background: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">
SHOPIFY_ACCESS_TOKEN=${accessToken}
SHOPIFY_STORE_URL=${SHOP}
                        </pre>
                        <p>이 창을 닫으셔도 됩니다. 터미널에서 Ctrl+C를 눌러 서버를 종료하세요.</p>
                    </div>
                </body>
            </html>
        `);
        
        // 10초 후 서버 자동 종료
        setTimeout(() => {
            console.log('');
            console.log('✅ 서버를 종료합니다...');
            process.exit(0);
        }, 10000);
        
    } catch (error) {
        console.error('❌ Token 교환 실패:', error.response?.data || error.message);
        res.send('❌ Error: ' + (error.response?.data?.error || error.message));
    }
});

// ==================== 서버 시작 ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 서버 실행 중: http://77.42.67.165:${PORT}`);
    console.log('');
    console.log('⏳ 위 URL을 브라우저에서 열어주세요...');
    console.log('');
    
    // 5초 후 자동으로 브라우저 열기 (선택사항)
    setTimeout(() => {
        console.log('🌐 브라우저를 자동으로 열고 있습니다...');
        console.log('   (자동으로 안 열리면 위 URL을 직접 복사하세요)');
        console.log('');
    }, 2000);
});