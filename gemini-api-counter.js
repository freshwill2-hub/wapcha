/**
 * Gemini API 호출 카운터 모듈
 * Phase 3, Phase 4에서 import하여 사용
 * 
 * 사용법:
 * import { trackGeminiCall, geminiCounter } from './gemini-api-counter.js';
 * 
 * // API 호출 후
 * trackGeminiCall('analyzeImage');
 * 
 * // 세션 종료 시
 * geminiCounter.printSummary();
 */

import fs from 'fs';
import path from 'path';

const STATS_FILE = path.join(process.cwd(), 'gemini-api-stats.json');
const DAILY_LIMIT = 1500;

class GeminiApiCounter {
    constructor() {
        this.stats = this.loadStats();
        this.sessionCalls = 0;
        this.sessionByFunction = {};
    }

    loadStats() {
        try {
            if (fs.existsSync(STATS_FILE)) {
                const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
                
                // 날짜가 바뀌었으면 리셋
                const today = new Date().toISOString().split('T')[0];
                if (data.date !== today) {
                    console.log(`📅 새로운 날짜 감지 (${data.date} → ${today}) - 카운터 리셋`);
                    return this.getDefaultStats(today);
                }
                
                return data;
            }
        } catch (error) {
            console.log('⚠️  통계 파일 로드 실패, 새로 생성');
        }
        
        return this.getDefaultStats();
    }

    getDefaultStats(date = null) {
        return {
            date: date || new Date().toISOString().split('T')[0],
            dailyCalls: 0,
            dailyLimit: DAILY_LIMIT,
            remaining: DAILY_LIMIT,
            sessionCalls: 0,
            byFunction: {},
            callHistory: []
        };
    }

    saveStats() {
        try {
            // 세션 데이터 포함하여 저장
            const statsToSave = {
                ...this.stats,
                sessionCalls: this.sessionCalls,
                lastUpdated: new Date().toISOString()
            };
            
            fs.writeFileSync(STATS_FILE, JSON.stringify(statsToSave, null, 2));
        } catch (error) {
            console.error('⚠️  통계 저장 실패:', error.message);
        }
    }

    track(functionName) {
        // 날짜 체크 (자정 넘어가면 리셋)
        const today = new Date().toISOString().split('T')[0];
        if (this.stats.date !== today) {
            console.log(`\n📅 자정 경과 - 카운터 리셋!`);
            this.stats = this.getDefaultStats(today);
            this.sessionCalls = 0;
            this.sessionByFunction = {};
        }

        // 카운트 증가
        this.stats.dailyCalls++;
        this.stats.remaining = DAILY_LIMIT - this.stats.dailyCalls;
        this.sessionCalls++;

        // 함수별 카운트
        this.stats.byFunction[functionName] = (this.stats.byFunction[functionName] || 0) + 1;
        this.sessionByFunction[functionName] = (this.sessionByFunction[functionName] || 0) + 1;

        // 히스토리 기록 (최근 100개만)
        this.stats.callHistory.push({
            function: functionName,
            time: new Date().toISOString(),
            dailyTotal: this.stats.dailyCalls
        });
        
        if (this.stats.callHistory.length > 100) {
            this.stats.callHistory = this.stats.callHistory.slice(-100);
        }

        // 저장
        this.saveStats();

        // 콘솔 출력
        const usagePercent = ((this.stats.dailyCalls / DAILY_LIMIT) * 100).toFixed(1);
        console.log(`      📊 Gemini API: ${this.stats.dailyCalls}/${DAILY_LIMIT} (${usagePercent}%) | 세션: ${this.sessionCalls} | ${functionName}`);

        // ✅ v14: 단계별 경고 강화
        if (this.stats.dailyCalls === 1000) {
            console.log(`\n      ${'⚠️'.repeat(5)}`);
            console.log(`      ⚠️  Gemini API 1000회 사용 (한도 근접)`);
            console.log(`      ${'⚠️'.repeat(5)}\n`);
        }
        if (this.stats.dailyCalls === 1500) {
            console.log(`\n      ${'🔴'.repeat(5)}`);
            console.log(`      🔴 Gemini API 1500회 사용 (무료 한도 초과 - 유료 과금 시작)`);
            console.log(`      ${'🔴'.repeat(5)}\n`);
        }
        if (this.stats.remaining <= 100 && this.stats.remaining > 0) {
            console.log(`      ⚠️  주의: 일일 한도 ${this.stats.remaining}회 남음!`);
        }
        if (this.stats.remaining <= 0) {
            console.log(`      🔴 일일 무료 한도 초과! (유료 과금 중)`);
        }

        return {
            dailyCalls: this.stats.dailyCalls,
            remaining: this.stats.remaining,
            sessionCalls: this.sessionCalls
        };
    }

    getStats() {
        return {
            ...this.stats,
            sessionCalls: this.sessionCalls,
            sessionByFunction: this.sessionByFunction
        };
    }

    printSummary() {
        const stats = this.getStats();
        
        console.log(`\n${'='.repeat(50)}`);
        console.log('📊 Gemini API 사용 통계');
        console.log('='.repeat(50));
        console.log(`📅 날짜: ${stats.date}`);
        console.log(`📈 일일 사용: ${stats.dailyCalls}/${DAILY_LIMIT} (${((stats.dailyCalls/DAILY_LIMIT)*100).toFixed(1)}%)`);
        console.log(`⏳ 남은 횟수: ${stats.remaining}회`);
        console.log(`🔄 이번 세션: ${stats.sessionCalls}회`);
        
        if (Object.keys(stats.sessionByFunction).length > 0) {
            console.log(`\n📋 세션 함수별 호출:`);
            Object.entries(stats.sessionByFunction)
                .sort((a, b) => b[1] - a[1])
                .forEach(([func, count]) => {
                    console.log(`   - ${func}: ${count}회`);
                });
        }
        
        if (Object.keys(stats.byFunction).length > 0) {
            console.log(`\n📋 일일 함수별 호출:`);
            Object.entries(stats.byFunction)
                .sort((a, b) => b[1] - a[1])
                .forEach(([func, count]) => {
                    console.log(`   - ${func}: ${count}회`);
                });
        }
        
        console.log('='.repeat(50) + '\n');
    }

    canProceed() {
        return this.stats.remaining > 0;
    }

    getRemainingCalls() {
        return this.stats.remaining;
    }
}

// 싱글톤 인스턴스
const geminiCounter = new GeminiApiCounter();

// 편의 함수
function trackGeminiCall(functionName) {
    return geminiCounter.track(functionName);
}

export { geminiCounter, trackGeminiCall };
export default geminiCounter;