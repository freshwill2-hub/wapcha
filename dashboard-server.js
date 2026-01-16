import express from 'express';
import { spawn, execSync } from 'child_process';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 설정 ====================
const PORT = process.env.DASHBOARD_PORT || 3000;
const NOCODB_API_URL = process.env.NOCODB_API_URL || 'http://77.42.67.165:8080';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const OLIVEYOUNG_TABLE_ID = process.env.OLIVEYOUNG_TABLE_ID;
const SHOPIFY_TABLE_ID = process.env.SHOPIFY_TABLE_ID;

// Phase 파일 경로
const PHASE_FILES = {
    phase1: './phase1-main-gallery.js',
    phase2: './phase2-ai-generate.js',
    phase3: './phase3-multi-3products.js',
    phase4: './phase4-final-data.js'
};

// ==================== Express 앱 ====================
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static('public'));

// 현재 실행 중인 프로세스
let currentProcess = null;
let currentPhase = null;

// WebSocket 클라이언트들
const clients = new Set();

// ==================== WebSocket 연결 ====================
wss.on('connection', (ws) => {
    console.log('✅ 클라이언트 연결됨');
    clients.add(ws);
    
    // 환영 메시지
    ws.send(JSON.stringify({
        type: 'system',
        message: '대시보드에 연결되었습니다.',
        timestamp: new Date().toISOString()
    }));
    
    ws.on('close', () => {
        console.log('❌ 클라이언트 연결 해제됨');
        clients.delete(ws);
    });
});

// 모든 클라이언트에게 메시지 브로드캐스트
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(message);
        }
    });
}

// ==================== NocoDB 통계 조회 ====================
async function getNocoDBStats() {
    try {
        // Oliveyoung 제품 통계
        const oliveyoungRes = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: { limit: 1 }
            }
        );
        
        // Shopify 제품 통계
        const shopifyRes = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: { limit: 1 }
            }
        );
        
        // 이미지가 있는 제품 수 (대략적)
        const oliveyoungWithImages = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${OLIVEYOUNG_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    where: '(product_images,notnull)',
                    limit: 1
                }
            }
        );
        
        const shopifyWithAI = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    where: '(ai_product_images,notnull)',
                    limit: 1
                }
            }
        );
        
        const shopifyWithValidated = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    where: '(validated_images,notnull)',
                    limit: 1
                }
            }
        );
        
        const shopifyWithMain = await axios.get(
            `${NOCODB_API_URL}/api/v2/tables/${SHOPIFY_TABLE_ID}/records`,
            {
                headers: { 'xc-token': NOCODB_TOKEN },
                params: {
                    where: '(main_image,notnull)',
                    limit: 1
                }
            }
        );
        
        return {
            oliveyoung: {
                total: oliveyoungRes.data.pageInfo?.totalRows || 0,
                withImages: oliveyoungWithImages.data.pageInfo?.totalRows || 0
            },
            shopify: {
                total: shopifyRes.data.pageInfo?.totalRows || 0,
                withAI: shopifyWithAI.data.pageInfo?.totalRows || 0,
                withValidated: shopifyWithValidated.data.pageInfo?.totalRows || 0,
                withMain: shopifyWithMain.data.pageInfo?.totalRows || 0
            }
        };
        
    } catch (error) {
        console.error('❌ NocoDB 통계 조회 실패:', error.message);
        return null;
    }
}

// ==================== Phase 실행 함수 ====================
function runPhase(phaseName, onComplete) {
    if (currentProcess) {
        broadcast({
            type: 'error',
            message: '이미 다른 프로세스가 실행 중입니다.',
            timestamp: new Date().toISOString()
        });
        return false;
    }
    
    const phaseFile = PHASE_FILES[phaseName];
    if (!phaseFile) {
        broadcast({
            type: 'error',
            message: `알 수 없는 Phase: ${phaseName}`,
            timestamp: new Date().toISOString()
        });
        return false;
    }
    
    currentPhase = phaseName;
    
    broadcast({
        type: 'start',
        phase: phaseName,
        message: `${phaseName} 실행 시작...`,
        timestamp: new Date().toISOString()
    });
    
    currentProcess = spawn('node', [phaseFile], {
        cwd: process.cwd()
    });
    
    // stdout 로그
    currentProcess.stdout.on('data', (data) => {
        const message = data.toString();
        console.log(message);
        broadcast({
            type: 'log',
            phase: phaseName,
            message: message,
            timestamp: new Date().toISOString()
        });
    });
    
    // stderr 로그
    currentProcess.stderr.on('data', (data) => {
        const message = data.toString();
        console.error(message);
        broadcast({
            type: 'error',
            phase: phaseName,
            message: message,
            timestamp: new Date().toISOString()
        });
    });
    
    // 종료
    currentProcess.on('close', (code) => {
        const success = code === 0;
        
        broadcast({
            type: success ? 'complete' : 'error',
            phase: phaseName,
            message: success 
                ? `${phaseName} 완료! (종료 코드: ${code})`
                : `${phaseName} 실패 (종료 코드: ${code})`,
            timestamp: new Date().toISOString()
        });
        
        currentProcess = null;
        currentPhase = null;
        
        if (onComplete) {
            onComplete(success);
        }
    });
    
    return true;
}

// ==================== 순차 실행 함수 ====================
async function runSequential(phases) {
    for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        
        await new Promise((resolve) => {
            const success = runPhase(phase, (success) => {
                resolve(success);
            });
            
            if (!success) {
                resolve(false);
            }
        });
        
        // 다음 Phase로 이동하기 전 5초 대기
        if (i < phases.length - 1) {
            broadcast({
                type: 'system',
                message: `다음 Phase까지 5초 대기...`,
                timestamp: new Date().toISOString()
            });
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    broadcast({
        type: 'complete',
        message: '모든 Phase 완료!',
        timestamp: new Date().toISOString()
    });
}

// ==================== API 엔드포인트 ====================

// 상태 조회
app.get('/api/status', async (req, res) => {
    const stats = await getNocoDBStats();
    
    res.json({
        running: currentProcess !== null,
        currentPhase: currentPhase,
        stats: stats
    });
});

// Phase 개별 실행
app.post('/api/run/:phase', (req, res) => {
    const phase = req.params.phase;
    const success = runPhase(phase);
    
    res.json({
        success: success,
        message: success 
            ? `${phase} 실행 시작` 
            : '이미 다른 프로세스가 실행 중입니다.'
    });
});

// Phase 순차 실행
app.post('/api/run-sequence', async (req, res) => {
    const { phases } = req.body;
    
    if (!phases || !Array.isArray(phases)) {
        return res.status(400).json({
            success: false,
            message: 'phases 배열이 필요합니다.'
        });
    }
    
    if (currentProcess) {
        return res.json({
            success: false,
            message: '이미 다른 프로세스가 실행 중입니다.'
        });
    }
    
    res.json({
        success: true,
        message: `${phases.length}개 Phase 순차 실행 시작`
    });
    
    // 비동기로 순차 실행
    runSequential(phases);
});

// 실행 중단
app.post('/api/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        currentPhase = null;
        
        broadcast({
            type: 'system',
            message: '프로세스가 중단되었습니다.',
            timestamp: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: '프로세스 중단됨'
        });
    } else {
        res.json({
            success: false,
            message: '실행 중인 프로세스가 없습니다.'
        });
    }
});

// ==================== 🆕 강제 종료 API ====================
app.post('/api/force-kill', async (req, res) => {
    console.log('🛑 강제 종료 요청됨...');
    
    const results = {
        phase: false,
        chromium: false,
        message: []
    };
    
    // 1. 현재 프로세스 종료
    if (currentProcess) {
        try {
            currentProcess.kill('SIGKILL');
            currentProcess = null;
            currentPhase = null;
            results.message.push('✅ 현재 프로세스 종료됨');
        } catch (e) {
            results.message.push('⚠️ 현재 프로세스 종료 실패: ' + e.message);
        }
    }
    
    // 2. Phase 관련 node 프로세스 종료
    try {
        execSync('pkill -f "node phase" 2>/dev/null || true', { timeout: 5000 });
        results.phase = true;
        results.message.push('✅ Phase 프로세스 종료됨');
    } catch (e) {
        results.message.push('⚠️ Phase 프로세스 없거나 종료 실패');
    }
    
    // 3. Chromium/Playwright 종료
    try {
        execSync('pkill -f chromium 2>/dev/null || true', { timeout: 5000 });
        results.chromium = true;
        results.message.push('✅ Chromium 프로세스 종료됨');
    } catch (e) {
        results.message.push('⚠️ Chromium 프로세스 없거나 종료 실패');
    }
    
    // 4. 상태 브로드캐스트
    broadcast({
        type: 'system',
        message: '🛑 강제 종료 완료! 모든 프로세스가 정리되었습니다.',
        timestamp: new Date().toISOString()
    });
    
    console.log('🛑 강제 종료 완료:', results.message.join(', '));
    
    res.json({
        success: true,
        results: results,
        message: results.message.join('\n')
    });
});

// NocoDB 통계 조회
app.get('/api/nocodb/stats', async (req, res) => {
    const stats = await getNocoDBStats();
    res.json(stats);
});

// ==================== 서버 시작 (✅ 수정됨!) ====================
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Copychu Dashboard 실행 중!');
    console.log(`📊 대시보드: http://77.42.67.165:${PORT}`);
    console.log(`🔌 WebSocket: ws://77.42.67.165:${PORT}`);
    console.log('');
    console.log('Phase 파일 확인:');
    Object.entries(PHASE_FILES).forEach(([name, file]) => {
        console.log(`  - ${name}: ${file}`);
    });
});