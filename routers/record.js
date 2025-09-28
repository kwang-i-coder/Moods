import express from "express";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";
import photoTools from "../lib/photoTools.js";

const router = express.Router();
router.use(verifySupabaseJWT);

function isValidUuidV4(uuid) {
  // UUID v4 정규 표현식
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}

// 시간 포맷터: 초 → "HH:MM:SS"
function toHHMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function normalizeGoals(goals) {
  if (Array.isArray(goals)) {
    return goals.map(g => (typeof g === 'string' ? { text: g, done: true } : g));
  }
  if (typeof goals === 'string') {
    const parts = goals.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    return parts.map(p => ({ text: p, done: true }));
  }
  if (typeof goals === 'object' && goals !== null) {
    return Array.isArray(goals.items) ? goals.items : [];
  }
  return [];
}

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

//  태그 정보를 가져오는 헬퍼 함수 추가
const getTagsForRecords = async (recordIds, authorization) => {
    if (!recordIds || recordIds.length === 0) return {};
    
    try {
        const { data: recordTag, error: recordTagError } = await supabase
            .from("record_tag")
            .select("record_id, tag_id")
            .in("record_id", recordIds)
            .setHeader('Authorization', authorization);

        if (recordTagError) {
            console.error("record_tags 조회 오류:", recordTagError);
            return {};
        }

        const tagIds = [...new Set(recordTag.map(rt => rt.tag_id))];
        
        if (tagIds.length === 0) return {};

        const { data: tags, error: tagsError } = await supabase
            .from("tags")
            .select("id, tag")
            .in("id", tagIds)
            .setHeader('Authorization', authorization);

        if (tagsError) {
            console.error("tags 조회 오류:", tagsError);
            return {};
        }

        const tagMap = {};
        tags.forEach(tag => {
            tagMap[tag.id] = tag;
        });

        const recordTagMap = {};
        recordTag.forEach(rt => {
            if (!recordTagMap[rt.record_id]) {
                recordTagMap[rt.record_id] = [];
            }
            if (tagMap[rt.tag_id]) {
                recordTagMap[rt.record_id].push(tagMap[rt.tag_id]);
            }
        });

        return recordTagMap;
    } catch (error) {
        console.error("태그 조회 중 오류:", error);
        return {};
    }
};

// record 조회 (사용자별, 날짜별))
router.get("/records", async (req, res) => {
    const { date, user_id, space_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        let query = supabaseAdmin
            .from("study_record")
            .select(`*`)
            .setHeader("Authorization", req.headers.authorization)

        // 날짜 필터링
        if (date) {
            // 날짜 형식 검증 (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(date)) {
                return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" });
            }

            const startOfDay = `${date}T00:00:00.000Z`;
            const endOfDay = `${date}T23:59:59.999Z`;
            
            query = query
                .gte("start_time", startOfDay)
                .lte("end_time", endOfDay);
        }

        // 스페이스 필터링
        if (space_id) {
            query = query.eq("space_id", space_id);
        }

        const { data, error } = await query.order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({ error: "레코드 조회에 실패했습니다.", details: error.message });
        }

        // 태그 정보 추가
        const recordIds = data.map(record => record.id);
        const tagsMap = await getTagsForRecords(recordIds, req.headers.authorization);

        const recordsWithTags = data.map((record) => ({
          ...record,
          tags: tagsMap[record.id] || []
        }));

        res.status(200).json({
            message: "학습 기록을 조회했습니다.",
            count: recordsWithTags.length,
            records: recordsWithTags
        });
    
    } catch (error) {
        console.error("레코드 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

async function buildRecordCardFromRow(row, authorization) {
  // 날짜/시간
  const start = row.start_time ? new Date(row.start_time) : null;
  const end = row.end_time ? new Date(row.end_time) : null;
  const totalSec = (start && end) ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
  const netSec = Number.isFinite(Number(row.duration)) ? Math.floor(Number(row.duration)) : 0;
  const netTime = toHHMMSS(netSec);
  const dateStr = row.start_time ? row.start_time.slice(0, 10) : null;

  // 목표 정규화
  const goals = normalizeGoals(row.goals);

  // 감정 태그
  const emotionsArr = Array.isArray(row.record_emotions) ? row.record_emotions : [];
  const emotions = emotionsArr
    .map(e => e?.emotions?.name)
    .filter(v => typeof v === 'string' && v.trim().length > 0);

  if (emotions.length === 0) {
    try {
      const { data: reRows, error: reErr } = await supabaseAdmin
        .from('record_emotions')
        .select('emotion_id')
        .eq('record_id', row.id);

      if (!reErr && Array.isArray(reRows) && reRows.length > 0) {
        const emotionIds = reRows.map(r => r.emotion_id).filter(Boolean);
        if (emotionIds.length > 0) {
          const { data: emRows, error: emErr } = await supabaseAdmin
            .from('emotions')
            .select('id, name')
            .in('id', emotionIds);

          if (!emErr && Array.isArray(emRows)) {
            const byId = {};
            emRows.forEach(r => { byId[r.id] = r.name; });
            const dedupNames = [...new Set(emotionIds.map(eid => byId[eid]).filter(v => typeof v === 'string' && v.trim().length > 0))];
            if (dedupNames.length > 0) {
              emotions.splice(0, emotions.length, ...dedupNames);
            }
          }
        }
      }
    } catch (fallbackErr) {
      console.error('emotions fallback 실패:', fallbackErr);
    }
  }

  // 피드백(공간 태그)
  let feedbackFields = { wifi_score: null, power: null, noise_level: null, crowdness: null };
  try {
    const spaceIdForFeedback = row.spaces?.id ?? row.space_id ?? null;
    if (spaceIdForFeedback) {
      const { data: fb, error: fbErr } = await supabase
        .from('feedback')
        .select('wifi_score, power, noise_level, crowdness')
        .eq('space_id', spaceIdForFeedback)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .setHeader('Authorization', authorization);
      if (!fbErr && fb) {
        feedbackFields = {
          wifi_score: typeof fb.wifi_score === 'number' ? fb.wifi_score : (fb.wifi_score ?? null),
          power: typeof fb.power === 'boolean' ? fb.power : (fb.power ?? null),
          noise_level: typeof fb.noise_level === 'number' ? fb.noise_level : (fb.noise_level ?? null),
          crowdness: typeof fb.crowdness === 'number' ? fb.crowdness : (fb.crowdness ?? null),
        };
      }
    }
  } catch (e) {
    console.error('feedback 조회 실패:', e);
  }

  // Google Place types → 한글 매핑
  function mapGoogleTypeToKorean(type) {
    const mapping = {
      'cafe': '카페',
      'library': '도서관',
      'restaurant': '식당',
      'university': '대학교',
      'school': '학교',
      'book_store': '서점',
      'coworking_space': '코워킹스페이스',
      'coffee_shop': '카페',
      'study_area': '스터디룸',
      'internet_cafe': 'PC방',
      'bar': '술집',
      'bakery': '베이커리',
      'fast_food_restaurant': '패스트푸드',
      'convenience_store': '편의점',
      'park': '공원',
      'museum': '박물관',
      'church': '교회',
      'amusement_park': '놀이공원',
      'movie_theater': '영화관',
      'train_station': '기차역',
      'bus_station': '버스터미널',
      'shopping_mall': '쇼핑몰',
    };
    if (!type) return null;
    const lower = type.toLowerCase();
    if (mapping[lower]) return mapping[lower];
    if (lower.endsWith('_cafe')) return '카페';
    if (lower.endsWith('_library')) return '도서관';
    return null;
  }

  // 장소 이름/타입
  let placeTypes = [];
  let placeDisplayName = row.spaces?.name ?? null;
  if (row.spaces?.name === null && !isValidUuidV4(row.spaces?.id)) {
    try {
      const googleApiHeaders = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "displayName,types",
      };
      const placeRes = await fetch(
        `https://places.googleapis.com/v1/places/${row.spaces.id}?languageCode=ko&regionCode=kr`,
        { method: 'GET', headers: googleApiHeaders }
      );
      if (placeRes.ok) {
        const placeJson = await placeRes.json();
        placeDisplayName = placeJson?.displayName?.text ?? row.spaces.id;
        placeTypes = Array.isArray(placeJson?.types) ? placeJson.types : [];
      }
    } catch (apiErr) {
      console.error('Google Places API 호출 실패:', apiErr);
    }
  }
  let primaryType = null;
  for (const t of (placeTypes || [])) {
    const mapped = mapGoogleTypeToKorean(t);
    if (mapped) { primaryType = mapped; break; }
  }

  // 무드 태그
  const recMoods = Array.isArray(row.record_moods) ? row.record_moods : [];
  const moodList = [
    ...new Set(
      recMoods
        .map((m) =>
          (m && m.mood_tags && typeof m.mood_tags.mood_id === 'string'
            ? m.mood_tags.mood_id.replace(/\r?\n/g, '').trim()
            : '')
        )
        .filter(Boolean)
    ),
  ];

  // 이미지
  let imageUrl = null;
  try {
    let paths = Array.isArray(row.record_photos) ? row.record_photos.map(p => p?.path).filter(Boolean) : [];

    if (paths.length === 0) {
      const { data: photoRows, error: photoErr } = await supabaseAdmin
        .from('record_photos')
        .select('path')
        .eq('record_id', row.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (!photoErr && Array.isArray(photoRows)) {
        paths = photoRows.map(r => r.path).filter(Boolean);
      }
    }

    for (const p of paths) {
      imageUrl = await signStudyPhotoKeyMaybe(p, Number(process.env.STUDY_PHOTO_URL_TTL_SECONDS || 86400));
      if (imageUrl) break;
    }

    if (!imageUrl) {
      const { url: moodUrl } = await photoTools.getMoodWallpaper(moodList || []);
      if (moodUrl) {
        imageUrl = moodUrl;
      }
    }
  } catch (e) {
    console.error('이미지 URL 생성 실패:', e);
  }

  if (row.spaces?.name === null && !isValidUuidV4(row.spaces?.id)) {
    try {
      const googleApiHeaders = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "displayName",
      };
      const placeRes = await fetch(
        `https://places.googleapis.com/v1/places/${row.spaces.id}?languageCode=ko&regionCode=kr`,
        { method: 'GET', headers: googleApiHeaders }
      );
      if (placeRes.ok) {
        const placeJson = await placeRes.json();
        row.spaces.name = placeJson?.displayName?.text ?? row.spaces.id;
      }
    } catch (apiErr) {
      console.error('Google Places API 호출 실패:', apiErr);
    }
  }

  return {
    id: row.id,
    date: dateStr,
    total_time: toHHMMSS(totalSec),
    net_time: netTime,
    title: row.title ?? null,
    image_url: imageUrl,
    goals,
    emotions,
    space: {
      id: row.spaces?.id ?? row.space_id ?? null,
      name: placeDisplayName ?? row.spaces?.name ?? null,
      type: primaryType,
      mood: moodList,
      tags: feedbackFields
    }
  };
}

// 기록 캘린더: 특정 연도/월에 해당하는 기록 전체 조회
router.get("/records/calendar", async (req, res) => {
    const { year, month } = req.query;

    if (!year || !month) {
        return res.status(400).json({ error: "연도와 월를 모두 입력해야 합니다." });
    }

    const parsedYear = parseInt(year, 10);
    const parsedMonth = parseInt(month, 10);

    if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        return res.status(400).json({ error: "올바른 연도 및 월을 입력해주세요." });
    }

    try {
        const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
        const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 0, 23, 59, 59));

        const { data: records, error } = await supabase
            .from("study_record")
            .select(`
              id, title, duration, start_time, end_time, goals, space_id,
              record_photos:record_photos ( path ),
              spaces:spaces ( id, name ),
              record_emotions:record_emotions ( emotions:emotions ( id, name ) ),
              record_moods:study_record_mood_tags ( mood_tags:mood_tags ( mood_id ) )
            `)
            .gte("start_time", startDate.toISOString())
            .lte("end_time", endDate.toISOString())
            .order("start_time", { ascending : true })
            .setHeader('Authorization', req.headers.authorization);

        if (error) {
            return res.status(500).json({ error: "기록 캘린더 조회 실패", details: error.message});
        }

        const recordsByDay = {};
        for (let i = 1; i <= 31; i++) {
            recordsByDay[i] = [];
        }

        for (const record of (records || [])) {
            const day = new Date(record.start_time).getUTCDate();
            const card = await buildRecordCardFromRow(record, req.headers.authorization);
            recordsByDay[day].push(card);
        }

        res.status(200).json({
            message: "기록 캘린더 데이터를 성공적으로 불러왔습니다.",
            year: parsedYear,
            month: parsedMonth,
            records_by_day: recordsByDay
        });

    } catch (error) {
        console.error("기록 캘린더 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류 발생" });
    }
});

// 단일 record 조회
router.get("/records/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('study_record')
      .select(`
        id, title, duration, start_time, end_time, goals, space_id,
        record_photos:record_photos ( path ),

        spaces:spaces (
          id, name, type_tags
        ),

        record_emotions:record_emotions (
          emotions:emotions ( id, name )
        ),

        record_moods:study_record_mood_tags (
          mood_tags:mood_tags ( id, mood_id, tag_en )
        )
      `)
      .eq("id", id)
      .maybeSingle()
      .setHeader('Authorization', req.headers.authorization);

    if (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "레코드를 찾을 수 없습니다." });
    }

    const start = data.start_time ? new Date(data.start_time) : null;
    const end = data.end_time ? new Date(data.end_time) : null;
    const totalSec = (start && end) ? Math.max(0, Math.floor((end - start) / 1000)) : 0;

    const netSec = Number.isFinite(Number(data.duration)) ? Math.floor(Number(data.duration)) : 0;
    const netTime = toHHMMSS(netSec);

    const dateStr = data.start_time ? data.start_time.slice(0, 10) : null;

    const goals = normalizeGoals(data.goals);

    const emotionsArr = Array.isArray(data.record_emotions) ? data.record_emotions : [];
    const emotions = emotionsArr
      .map(e => e?.emotions?.name)
      .filter(v => typeof v === 'string' && v.trim().length > 0);

    if (emotions.length === 0) {
      try {
        const { data: reRows, error: reErr } = await supabaseAdmin
          .from('record_emotions')
          .select('emotion_id')
          .eq('record_id', id);

        if (!reErr && Array.isArray(reRows) && reRows.length > 0) {
          const emotionIds = reRows.map(r => r.emotion_id).filter(Boolean);
          if (emotionIds.length > 0) {
            const { data: emRows, error: emErr } = await supabaseAdmin
              .from('emotions')
              .select('id, name')
              .in('id', emotionIds);

            if (!emErr && Array.isArray(emRows)) {
              const byId = {};
              emRows.forEach(row => { byId[row.id] = row.name; });
              const dedupNames = [...new Set(emotionIds.map(eid => byId[eid]).filter(v => typeof v === 'string' && v.trim().length > 0))];
              if (dedupNames.length > 0) {
                emotions.splice(0, emotions.length, ...dedupNames);
              }
            }
          }
        }
      } catch (fallbackErr) {
        console.error('emotions fallback 실패:', fallbackErr);
      }
    }

    let feedbackFields = { wifi_score: null, power: null, noise_level: null, crowdness: null };
    try {
      const spaceIdForFeedback = data.spaces?.id ?? data.space_id ?? null;
      if (spaceIdForFeedback) {
        const { data: fb, error: fbErr } = await supabase
          .from('feedback')
          .select('wifi_score, power, noise_level, crowdness')
          .eq('space_id', spaceIdForFeedback)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
          .setHeader('Authorization', req.headers.authorization);
        if (!fbErr && fb) {
          feedbackFields = {
            wifi_score: typeof fb.wifi_score === 'number' ? fb.wifi_score : (fb.wifi_score ?? null),
            power: typeof fb.power === 'boolean' ? fb.power : (fb.power ?? null),
            noise_level: typeof fb.noise_level === 'number' ? fb.noise_level : (fb.noise_level ?? null),
            crowdness: typeof fb.crowdness === 'number' ? fb.crowdness : (fb.crowdness ?? null),
          };
        }
      }
    } catch (e) {
      console.error('feedback 조회 실패:', e);
    }

    // Google Places API 기반 타입 처리
    let placeTypes = [];
    let placeDisplayName = data.spaces?.name ?? null;
    if (data.spaces?.name === null && !isValidUuidV4(data.spaces?.id)) {
      try {
        const googleApiHeaders = {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
          "X-Goog-FieldMask": "displayName,types",
        };
        const placeRes = await fetch(
          `https://places.googleapis.com/v1/places/${data.spaces.id}?languageCode=ko&regionCode=kr`,
          { method: 'GET', headers: googleApiHeaders }
        );
        if (placeRes.ok) {
          const placeJson = await placeRes.json();
          placeDisplayName = placeJson?.displayName?.text ?? data.spaces.id;
          placeTypes = Array.isArray(placeJson?.types) ? placeJson.types : [];
        }
      } catch (apiErr) {
        console.error('Google Places API 호출 실패:', apiErr);
      }
    }
    if (!Array.isArray(placeTypes) || placeTypes.length === 0) {
      placeTypes = [];
    }
    // Google Place type 
    function mapGoogleTypeToKorean(type) {
      const mapping = {
        'cafe': '카페',
        'library': '도서관',
        'restaurant': '식당',
        'university': '대학교',
        'school': '학교',
        'book_store': '서점',
        'coworking_space': '코워킹스페이스',
        'coffee_shop': '카페',
        'study_area': '스터디룸',
        'internet_cafe': 'PC방',
        'bar': '술집',
        'bakery': '베이커리',
        'fast_food_restaurant': '패스트푸드',
        'convenience_store': '편의점',
        'park': '공원',
        'museum': '박물관',
        'church': '교회',
        'amusement_park': '놀이공원',
        'movie_theater': '영화관',
        'train_station': '기차역',
        'bus_station': '버스터미널',
        'shopping_mall': '쇼핑몰',
      };
      if (!type) return null;
      const lower = type.toLowerCase();
      if (mapping[lower]) return mapping[lower];
      if (lower.endsWith('_cafe')) return '카페';
      if (lower.endsWith('_library')) return '도서관';
      return null;
    }
    let primaryType = null;
    for (const t of placeTypes) {
      const mapped = mapGoogleTypeToKorean(t);
      if (mapped) {
        primaryType = mapped;
        break;
      }
    }

    const recMoods = Array.isArray(data.record_moods) ? data.record_moods : [];
    const moodList = [
      ...new Set(
        recMoods
          .map((m) =>
            (m && m.mood_tags && typeof m.mood_tags.mood_id === 'string'
              ? m.mood_tags.mood_id.replace(/\r?\n/g, '').trim()
              : '')
          )
          .filter(Boolean)
      ),
    ];

    let imageUrl = null;
    try {
      let paths = Array.isArray(data.record_photos) ? data.record_photos.map(p => p?.path).filter(Boolean) : [];

      if (paths.length === 0) {
        const { data: photoRows, error: photoErr } = await supabaseAdmin
          .from('record_photos')
          .select('path')
          .eq('record_id', id)
          .order('created_at', { ascending: false })
          .limit(5);
        if (!photoErr && Array.isArray(photoRows)) {
          paths = photoRows.map(r => r.path).filter(Boolean);
        }
      }

      for (const p of paths) {
        imageUrl = await signStudyPhotoKeyMaybe(p, Number(process.env.STUDY_PHOTO_URL_TTL_SECONDS || 86400));
        if (imageUrl) break;
      }

      if (!imageUrl) {
        const { url: moodUrl } = await photoTools.getMoodWallpaper(moodList || []);
        if (moodUrl) {
          imageUrl = moodUrl;
        }
      }
    } catch (e) {
      console.error('이미지 URL 생성 실패:', e);
    }

    if (data.spaces?.name === null && !isValidUuidV4(data.spaces?.id)) {
      try {
        const googleApiHeaders = {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
          "X-Goog-FieldMask": "displayName",
        };
        const placeRes = await fetch(
          `https://places.googleapis.com/v1/places/${data.spaces.id}?languageCode=ko&regionCode=kr`,
          { method: 'GET', headers: googleApiHeaders }
        );
        if (placeRes.ok) {
          const placeJson = await placeRes.json();
          data.spaces.name = placeJson?.displayName?.text ?? data.spaces.id;
        }
      } catch (apiErr) {
        console.error('Google Places API 호출 실패:', apiErr);
      }
    }


    const recordCard = {
      id: data.id,
      date: dateStr,
      // 총 시간: 시작~종료 전체 경과
      total_time: toHHMMSS(totalSec),
      // 순 공부 시간: 일시정지 제외(= DB duration)
      net_time: netTime,
      title: data.title ?? null,
      image_url: imageUrl,
      goals,
      emotions,
      space: {
        id: data.spaces?.id ?? data.space_id ?? null,
        name: placeDisplayName ?? data.spaces?.name ?? null,
        type: primaryType,
        mood: moodList,
        tags: feedbackFields
      }
    };

    return res.status(200).json({
      message: "레코드 조회에 성공했습니다.",
      record: recordCard
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "서버 오류" });
  }
});

// record 수정
router.put("/records/:id", async (req, res) => {
    const { id } = req.params;
    const { space_id, duration, start_time, end_time, is_public, tags } = req.body; 

    try {
        // 먼저 레코드가 존재하는지 확인
        const { data: existingRecord, error: checkError } = await supabase
            .from("study_record")
            .select()
            .eq("id", id)
            .setHeader('Authorization', req.headers.authorization)

        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }

        // 레코드 업데이트를 위한 데이터
        const updateData = {};
        if (space_id) updateData.space_id = space_id;
        if (start_time) updateData.start_time = start_time;
        if (end_time) updateData.end_time = end_time;
        if (duration != null) updateData.duration = duration;
        if (is_public != null) updateData.is_public = is_public;

        if (tags !== undefined) {
            const { error: deleteTagsError } = await supabaseAdmin
                .from("record_tags")
                .delete()
                .eq("record_id", id);

            if (deleteTagsError) {
                return res.status(500).json({ error: "기존 태그 삭제 실패", details: deleteTagsError.message });
            }

            if (Array.isArray(tags) && tags.length > 0) {
                const tagRelations = tags.map(tagId => ({
                    record_id: id,
                    tag_id: tagId
                }));

                const { error: insertTagsError } = await supabaseAdmin
                    .from("record_tags")
                    .insert(tagRelations);

                if (insertTagsError) {
                    return res.status(500).json({ error: "새 태그 추가 실패", details: insertTagsError.message });
                }
            }
        }

        // 업데이트할 필드가 있는 경우에만 레코드 업데이트
        let updatedRecord = existingRecord;
        if (Object.keys(updateData).length > 0) {
            const { data: updateResult, error: updateError } = await supabaseAdmin
                .from("study_record")
                .update(updateData)
                .eq("id", id)
                .select()
                .setHeader('Authorization', req.headers.authorization)
            
            if (updateError) {
                return res.status(500).json({ error: "레코드 수정 실패.", details: updateError.message });
            }
            updatedRecord = updateResult;
        }

        // 최종 응답에 태그 정보 포함
        const tagsMap = await getTagsForRecords([id], req.headers.authorization);
        const recordWithTags = {
            ...updatedRecord[0],
            tags: tagsMap[id] || []
        };

        return res.status(200).json({ message: "레코드 수정 완료.", record: recordWithTags });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "서버 오류 "});
    }
});
        
// record 삭제
router.delete("/records/:id", async (req, res) => {
    const { id } = req.params;

    try {
        // 기존 레코드 확인
        const { data: existingRecord, error: checkError } = await supabase
            .from("study_record")
            .select()
            .eq("id", id)
            .setHeader('Authorization', req.headers.authorization)
            
        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }
        
        // 먼저 관련된 태그 관계 삭제
        const { error: deleteTagsError } = await supabaseAdmin
            .from("record_tags")
            .delete()
            .eq("record_id", id);

        if (deleteTagsError) {
            console.error("태그 관계 삭제 오류:", deleteTagsError);
        }
        
        // 레코드 삭제
        const { error: deleteError } = await supabaseAdmin
            .from("study_record")
            .delete()
            .eq("id", id)

        if (deleteError) {
            return res.status(500).json({ error: "레코드 삭제에 실패했습니다.", details: deleteError.message });
        }

        res.status(200).json({ message: "레코드가 성공적으로 삭제되었습니다." });

    } catch (error) {
        console.error("레코드 삭제 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

export default router;