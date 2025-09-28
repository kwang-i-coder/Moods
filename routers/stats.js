import express from 'express';
import supabase from '../lib/supabaseClient.js';
import verifySupabaseJWT from '../lib/verifyJWT.js';
import { validate } from 'uuid';
import photoTools from '../lib/photoTools.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';


const router = express.Router();

async function signStudyPhotoKeyMaybe(key, ttlSeconds = Number(process.env.STUDY_PHOTO_URL_TTL_SECONDS || 86400)) {
  if (!key || typeof key !== 'string') return null;

  const variants = [];
  const trimmed = key.trim();

  variants.push(trimmed);

  if (trimmed.startsWith('study-photos/')) {
    variants.push(trimmed.replace(/^study-photos\//, ''));
  }

  if (trimmed.startsWith('/')) {
    variants.push(trimmed.replace(/^\//, ''));
  }

  const uniq = [...new Set(variants)].filter(v => v.length > 0);

  const expanded = [];
  for (const k of uniq) {
    const last = k.split('/').pop() || '';
    if (!last.includes('.')) {
      expanded.push(k + '.jpg');
      expanded.push(k + '.png');
      expanded.push(k + '.webp');
    }
  }
  const allCandidates = [...new Set([...uniq, ...expanded])];

  for (const candidate of allCandidates) {
    const { data: signedData, error: signedError } = await supabaseAdmin
      .storage
      .from('study-photos')
      .createSignedUrl(candidate, ttlSeconds);
    if (!signedError && signedData?.signedUrl) {
      return signedData.signedUrl;
    }
  }

  for (const candidate of allCandidates) {
    const { data: signedData2, error: signedError2 } = await supabase
      .storage
      .from('study-photos')
      .createSignedUrl(candidate, ttlSeconds);
    if (!signedError2 && signedData2?.signedUrl) {
      return signedData2.signedUrl;
    }
  }
  return null;
}

// 공통: 분→"X시간 Y분" 포맷터
const toHMText = (minutes) => {
  const totalSeconds = Math.round(Number(minutes) * 60 || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// 월별 요약
router.get('/my-summary/monthly', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my-summary/monthly');
  try {
    const userId = req.user.sub;
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    
    const year = Number(req.query.year) || kstNow.getFullYear();
    const month = Number(req.query.month) || (kstNow.getMonth() + 1);

    // 특정 월 조회
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1)).toISOString();

    const { data: rows, error } = await supabase
      .from('study_record')
      .select('duration, start_time')
      .eq('user_id', userId)
      .gte('start_time', from)
      .lt('start_time', to)
      .setHeader('Authorization', req.headers.authorization);

    if (error) throw error;

    let sessions = 0;
    let total_seconds = 0;
    
    (rows || []).forEach((r) => {
      sessions += 1;
      total_seconds += Number(r.duration || 0);
    });

    // 정수로 변환하여 소수점 제거
    total_seconds = Math.floor(total_seconds);

    const hours = Math.floor(total_seconds / 3600);
    const minutes = Math.floor((total_seconds % 3600) / 60);
    const seconds = total_seconds % 60;
    
    const time_display = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;

    return res.json({ 
      success: true, 
      year,
      month,
      data: {
        month: monthKey,
        sessions,
        time_display 
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '월별 통계 조회 실패' });
  }
});

// 주별 요약 (이번 주만 조회, 일요일~토요일)
router.get('/my-summary/weekly', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my-summary/weekly');
  try {
    const userId = req.user.sub;
    const now = new Date();
    
    // KST 기준으로 현재 시간 계산
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    
    // 이번 주 일요일부터 토요일까지 계산 (KST 기준)
    const getCurrentWeekRange = () => {
      const current = new Date(kstNow);
      current.setHours(0, 0, 0, 0);
      
      // 일요일 계산 (일요일=0, 월요일=1, ..., 토요일=6)
      const dayOfWeek = current.getDay(); // 0=일요일, 1=월요일, ..., 6=토요일
      const sunday = new Date(current);
      sunday.setDate(current.getDate() - dayOfWeek);
      
      // 토요일 계산
      const saturday = new Date(sunday);
      saturday.setDate(sunday.getDate() + 6);
      saturday.setHours(23, 59, 59, 999);
      
      return { sunday, saturday };
    };

    const { sunday, saturday } = getCurrentWeekRange();
    
    const from = new Date(sunday.getTime() - 9 * 60 * 60 * 1000);
    const to = new Date(saturday.getTime() - 9 * 60 * 60 * 1000);

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

    let sessions = 0;
    let total_seconds = 0;
    
    (rows || []).forEach((r) => {
      sessions += 1;
      total_seconds += Number(r.duration || 0);
    });

    total_seconds = Math.floor(total_seconds);

    const hours = Math.floor(total_seconds / 3600);
    const minutes = Math.floor((total_seconds % 3600) / 60);
    const seconds = total_seconds % 60;
    
    const time_display = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    const weekData = {
      sessions,
      time_display
    };

    return res.json({ 
      success: true, 
      current_week: weekData
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '주별 통계 조회 실패' });
  }
});

// 총 공부 횟수
router.get('/my-summary/total', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my-summary/total');
  try {
    const userId = req.user.sub;

    const { count, error } = await supabase
      .from('study_record')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .setHeader('Authorization', req.headers.authorization);

    if (error) throw error;

    return res.json({
      success: true,
      total_sessions: count
    });
  } catch (err) {
    console.error('총 공부 횟수 조회 에러:', err);
    return res.status(500).json({ error: '총 공부 횟수 조회 실패' });
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
            .setHeader('Authorization', req.headers.authorization);

        if (mySpacesError) throw mySpacesError;

        const mySpaceIds = [ ...new Set(mySpaces.map(s => s.space_id))];

        if (mySpaceIds.length === 0) {
            return res.json({ success: true, items: [] });
        } 

        // 내가 공부한 공간들의 모든 유저 데이터 조회
        const { data: rows, error } = await supabase
            .from("study_record")
            .select("space_id, user_id, duration, spaces!inner(name, image_url)")
            .in("space_id", mySpaceIds)
            .setHeader('Authorization', req.headers.authorization);

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

        // 공간 이름 및 이미지 url 비동기 호출
        const googleApiHeaders = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
            "X-Goog-FieldMask": "displayName",
        };

        const spaceIdsToFetch = Array.from(spaceUserStats.keys()).filter(id => !validate(id));
        const spacePhotosPromise = photoTools.getPhotoUrls(...spaceIdsToFetch);
        const spaceNamePromises = spaceIdsToFetch.map(spaceId => {
          return fetch(
            `https://places.googleapis.com/v1/places/${spaceId}?languageCode=ko&regionCode=kr`, 
            {
              method: 'GET',
              headers: googleApiHeaders
            }
          ).then(async (response) => {
            const res = await response.json();
            return { spaceId, name: res.displayName.text };
          })
        });

        const spacePhotos = await spacePhotosPromise;
        const spaceNamesArray = await Promise.allSettled(spaceNamePromises);
        const spaceNamesMap = {}
        spaceNamesArray.map(item => {
          if (item.status === 'fulfilled') {
            spaceNamesMap[item.value.spaceId] = item.value.name;
          }
        });
        console.log('공간 이름 매핑:', spaceNamesMap);
        console.log('공간 사진 매핑:', spacePhotos);

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

            const myIndex = userList.findIndex(user => user.user_id === userId);

            if (myIndex >= 0) {
                const myStats = userList[myIndex];
                const spaceInfo = rows.find(r => r.space_id === spaceId && r.user_id === userId)?.spaces;
                spaceInfo.name = spaceNamesMap[spaceId] || spaceInfo?.name;

                myRanks.push({
                    space_name: spaceNamesMap[spaceId] || spaceInfo?.name,
                    space_image_url: spacePhotos[spaceId] || null,
                    my_study_count: myStats.study_count,
                    my_total_minutes: myStats.total_minutes,
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
  console.error('에러 메시지:', err);
  return res.status(500).json({
    error: '공간 랭킹 조회 실패'
  });
}
});

// 나의 공부 장소 횟수 조회
router.get('/my-summary/space-count', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my-summary/space-count');
  try {
    const userId = req.user.sub;
    const { data, error } = await supabase
      .from('study_record')
      .select('space_id')
      .eq('user_id', userId)
      .setHeader('Authorization', req.headers.authorization);

    if (error) throw error;

    const uniqueCount = new Set((data || []).map(r => r.space_id)).size;

    return res.json({ success: true, total_spaces: uniqueCount });
  } catch (err) {
    console.error('공간 수 조회 에러:', err);
    return res.status(500).json({ error: '공간 수 조회 실패' });
  }
});

// 최근 방문한 공간 조회
router.get('/my/recent-spaces', verifySupabaseJWT, async (req, res) => {
  console.log('[라우터 호출] GET /stats/my/recent-spaces');
  try {
    const userId = req.user.sub;

    // 먼저 study_record만 조회해서 디버깅
    console.log('사용자 ID:', userId);
    
    const { data: studyRecords, error: studyError } = await supabase
      .from('study_record')
      .select('id, space_id, start_time, duration, record_photos ( path ), study_record_mood_tags ( mood_tags ( mood_id ) )')
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
    const uniqueSpaceIds = [...new Set(studyRecords.map(r => r.space_id))];
    console.log('고유 공간 IDs:', uniqueSpaceIds);

    const { data: spacesData, error: spacesError } = await supabase
      .from('spaces')
      .select('id, name')
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

    // 공간 이름 비동기 호출
    const googleApiHeaders = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "displayName",
    };

    const spaceIdsToFetch = Array.from(uniqueSpaceIds).filter(id => !validate(id));
    const spaceNamePromises = spaceIdsToFetch.map(spaceId => {
      return fetch(
        `https://places.googleapis.com/v1/places/${spaceId}?languageCode=ko&regionCode=kr`, 
        {
          method: 'GET',
          headers: googleApiHeaders
        }
      ).then(async (response) => {
        const res = await response.json();
        return { spaceId, name: res.displayName.text };
      })
    });

    const spaceNamesArray = await Promise.allSettled(spaceNamePromises);
    const spaceNamesMap = {}
    spaceNamesArray.map(item => {
      if (item.status === 'fulfilled') {
        spaceNamesMap[item.value.spaceId] = item.value.name;
      }
    });
    console.log('공간 이름 매핑:', spaceNamesMap);

    const imageUrlMap = {};
    await Promise.all(
      (studyRecords || []).map(async (rec) => {
        let signed = null;

        // 업로드 사진 우선
        const photoPaths = Array.isArray(rec?.record_photos)
          ? rec.record_photos.map(p => p?.path).filter(Boolean)
          : [];
        for (const p of photoPaths) {
          signed = await signStudyPhotoKeyMaybe(p);
          if (signed) break;
        }

        if (!signed) {
          const moods = Array.isArray(rec?.study_record_mood_tags)
            ? rec.study_record_mood_tags
                .map(m => (m?.mood_tags?.mood_id || '').trim())
                .filter(Boolean)
            : [];
          const { url } = await photoTools.getMoodWallpaper(moods || []);
          signed = url || null;
        }

        imageUrlMap[rec.id] = signed;
      })
    );

    const items = [];
    for (const record of studyRecords) {
      const kstDate = new Date(new Date(record.start_time).getTime() + 9 * 60 * 60 * 1000);
      const spaceInfo = spaceInfoMap.get(record.space_id);
      const wallpaperUrl = imageUrlMap[record.id] || null;

      items.push({
        space_id: record.space_id,
        space_name: spaceNamesMap[record.space_id] || spaceInfo?.name || '이름 없음',
        space_image_url: wallpaperUrl || null,
        last_visit_date: kstDate.toISOString().split('T')[0],
        last_visit_time: record.start_time,
        duration: Number(record.duration || 0)
      });
    }

    return res.json({
      success: true,
      items,
      total_count: items.length
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

      const { data: spaceMeta, error: spaceMetaError } = await supabase
        .from('spaces')
        .select('id, type_tags, mood_tags')
        .in('id', spaceIds)
        .setHeader('Authorization', req.headers.authorization);;

    if (feedbackError) throw feedbackError;
    if (spaceMetaError) throw spaceMetaError;

    const typeCount = {};
    const moodCount = {};
    spaceMeta.forEach(space => {
      (space.type_tags || []).forEach(tag => {
        typeCount[tag] = (typeCount[tag] || 0) + 1;
      });
      (space.mood_tags || []).forEach(tag => {
        moodCount[tag] = (moodCount[tag] || 0) + 1;
      });
    });

    // 상위 선호 태그 추출
    const sortedTags = (tagMap) =>
      Object.entries(tagMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag, count]) => ({ keyword: tag, count }));

    const preferred_keywords = {};
    preferred_keywords.type_tags = sortedTags(typeCount);
    preferred_keywords.mood_tags = sortedTags(moodCount);

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