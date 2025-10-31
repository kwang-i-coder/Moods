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
        // 내가 공부한 공간들 조회
        // space_id, visit_count, last_visited, total_duration, name
        const { data: mySpaces, error: mySpacesError } = await supabase
            .from('visited_spaces')
            .select()
            .order('last_visited', { ascending: false })
            .setHeader('Authorization', req.headers.authorization);

        if (mySpacesError) throw mySpacesError;

        const spaceMap = {};
        mySpaces.forEach(s => {
          spaceMap[s.space_id] = s;
        });

        const { data: spaceImagesData, error: spaceImagesError } = await supabase
            .from('study_record')
            .select('space_id, img_path')
            .in('space_id', mySpaces.map(space => space.space_id))
            .order('start_time', { ascending: false })
            .setHeader('Authorization', req.headers.authorization);

        if (spaceImagesError) throw spaceImagesError;

        // google 사진이 없는 경우 최근 기록 사진으로 대체
        spaceImagesData.forEach(space => {
          if (space.img_path && !spaceMap[space.space_id]?.img_path) {
            spaceMap[space.space_id].img_path = space.img_path;
          }
        });

        // 공간 이름 및 이미지 url 비동기 호출
        const googleApiHeaders = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
            "X-Goog-FieldMask": "displayName",
        };

        // 사적 공간 id를 제외한 공간 id 저장
        const spaceIdsToFetch = Array.from(Object.keys(spaceMap)).filter(id => !validate(id));
        // 구글 등록 공간에 대한 사진 및 이름 요청
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

        Object.keys(spaceMap).forEach(async(space) => {
          // 이름이 없는 공간이면 -> 구글에 업로드된 공간이면 불러온 이름 추가
          if (!spaceMap[space].name){
            spaceMap[space].name = spaceNamesMap[space];
          }
        });

        const imagePromise = Object.keys(spaceMap).map(space_id => {
          const ret = async () => {
            // 사적 공간이거나 사진이 없는 공적 공간
            if(!spacePhotos[space_id]){
              const {data, error} = await supabaseAdmin.storage
                .from(spaceMap[space_id].img_path.split('/').length > 2? 'study-photos':'wallpaper')
                .createSignedUrl(spaceMap[space_id].img_path, Number(process.env.STUDY_PHOTO_URL_TTL_SECONDS || 86400));
                
              if (error) throw error;
              return {space_id: space_id, img_url: data.signedUrl}
            }else{
              return {space_id: space_id, img_url: spacePhotos[space_id]}
            }
          }
          return ret();
        }
      )
      const result = await Promise.allSettled(imagePromise);
      console.log(result);

      result.forEach(item => {
        if (item.status === 'fulfilled'){
          console.log(item.value);
          spaceMap[item.value.space_id].img_url = item.value.img_url;
        }
      })

      return res.status(200).json({
        success: true,
        data: Object.values(spaceMap).map((space)=>{
          return {
            space_name: space.name,
            my_study_count: space.visit_count,
            my_total_minutes: space.total_duration,
            space_image_url: space.img_url,
        }}).sort((a, b) => b.my_study_count - a.my_study_count)
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
    const limit = 10; // 항상 10개 고정
    
    const { data: studyRecords, error: studyError } = await supabase
      .from('study_record')
      .select('id, space_id, start_time, duration, img_path, spaces( name )')
      .order('start_time', { ascending: false })
      .limit(limit)
      .setHeader('Authorization', req.headers.authorization);

    if (studyError) {
      console.error('study_record 조회 에러:', studyError);
      throw studyError;
    }

    console.log('study_record 결과:', studyRecords?.length || 0, '개');

    if (!studyRecords || studyRecords.length === 0) {
      return res.json({
        success: true,
        items: [],
        total_count: 0,
        message: '공부 기록이 없습니다.'
      });
    }

    // space_id -> 최근 공부 기록 매핑
    // 해당 공간에 대한 기록 데이터가 있으면 삽입하지 않으므로 고유한 공간 추출
    const spaceDetailMap = {};
    studyRecords.forEach(rec => {
      // space_id에 대한 데이터가 들어오지 않았다면 삽입
      // 이미 있으면 skip
      if (rec.space_id && rec.img_path && !spaceDetailMap[rec.space_id]) {
        spaceDetailMap[rec.space_id] = {
          space_id: rec.space_id,
          img_path: rec.img_path,
          // 공적 장소인 경우 이름이 없음. 구글에서 호출해야함
          name: rec.spaces?.name || null,
          start_time: rec.start_time,
          duration: rec.duration
        };
      }
    });

    // 공간 이름 비동기 호출
    const googleApiHeaders = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "displayName",
    };

    const spaceIdsToFetch = Array.from(Object.keys(spaceDetailMap)).filter(id => !validate(id));
    const spaceIdsToFetchPhotos = Array.from(Object.keys(spaceDetailMap)).filter(id => spaceDetailMap[id]?.img_path === "general/Rectangle 34627910.png");
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

    const spaceImageUrls = await photoTools.getPhotoUrls(...spaceIdsToFetchPhotos);

    const fetchImageUrlAndName = async (spaceDetail) => {
      if(spaceDetail.name === null){
        spaceDetail.name = spaceNamesMap[spaceDetail.space_id];
      }

      // 기본 배경에 구글 사진 있으면 구글 사진 넣음
      if(spaceDetail.img_path === "general/Rectangle 34627910.png" && spaceImageUrls[spaceDetail.space_id]){
        spaceDetail.img_url = spaceImageUrls[spaceDetail.space_id];
      }else{
        // 그 이외의 경우에는 db에 있는대로 넣음
        const {data, error} = await supabaseAdmin.storage
          .from(spaceDetail.img_path.split('/').length > 2? 'study-photos':'wallpaper')
          .createSignedUrl(spaceDetail.img_path, Number(process.env.STUDY_PHOTO_URL_TTL_SECONDS || 86400));
          
        if (error) throw error;
        spaceDetail.img_url = data.signedUrl
      }
      return spaceDetail;
    }

    const fetchedSpaceDetails = await Promise.allSettled(Object.values(spaceDetailMap).map(fetchImageUrlAndName));
    const items = fetchedSpaceDetails.filter(item => item.status === 'fulfilled').map(item => {
      return {space_id: item.value.space_id,
      space_name: item.value.name,
      space_image_url: item.value.img_url,
      last_visit_date: item.value.start_time.split('T')[0],
      last_visit_time: item.value.start_time,
      duration: item.value.duration
      }
    }).sort((a, b) => b.last_visit_date - a.last_visit_date);


    return res.json({
      success: true,
      items,
      total_count: items.length
    })

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

    const { data: studyRecords, error: studyError } = await supabase
      .from('study_record')
      .select(`
        id,
        space_id,
        duration,
        start_time,
        study_record_mood_tags (
          mood_tags ( mood_id )
        )
      `)
      .eq('user_id', userId)
      .order('start_time', { ascending: false })
      .setHeader('Authorization', req.headers.authorization);

    if (studyError) throw studyError;

    if (!studyRecords || studyRecords.length === 0) {
      return res.json({
        success: true,
        keywords: {
          types: [],
          moods: [],
          features: []
        },
        message: '분석할 공부 기록이 없습니다.'
      });
    }

    const spaceStats = new Map(); 
    let totalStudyTime = 0;

    studyRecords.forEach(rec => {
      const sid = rec.space_id;
      const dur = Number(rec.duration || 0);
      totalStudyTime += dur;

      if (!spaceStats.has(sid)) {
        spaceStats.set(sid, { visit_count: 0, total_duration: 0 });
      }
      const s = spaceStats.get(sid);
      s.visit_count += 1;
      s.total_duration += dur;
    });

    if (totalStudyTime <= 0) totalStudyTime = 1;

    const weightForSpace = (sid) => {
      const stats = spaceStats.get(sid) || { visit_count: 0, total_duration: 0 };
      return (stats.total_duration / totalStudyTime) * 0.7 +
             (stats.visit_count / studyRecords.length) * 0.3;
    };

    const mapGoogleTypeToKorean = (type) => {
      if (!type) return null;
      const lower = String(type).toLowerCase();
      const mapping = {
        'cafe': '카페',
        'coffee_shop': '카페',
        'library': '도서관',
        'book_store': '서점',
        'university': '대학교',
        'school': '학교',
        'coworking_space': '코워킹스페이스',
        'study_area': '스터디 카페',
        'internet_cafe': 'PC방',
        'restaurant': '식당',
        'bakery': '베이커리',
        'fast_food_restaurant': '패스트푸드',
        'convenience_store': '편의점',
        'park': '공원',
        'museum': '박물관',
        'movie_theater': '영화관',
        'shopping_mall': '쇼핑몰'
      };
      if (mapping[lower]) return mapping[lower];
      if (lower.endsWith('_cafe')) return '카페';
      if (lower.endsWith('_library')) return '도서관';
      return null;
    };

    const uniqueSpaceIds = [...new Set(studyRecords.map(r => r.space_id))];

    const googleApiHeaders = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'types'
    };

    const fetchTypesForSpace = async (spaceId) => {
      try {
        if (validate(spaceId)) return [];
      } catch (_) {}

      const res = await fetch(`https://places.googleapis.com/v1/places/${spaceId}?languageCode=ko&regionCode=kr`, {
        method: 'GET',
        headers: googleApiHeaders
      });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.types) ? json.types : [];
    };

    const typeScore = new Map(); 
    await Promise.all(uniqueSpaceIds.map(async (sid) => {
      const types = await fetchTypesForSpace(sid);
      const w = weightForSpace(sid);
      (types || []).forEach(t => {
        const label = mapGoogleTypeToKorean(t);
        if (label) {
          typeScore.set(label, (typeScore.get(label) || 0) + w);
        }
      });
    }));

    const typesSorted = [...typeScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2) 
      .map(([label]) => label);

    const moodScore = new Map(); 
    studyRecords.forEach(rec => {
      const moods = Array.isArray(rec?.study_record_mood_tags)
        ? rec.study_record_mood_tags
            .map(m => (m?.mood_tags?.mood_id || '').trim())
            .filter(Boolean)
        : [];
      if (moods.length === 0) return;
      const w = weightForSpace(rec.space_id);
      const each = w / moods.length;
      moods.forEach(moodKo => {
        moodScore.set(moodKo, (moodScore.get(moodKo) || 0) + each);
      });
    });

    const moodsSorted = [...moodScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2) 
      .map(([label]) => label);

    const { data: feedbacks, error: feedbackError } = await supabase
      .from('feedback')
      .select('space_id, wifi_score, power, noise_level, crowdness, created_at')
      .in('space_id', uniqueSpaceIds)
      .order('created_at', { ascending: false })
      .setHeader('Authorization', req.headers.authorization);

    if (feedbackError) throw feedbackError;

    const latestBySpace = new Map();
    (feedbacks || []).forEach(fb => {
      if (!latestBySpace.has(fb.space_id)) {
        latestBySpace.set(fb.space_id, fb);
      }
    });

    let wifiWeightedSum = 0, wifiWeight = 0;
    let noiseWeightedSum = 0, noiseWeight = 0;
    let crowdWeightedSum = 0, crowdWeight = 0;
    let powerTrueWeight = 0, powerFalseWeight = 0;

    uniqueSpaceIds.forEach(sid => {
      const fb = latestBySpace.get(sid);
      if (!fb) return;
      const w = weightForSpace(sid);

      if (typeof fb.wifi_score === 'number') {
        wifiWeightedSum += fb.wifi_score * w;
        wifiWeight += w;
      }
      if (typeof fb.noise_level === 'number') {
        noiseWeightedSum += fb.noise_level * w;
        noiseWeight += w;
      }
      if (typeof fb.crowdness === 'number') {
        crowdWeightedSum += fb.crowdness * w;
        crowdWeight += w;
      }
      if (typeof fb.power === 'boolean') {
        if (fb.power) powerTrueWeight += w;
        else powerFalseWeight += w;
      }
    });

    const features = [];
    if (powerTrueWeight > powerFalseWeight * 1.1) features.push('콘센트 많음');

    const noiseAvg = noiseWeight ? (noiseWeightedSum / noiseWeight) : null;
    if (noiseAvg !== null) {
      if (noiseAvg <= 2.2) features.push('소음 낮음');
      else if (noiseAvg >= 3.4) features.push('소음 높음');
      else features.push('소음 보통');
    }

    const crowdAvg = crowdWeight ? (crowdWeightedSum / crowdWeight) : null;
    if (crowdAvg !== null) {
      if (crowdAvg <= 2.4) features.push('자리 많음');
      else if (crowdAvg >= 3.4) features.push('자리 적음');
      else features.push('자리 보통');
    }

    return res.json({
      success: true,
      keywords: {
        types: typesSorted,   
        moods: moodsSorted,   
        features              
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '선호 공간 키워드 분석 실패' });
  }
});

export default router;