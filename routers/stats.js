import express from 'express';
import supabase from '../lib/supabaseClient.js';
import verifySupabaseJWT from '../lib/verifyJWT.js';

const router = express.Router();

// 공통: 분→"X시간 Y분" 포맷터
const toHMText = (minutes) => {
  const m = Math.round(Number(minutes) || 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h > 0 && rest > 0) return `${h}시간 ${rest}분`;
  if (h > 0) return `${h}시간`;
  return `${m}분`;
};

// 월별 요약
// GET /stats/my-summary/monthly?year=YYYY
router.get('/my-summary/monthly', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my-summary/monthly');
  try {
    const userId = req.user.sub;
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();

    // 조회 기간 (UTC) — 해당 연도 전체
    const from = new Date(Date.UTC(year, 0, 1)).toISOString();
    const to = new Date(Date.UTC(year + 1, 0, 1)).toISOString();

    const { data: rows, error } = await supabase
      .from('study_record')
      .select('duration, start_time')
      .eq('user_id', userId)
      .gte('start_time', from)
      .lt('start_time', to)
      .setHeader('Authorization', req.headers.authorization);

    if (error) throw error;

    // KST 변환 유틸
    const toKST = (input) => {
      const t = new Date(input);
      return new Date(t.getTime() + 9 * 60 * 60 * 1000);
    };

    // 1~12월 버킷 초기화
    const buckets = {};
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      buckets[key] = { month: key, sessions: 0, total_minutes: 0 };
    }

    // 집계
    (rows || []).forEach((r) => {
      const k = toKST(r.start_time);
      const key = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, '0')}`;
      const minutes = Number(r.duration || 0) / 60;
      if (!buckets[key]) buckets[key] = { month: key, sessions: 0, total_minutes: 0, total_hours: 0 };
      buckets[key].sessions += 1;
      buckets[key].total_minutes += minutes;
    });

    const items = Object.values(buckets).map((b) => {
      const total_minutes = Math.round(b.total_minutes);
      return {
        ...b,
        total_minutes,
        total_time_text: toHMText(total_minutes)
      };
    });

    return res.json({ success: true, year, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '월별 통계 조회 실패' });
  }
});

// 주간 통계
// GET /stats/my-summary/weekly?from=YYYY-MM-DD&to=YYYY-MM-DD
// from/to 미지정 시 최근 12주 범위로 기본 조회
router.get('/my-summary/weekly', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my-summary/weekly');
  try {
    const userId = req.user.sub;

    const now = new Date();
    const defaultTo = now;
    const defaultFrom = new Date(now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000); // 최근 12주

    const from = req.query.from ? new Date(req.query.from) : defaultFrom;
    const to = req.query.to ? new Date(req.query.to) : defaultTo;

    const fromISO = from.toISOString();
    const toISO = to.toISOString();

    const { data: rows, error } = await supabase
      .from('study_record')
      .select('duration, start_time')
      .eq('user_id', userId)
      .gte('start_time', fromISO)
      .lte('start_time', toISO)
      .setHeader('Authorization', req.headers.authorization);

    if (error) throw error;

    const toKST = (input) => {
      const t = new Date(input);
      return new Date(t.getTime() + 9 * 60 * 60 * 1000);
    };

    const weekStartKST = (dateObj) => {
      const k = new Date(dateObj.getTime());
      k.setHours(0, 0, 0, 0);
      const day = (k.getDay() + 6) % 7; // Mon=0, ..., Sun=6
      k.setDate(k.getDate() - day);
      return k;
    };

    // 데이터 집계
    const buckets = new Map(); // key: YYYY-MM-DD (해당 주 월요일)
    (rows || []).forEach((r) => {
      const kst = toKST(r.start_time);
      const ws = weekStartKST(kst);
      const key = ws.toISOString().slice(0, 10);
      const minutes = Number(r.duration || 0) / 60;
      if (!buckets.has(key)) buckets.set(key, { week_start: key, sessions: 0, total_minutes: 0 });
      const b = buckets.get(key);
      b.sessions += 1;
      b.total_minutes += minutes;
    });

    // 범위 내 주차를 빠짐없이 채우기
    const startMonday = weekStartKST(toKST(fromISO));
    const endMonday = weekStartKST(toKST(toISO));

    const items = [];
    for (let d = new Date(startMonday); d <= endMonday; d.setDate(d.getDate() + 7)) {
      const key = d.toISOString().slice(0, 10);
      const b = buckets.get(key) || { week_start: key, sessions: 0, total_minutes: 0 };
      b.total_minutes = Math.round(b.total_minutes);
      b.total_time_text = toHMText(b.total_minutes);
      items.push(b);
    }

    return res.json({ success: true, from: from.toISOString(), to: to.toISOString(), items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '주별 통계 조회 실패' });
  }
});

// 공간별 내 랭킹 조회
router.get("/my/spaces-ranks", verifySupabaseJWT, async (req, res) => {
    console.log('[라우터 호출] GET /stats/my/spaces-ranks')
    try {
        const userId = req.user.sub;

        // 내가 공부한 공간들 조회
        const { data: mySpaces, error: mySpacesError } = await supabase
            .from("study_record")
            .select("space_id")
            .eq("user_id", userId)
            .setHeader('Authorization', req.headers.authorization);;

        if (mySpacesError) throw mySpacesError;


        const mySpaceIds = [ ...new Set(mySpaces.map(s => s.space_id))];

        if (mySpaceIds.length === 0) {
            return res.json({ success: true, items: [] });
        } 

        // 내가 공부한 공간들의 모든 유저 데이터 조회
        const { data: rows, error } = await supabase
            .from("study_record")
            .select("space_id, user_id, duration")
            .in("space_id", mySpaceIds); // 필요한 공간만 조회

        if (error) throw error;

        // 공간별 유저 집계
        const spaceUserStats = new Map();

        for (const record of rows) {
            const spaceId = record.space_id;
            const userId = record.user_id;

            if (!spaceUserStats.has(spaceId)) {
                spaceUserStats.set(spaceId, new Map());
            }

            const userMap = spaceUserStats.get(spaceId);
            if (!userMap.has(userId)) {
                userMap.set(userId, {
                    user_id: userId,
                    study_count: 0,
                    total_minutes: 0
                });
            }

            const userStats = userMap.get(userId);
            userStats.study_count += 1;
            userStats.total_minutes += Number(record.duration || 0);
        }

        // 공간별 랭킹 계산 후 내 순위 추출
        const myRanks = [];
        
        for (const [spaceId, userMap] of spaceUserStats.entries()) {
            const userList = Array.from(userMap.values());

            // 랭킹 정렬
            userList.sort((a, b) => {
                if (b.study_count !== a.study_count) {
                    return b.study_count - a.study_count;
                }
                return b.total_minutes - a.total_minutes;
            });

            const totalUsers = userList.length;
            const myIndex = userList.findIndex(user => user.user_id === userId);

            if (myIndex >= 0) {
                const myStats = userList[myIndex];
                myRanks.push({
                    space_id: spaceId,
                    user_rank: myIndex + 1,
                    total_users: totalUsers,
                    my_study_count: myStats.study_count,
                    my_total_minutes: myStats.total_minutes,
                    rank_percentage: +((myIndex + 1) / totalUsers * 100).toFixed(1)
                });
            }
        }

        // 랭킹 순으로 정렬
        myRanks.sort((a, b) => a.user_rank - b.user_rank)

        return res.json({
            success: true,
            items: myRanks,
            total_ranked_spaces: myRanks.length
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: '공간 랭킹 조회 실패' });
    }
});

// 최근 방문한 공간 조회
router.get('/my/recent-spaces', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my/recent-spaces');
  try {
    const userId = req.user.sub;
    const limit = parseInt(req.query.limit) || 4; // 기본 4개

    // 먼저 study_record만 조회해서 디버깅
    console.log('사용자 ID:', userId);
    
    const { data: studyRecords, error: studyError } = await supabase
      .from('study_record')
      .select('space_id, start_time')
      .eq('user_id', userId)
      .order('start_time', { ascending: false })
      .setHeader('Authorization', req.headers.authorization);

    if (studyError) {
      console.error('study_record 조회 에러:', studyError);
      throw studyError;
    }

    console.log('study_record 결과:', studyRecords?.length || 0, '개');
    console.log('space_id 샘플:', studyRecords?.slice(0, 3).map(r => r.space_id));

    if (!studyRecords || studyRecords.length === 0) {
      return res.json({
        success: true,
        items: [],
        total_count: 0,
        message: '공부 기록이 없습니다.'
      });
    }

    // 중복 제거된 space_id 추출
    const uniqueSpaceIds = [...new Set(studyRecords.map(r => r.space_id))].slice(0, limit);
    console.log('고유 공간 IDs:', uniqueSpaceIds);

    // 테이블 존재 여부 먼저 확인
    const { data: tableCheck, error: tableError } = await supabase
      .from('spaces')
      .select('id')
      .limit(1)
      .setHeader('Authorization', req.headers.authorization);

    if (tableError) {
      console.error('spaces 테이블 접근 에러:', tableError);
      console.log('에러 코드:', tableError.code);
      console.log('에러 메시지:', tableError.message);
      
      // spaces 테이블 없이 기본 정보만 반환
      const uniqueSpaces = [];
      const seenSpaceIds = new Set();

      for (const record of studyRecords) {
        if (!seenSpaceIds.has(record.space_id) && uniqueSpaces.length < limit) {
          seenSpaceIds.add(record.space_id);
          
          const kstDate = new Date(new Date(record.start_time).getTime() + 9 * 60 * 60 * 1000);
          
          uniqueSpaces.push({
            space_id: record.space_id,
            space_name: `공간 ${record.space_id.substring(0, 8)}`,
            space_image_url: null,
            last_visit_date: kstDate.toISOString().split('T')[0],
            last_visit_time: record.start_time
          });
        }
      }

      return res.json({
        success: true,
        items: uniqueSpaces,
        total_count: uniqueSpaces.length,
        warning: `spaces 테이블에 접근할 수 없습니다. 에러: ${tableError.message}`
      });
    }

    // spaces 테이블이 있으면 정보 조회
    const { data: spacesData, error: spacesError } = await supabase
      .from('spaces')
      .select('id, name, image_url')
      .in('id', uniqueSpaceIds)
      .setHeader('Authorization', req.headers.authorization);

    if (spacesError) {
      console.error('spaces 데이터 조회 에러:', spacesError);
    }

    console.log('spaces 테이블 결과:', spacesData?.length || 0, '개');

    // studyRecords와 spacesData를 매칭하여 결과 생성
    const spaceInfoMap = new Map();
    (spacesData || []).forEach(space => {
      spaceInfoMap.set(space.id, space);
    });

    const uniqueSpaces = [];
    const seenSpaceIds = new Set();

    for (const record of studyRecords) {
      if (!seenSpaceIds.has(record.space_id) && uniqueSpaces.length < limit) {
        seenSpaceIds.add(record.space_id);
        
        const kstDate = new Date(new Date(record.start_time).getTime() + 9 * 60 * 60 * 1000);
        const spaceInfo = spaceInfoMap.get(record.space_id);
        
        uniqueSpaces.push({
          space_id: record.space_id,
          space_name: spaceInfo?.name || `공간 ${record.space_id.substring(0, 8)}`,
          space_image_url: spaceInfo?.image_url || null,
          last_visit_date: kstDate.toISOString().split('T')[0], // YYYY-MM-DD 형식
          last_visit_time: record.start_time
        });
      }
    }

    return res.json({
      success: true,
      items: uniqueSpaces,
      total_count: uniqueSpaces.length
    });

  } catch (err) {
    console.error('최근 방문 공간 조회 상세 에러:', err);
    return res.status(500).json({ 
      error: '최근 방문 공간 조회 실패',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// 선호 공간 키워드 분석
router.get('/my/preferred-keywords', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my/preferred-keywords');
  try {
    const userId = req.user.sub;

    // 사용자의 공부 기록 조회 (최근 3개월)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const { data: studyRecords, error: studyError } = await supabase
      .from('study_record')
      .select('space_id, duration, start_time')
      .eq('user_id', userId)
      .gte('start_time', threeMonthsAgo.toISOString())
      .setHeader('Authorization', req.headers.authorization);

    if (studyError) throw studyError;

    if (!studyRecords || studyRecords.length === 0) {
      return res.json({
        success: true,
        preferred_keywords: {
          wifi_preference: [],
          power_preference: [],
          noise_preference: [],
          crowdness_preference: []
        },
        analysis_summary: '분석할 데이터가 충분하지 않습니다.'
      });
    }

    // 사용자가 공부한 공간들의 ID 추출
    const spaceIds = [...new Set(studyRecords.map(r => r.space_id))];

    // 해당 공간들의 feedback 데이터 조회 (공간별 최신 피드백 위주)
    const { data: feedbacks, error: feedbackError } = await supabase
      .from('feedback')
      .select(`
        space_id,
        wifi_score,
        power,
        noise_level,
        crowdness,
        comment,
        created_at
      `)
      .in('space_id', spaceIds)
      .order('created_at', { ascending: false })
      .setHeader('Authorization', req.headers.authorization);

    if (feedbackError) throw feedbackError;

    // 공간별 이용 통계 계산
    const spaceStats = new Map();
    let totalStudyTime = 0;

    studyRecords.forEach(record => {
      const spaceId = record.space_id;
      const duration = Number(record.duration || 0);
      totalStudyTime += duration;

      if (!spaceStats.has(spaceId)) {
        spaceStats.set(spaceId, {
          visit_count: 0,
          total_duration: 0
        });
      }

      const stats = spaceStats.get(spaceId);
      stats.visit_count += 1;
      stats.total_duration += duration;
    });

    const spaceFeedbacks = new Map();
    (feedbacks || []).forEach(feedback => {
      const spaceId = feedback.space_id;
      if (!spaceFeedbacks.has(spaceId)) {
        spaceFeedbacks.set(spaceId, feedback); 
      }
    });

    // 선호도 분석을 위한 점수 집계
    const wifiScores = [];
    const powerPreference = { true: 0, false: 1 }; 
    const noiseScores = [];
    const crowdnessScores = [];
    
    // 가중치 계산 (이용 시간과 방문 횟수 기반)
    for (const [spaceId, stats] of spaceStats.entries()) {
      const weight = (stats.total_duration / totalStudyTime) * 0.7 + 
                     (stats.visit_count / studyRecords.length) * 0.3;

      const feedback = spaceFeedbacks.get(spaceId);
      
      if (feedback) {
        // WiFi 점수 분석
        if (feedback.wifi_score !== null) {
          wifiScores.push({ score: feedback.wifi_score, weight });
        }

        // 콘센트(전원) 선호도 분석
        if (feedback.power !== null) {
          const key = feedback.power ? 'true' : 'false';
          powerPreference[key] += weight;
        }

        // 소음 레벨 분석
        if (feedback.noise_level !== null) {
          noiseScores.push({ score: feedback.noise_level, weight });
        }

        // 혼잡도 분석
        if (feedback.crowdness !== null) {
          crowdnessScores.push({ score: feedback.crowdness, weight });
        }
      }
    }

    // 선호도 키워드 생성
    const getWifiPreference = (scores) => {
      if (scores.length === 0) return [];
      const avgScore = scores.reduce((sum, item) => sum + item.score * item.weight, 0) / 
                      scores.reduce((sum, item) => sum + item.weight, 0);
      
      if (avgScore >= 4) return [{ keyword: "WiFi 좋음", percentage: Math.round(avgScore * 20) }];
      if (avgScore >= 3) return [{ keyword: "WiFi 보통", percentage: Math.round(avgScore * 20) }];
      return [{ keyword: "WiFi 개선 필요", percentage: Math.round(avgScore * 20) }];
    };

    const getPowerPreference = (preference) => {
      const total = preference.true + preference.false;
      if (total === 0) return [];
      
      const truePercentage = Math.round((preference.true / total) * 100);
      const falsePercentage = Math.round((preference.false / total) * 100);
      
      const result = [];
      if (truePercentage > 50) result.push({ keyword: "콘센트 많음", percentage: truePercentage });
      if (falsePercentage > 50) result.push({ keyword: "콘센트 부족", percentage: falsePercentage });
      
      return result;
    };

    const getNoisePreference = (scores) => {
      if (scores.length === 0) return [];
      const avgScore = scores.reduce((sum, item) => sum + item.score * item.weight, 0) / 
                      scores.reduce((sum, item) => sum + item.weight, 0);
      
      if (avgScore >= 4) return [{ keyword: "매우 시끄러움", percentage: Math.round(avgScore * 20) }];
      if (avgScore >= 3) return [{ keyword: "적당한 소음", percentage: Math.round(avgScore * 20) }];
      if (avgScore >= 2) return [{ keyword: "조용함", percentage: Math.round(avgScore * 20) }];
      return [{ keyword: "매우 조용함", percentage: Math.round(avgScore * 20) }];
    };

    const getCrowdnessPreference = (scores) => {
      if (scores.length === 0) return [];
      const avgScore = scores.reduce((sum, item) => sum + item.score * item.weight, 0) / 
                      scores.reduce((sum, item) => sum + item.weight, 0);
      
      if (avgScore >= 4) return [{ keyword: "매우 붐빔", percentage: Math.round(avgScore * 20) }];
      if (avgScore >= 3) return [{ keyword: "적당히 붐빔", percentage: Math.round(avgScore * 20) }];
      if (avgScore >= 2) return [{ keyword: "한적함", percentage: Math.round(avgScore * 20) }];
      return [{ keyword: "매우 한적함", percentage: Math.round(avgScore * 20) }];
    };

    const preferredKeywords = {
      wifi_preference: getWifiPreference(wifiScores),
      power_preference: getPowerPreference(powerPreference),
      noise_preference: getNoisePreference(noiseScores),
      crowdness_preference: getCrowdnessPreference(crowdnessScores)
    };

    // 분석 요약 생성
    const totalSpaces = spaceStats.size;
    const totalSessions = studyRecords.length;
    const averageSessionDuration = Math.round(totalStudyTime / totalSessions / 60); // 분 단위

    // 주요 선호도 추출
    const topPreferences = [];
    if (preferredKeywords.wifi_preference[0]) topPreferences.push(preferredKeywords.wifi_preference[0].keyword);
    if (preferredKeywords.power_preference[0]) topPreferences.push(preferredKeywords.power_preference[0].keyword);
    if (preferredKeywords.noise_preference[0]) topPreferences.push(preferredKeywords.noise_preference[0].keyword);
    if (preferredKeywords.crowdness_preference[0]) topPreferences.push(preferredKeywords.crowdness_preference[0].keyword);

    const analysisSummary = [
      `최근 3개월간 ${totalSpaces}개 공간에서 ${totalSessions}회 공부했습니다.`,
      `평균 공부 시간은 ${averageSessionDuration}분입니다.`,
      topPreferences.length > 0 ? `주로 ${topPreferences.slice(0, 2).join(', ')} 환경을 선호합니다.` : ''
    ].filter(Boolean).join(' ');

    return res.json({
      success: true,
      preferred_keywords: preferredKeywords,
      analysis_summary: analysisSummary,
      stats: {
        analysis_period_months: 3,
        total_spaces: totalSpaces,
        total_sessions: totalSessions,
        total_study_hours: Math.round(totalStudyTime / 3600),
        average_session_minutes: averageSessionDuration,
        analyzed_feedbacks: (feedbacks || []).length
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '선호 키워드 분석 실패' });
  }
});

export default router;