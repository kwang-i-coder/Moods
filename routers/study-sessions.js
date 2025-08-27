import express from 'express'
import supabase from '../lib/supabaseClient.js'
import redisClient from '../lib/redisClient.js'
import verifySupabaseJWT from '../lib/verifyJWT.js'



const router = express.Router()

// 공부 시간 계산 헬퍼 (초 단위, 일시정지 누적 반영)
function calculate_duration(start_time, end_time, accumulatedPauseSeconds = 0) {
  const startMs = new Date(start_time).getTime();
  const endMs = new Date(end_time).getTime();
  const paused = Number(accumulatedPauseSeconds || 0);
  const seconds = (endMs - startMs) / 1000 - paused;
  // 음수 방지
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

async function resolveMoodId(input) { 
  try { 
    const raw = (typeof input === 'string' ? input.trim() : ''); 
    if (!raw) return null; 
    let { data: direct, error: directErr } = await supabase
      .from('mood_tags')
      .select('id')
      .eq('id', raw)
      .limit(1); 
    if (!directErr && Array.isArray(direct) && direct.length > 0) { 
      return direct[0].id; 
    }
    try { 
      let { data: byName, error: nameErr } = await supabase
        .from('mood_tags')
        .select('id')
        .eq('name', raw)
        .limit(1); 
      if (!nameErr && Array.isArray(byName) && byName.length > 0) { 
        return byName[0].id; 
      }
    } catch (_) {} 
    try { 
      let { data: byLabel, error: labelErr } = await supabase
        .from('mood_tags')
        .select('id')
        .eq('label', raw)
        .limit(1); 
      if (!labelErr && Array.isArray(byLabel) && byLabel.length > 0) { 
        return byLabel[0].id; 
      }
    } catch (_) {} 
    // 못 찾으면 null 반환
    return null; 
  } catch (e) { 
    console.warn('[resolveMoodId] 실패:', e?.message); 
    return null; 
  } 
}

// 감정 태그 라벨/UUID → tags.id(UUID) 정규화 헬퍼
async function resolveTagIds(rawInputs, authHeader) {
  const isUuid = (s) =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

  const inputs = Array.isArray(rawInputs)
    ? [...new Set(rawInputs.map((s) => String(s).trim()).filter(Boolean))]
    : [];

  if (inputs.length === 0) return { resolvedIds: [], notFound: [] };

  const uuidCandidates = inputs.filter(isUuid);
  const labelCandidates = inputs.filter((v) => !isUuid(v));

  // 1) UUID 후보 중 실제로 존재하는 id만 유지
  let resolvedIds = [];
  if (uuidCandidates.length) {
    try {
      const { data: idRows, error: idErr } = await supabase
        .from('tags')
        .select('id')
        .in('id', uuidCandidates)
        .setHeader('Authorization', authHeader);
      if (!idErr && Array.isArray(idRows)) {
        resolvedIds.push(...idRows.map((r) => r.id));
      }
    } catch (_) {}
  }

  // 2) 라벨 후보를 다양한 컬럼으로 탐색: name → label → tag → title → text
  const labelCols = ['name', 'label', 'tag', 'title', 'text'];
  let foundLabelSet = new Set();

  for (const col of labelCols) {
    if (!labelCandidates.length) break;
    try {
      const { data: rows, error: qErr } = await supabase
        .from('tags')
        .select(`id, ${col}`)
        .in(col, labelCandidates)
        .setHeader('Authorization', authHeader);
      if (qErr || !Array.isArray(rows) || rows.length === 0) continue;
      // 매칭된 것 기록
      rows.forEach((r) => {
        if (r?.id) resolvedIds.push(r.id);
        const val = r?.[col];
        if (typeof val === 'string') foundLabelSet.add(val);
      });
    } catch (_) {
      // 해당 컬럼이 없어서 실패하면 다음 컬럼으로 시도
      continue;
    }
  }

  // 중복 제거
  resolvedIds = [...new Set(resolvedIds)];
  const notFound = labelCandidates.filter((lbl) => !foundLabelSet.has(lbl));

  return { resolvedIds, notFound };
}

// 감정 텍스트 or UUID → emotions.id 정규화
async function resolveEmotionIds(rawInputs, authHeader) {
  const isUuid = (s) =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

  const inputs = Array.isArray(rawInputs)
    ? [...new Set(rawInputs.map((s) => String(s).trim()).filter(Boolean))]
    : [];

  if (inputs.length === 0) return { resolvedIds: [], notFound: [] };

  const uuidCandidates = inputs.filter(isUuid);
  const labelCandidates = inputs.filter((v) => !isUuid(v));

  let resolvedIds = [];
  if (uuidCandidates.length) {
    try {
      const { data: idRows, error: idErr } = await supabase
        .from('emotions')
        .select('id')
        .in('id', uuidCandidates)
        .setHeader('Authorization', authHeader);
      if (!idErr && Array.isArray(idRows)) {
        resolvedIds.push(...idRows.map((r) => r.id));
      }
    } catch (_) {}
  }

  const labelCols = ['name', 'label', 'text'];
  let foundLabelSet = new Set();

  for (const col of labelCols) {
    if (!labelCandidates.length) break;
    try {
      const { data: rows, error: qErr } = await supabase
        .from('emotions')
        .select(`id, ${col}`)
        .in(col, labelCandidates)
        .setHeader('Authorization', authHeader);
      if (qErr || !Array.isArray(rows)) continue;
      rows.forEach((r) => {
        if (r?.id) resolvedIds.push(r.id);
        const val = r?.[col];
        if (typeof val === 'string') foundLabelSet.add(val);
      });
    } catch (_) {
      continue;
    }
  }

  resolvedIds = [...new Set(resolvedIds)];

  // notFound 계산 방식 순서 조정 및 정확성 개선
  const inputSet = new Set(inputs.filter(v => !isUuid(v)));
  const foundSet = new Set(foundLabelSet);
  const notFound = Array.from(inputSet).filter(lbl => !foundSet.has(lbl));

  return { resolvedIds, notFound };
}

// 공부 세션 시작 (오늘 할일 + mood만 추가)
router.post('/start', verifySupabaseJWT, async (req, res) => {
  console.log('[라우트 호출] /study-sessions/start')

  const {
    goals = [],
    mood_id = null, 
  } = req.body;

  if (mood_id !== null && typeof mood_id !== 'string') {
    return res.status(400).json({ error: 'mood_id는 문자열(id)이어야 합니다.' });
  }

  // goals 정규화 (최대 10개)
  const normalizeGoals = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 10).map((g) => {
      if (typeof g === 'string') return { text: g.trim(), done: false };
      const text = typeof g?.text === 'string' ? g.text.trim() : '';
      const done = typeof g?.done === 'boolean' ? g.done : false;
      return { text, done };
    }).filter(g => g.text.length > 0);
  };
  const goalsNorm = normalizeGoals(goals);

  const start_time = new Date().toISOString();
  const redis_key = `sessions:${req.user.sub}`;
  const session = await redisClient.hGetAll(redis_key);
  if (Object.keys(session).length !== 0) {
    return res.status(400).send('이미 세션이 존재합니다.');
  }

  await redisClient.hSet(redis_key, {
    user_id: req.user.sub,
    start_time,
    status: 'active',
    accumulatedPauseSeconds: '0',
    goals: JSON.stringify(goalsNorm),
    mood_id: mood_id || ''   
  });

  return res.status(200).json({
    success: true,
    start_time,
    session: {
      goals: goalsNorm,
      mood_id
    }
  });
});

// 목표 완료 토글
router.patch('/goals/:index', verifySupabaseJWT, async (req, res) => {
    try {
        const idx = Number(req.params.index);
        const {done} = req.body;
        const key = `sessions:${req.user.sub}`;
        const sess = await redisClient.hGetAll(key);

        // 세션 존재 여부 확인
        if (Object.keys(sess).length === 0) {
            return res.status(400).json({error: '세션이 없습니다.'});
        }

        // 세션 상태 확인
        if (sess.status === 'finished') {
            return res.status(400).json({ error: '완료된 세션의 목표는 수정할 수 없습니다. '});
        }

        // 목표 파싱
        const goals = (() => {
            try {
                return JSON.parse(sess.goals || '[]');
            } catch {
                return [];
            }
        })();

        // 인덱스 유효성 검사
        if (!Number.isInteger(idx) || idx < 0 || idx >= goals.length) {
            return res.status(400).json({ error: '잘못된 index입니다.' });
        }

        // done 값 유효성 검사
        if (typeof done !== 'boolean') {
            return res.status(400).json({ error: 'done 값은 boolean이어야 합니다.' });
        }

        // 목표 상태 업데이트
        goals[idx].done = done;


        await redisClient.hSet(key, { goals: JSON.stringify(goals) });
        
        console.log(`목표 ${idx} 상태 변경: ${done} (사용자: ${req.user.sub})`);

        res.json({
            success: true,
            goals,
            updated_goal: {
                index: idx,
                text: goals[idx].text,
                done: goals[idx].done
            }
        });
    } catch (error) {
        console.error('목표 토글 중 오류', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 목표 추가
router.post('/goals', verifySupabaseJWT, async (req, res) => {
  try {
    const { text, done = false } = (req.body ?? {}); 
    const key = `sessions:${req.user.sub}`;
    const sess = await redisClient.hGetAll(key);

    // 세션 존재 여부 확인
    if (Object.keys(sess).length === 0) {
      return res.status(400).json({ error: '세션이 없습니다.' });
    }
    // 완료된 세션은 수정 불가
    if (sess.status === 'finished') {
      return res.status(400).json({ error: '완료된 세션의 목표는 추가할 수 없습니다.' });
    }

    // 기존 목표 파싱
    const goals = (() => { try { return JSON.parse(sess.goals || '[]'); } catch { return []; } })();

    // 유효성 검사
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text는 필수이며 문자열이어야 합니다.' });
    }
    if (goals.length >= 10) {
      return res.status(400).json({ error: '목표는 최대 10개까지 가능합니다.' });
    }

    const normalized = { text: text.trim(), done: !!done };
    goals.push(normalized);

    await redisClient.hSet(key, { goals: JSON.stringify(goals) });

    return res.status(201).json({
      success: true,
      goals,
      added_goal: normalized,
      index: goals.length - 1
    });
  } catch (error) {
    console.error('목표 추가 중 오류', error);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 목표 제거
router.delete('/goals/:index', verifySupabaseJWT, async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const key = `sessions:${req.user.sub}`;
    const sess = await redisClient.hGetAll(key);

    // 세션 존재 여부 확인
    if (Object.keys(sess).length === 0) {
      return res.status(400).json({ error: '세션이 없습니다.' });
    }
    // 완료된 세션은 수정 불가
    if (sess.status === 'finished') {
      return res.status(400).json({ error: '완료된 세션의 목표는 삭제할 수 없습니다.' });
    }

    // 기존 목표 파싱
    const goals = (() => { try { return JSON.parse(sess.goals || '[]'); } catch { return []; } })();

    // 인덱스 유효성 검사
    if (!Number.isInteger(idx) || idx < 0 || idx >= goals.length) {
      return res.status(400).json({ error: '잘못된 index입니다.' });
    }

    const removed = goals.splice(idx, 1)[0];

    await redisClient.hSet(key, { goals: JSON.stringify(goals) });

    return res.json({
      success: true,
      goals,
      removed_goal: { index: idx, ...removed }
    });
  } catch (error) {
    console.error('목표 제거 중 오류', error);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});
    
// 공부 세션 일시 정지
router.get('/pause', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/pause')

    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);

    if (Object.keys(session).length === 0) {
        console.log(`세션 시작 안 함: ${redis_key}`);
        return res.status(400).send('세션이 없습니다.');
    };

    if(session.status !== 'active'){
        console.log(`중지 혹은 종료된 세션: ${redis_key}`);
        return res.status(400).send(`session is ${session.status}`);
    }

    const last_paused_at = new Date().toISOString();
    const accumulatedPauseSeconds =  Number(session.accumulatedPauseSeconds||0)
    const duration = calculate_duration(session.start_time, last_paused_at, accumulatedPauseSeconds);
    await redisClient.hSet(redis_key, {
        last_paused_at: last_paused_at,
        status: 'paused',
        duration: duration
    });
    console.log(`일시 정지 성공: ${redis_key}`);
    return res.status(200).json({
        success: true, 
        last_paused_at: last_paused_at, 
        accumulatedPauseSeconds: accumulatedPauseSeconds,
        duration: duration
    });
})

// 공부 세션 재개
router.get('/resume', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/resume')

    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);


    if (Object.keys(session).length === 0) {
        console.log(`세션 시작 안 함: ${redis_key}`);
        return res.status(400).send('세션이 없습니다.');
    }

    if (session.status !== 'paused') {
        console.log(`일시정지 상태가 아님: ${redis_key}`);
        return res.status(400).send(`session is ${session.status}`);
    }

    const last_paused_at = new Date(session.last_paused_at);
    const resume_at = new Date();
    const accumulatedPauseSeconds = Number(session.accumulatedPauseSeconds || 0) + ((resume_at.getTime() - last_paused_at.getTime()) / 1000);
    const duration = calculate_duration(session.start_time, resume_at.toISOString(), accumulatedPauseSeconds);

    await redisClient.hSet(redis_key, {
        status: 'active',
        accumulatedPauseSeconds: accumulatedPauseSeconds,
        duration: duration
    });

    res.status(200).json({
        success: true,
        resume_at: resume_at.toISOString(),
        accumulatedPauseSeconds: accumulatedPauseSeconds,
        duration
    });
});

// 공부 세션 종료
router.get('/finish', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/finish')

    const redis_key = `sessions:${req.user.sub}`;
    var session = await redisClient.hGetAll(redis_key);

    // 세션을 시작도 안했을 경우
    if (Object.keys(session).length === 0) {
        console.log(`세션 시작 안 함: ${redis_key}`);
        return res.status(400).send('세션이 없습니다.');
    };

    // 이미 끝난 세션일 경우
    if(session.status === 'finished'){
        console.log(`종료된 세션에 대한 접근: ${redis_key}`);
        return res.status(400).send('이미 세션이 종료됨');
    };

    const stopped_at = new Date();

    // 일시정지된 세션에서 바로 종료하는 경우
    if(session.status === 'paused'){
        const last_paused_at = new Date(session.last_paused_at);
        const accumulatedPauseSeconds = Number(session.accumulatedPauseSeconds||0) + ((stopped_at.getTime() - last_paused_at.getTime())/1000);
        await redisClient.hSet(redis_key, {accumulatedPauseSeconds: accumulatedPauseSeconds});
        session = await redisClient.hGetAll(redis_key);
        console.log(`일시정지 상태에서 바로 종료: ${redis_key}`);
    };
    // 공부시간 계산
    const duration = calculate_duration(session.start_time, stopped_at.toISOString(), Number(session.accumulatedPauseSeconds));

    await redisClient.hSet(redis_key, {
        status: 'finished',
        end_time: stopped_at.toISOString(),
        duration: duration
    });

    console.log(`세션 종료됨: ${redis_key}`);
    return res.status(200).json({success: true, end_time: stopped_at.toISOString(), duration: duration});
});

router.get('/user-session', verifySupabaseJWT, async (req, res) => {
    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);

    return res.status(200).json({success: true, data: session});
});

router.get('/quit', verifySupabaseJWT, async (req, res) => {
    const redis_key = `sessions:${req.user.sub}`;
    await redisClient.del(redis_key);
    res.status(200).json({success:true})
});

// 세션 → 기록 저장
router.post('/session-to-record', verifySupabaseJWT, async (req, res) => {
  const {
    title = null,               // 선택
    emotion_tag_ids = [],       // 라벨 or UUID 문자열 배열
    wifi_score = null,          // 1~5 or null
    noise_level = null,         // 1~5 or null
    crowdness = null,           // 1~5 or null
    power = null,               // boolean or null
    space_id = null             // 선택
  } = req.body;

  // ─────────────────────────────────────────────────────────────
  // 유틸
  const isValidScore = (v) => Number.isInteger(v) && v >= 1 && v <= 5;

  // ─────────────────────────────────────────────────────────────
  // 기본 유효성
  if (title !== null && typeof title !== 'string') {
    return res.status(400).json({ error: 'title은 문자열이어야 합니다.' });
  }
  if (!Array.isArray(emotion_tag_ids) || !emotion_tag_ids.every(v => typeof v === 'string')) {
    return res.status(400).json({ error: 'emotion_tag_ids는 문자열 배열이어야 합니다.' });
  }
  for (const [k, v] of Object.entries({ wifi_score, noise_level, crowdness })) {
    if (v !== null && v !== undefined && (typeof v !== 'number' || !isValidScore(v))) {
      return res.status(400).json({ error: `${k}는 1~5 사이의 정수여야 합니다.` });
    }
  }
  if (power !== null && power !== undefined && typeof power !== 'boolean') {
    return res.status(400).json({ error: 'power는 boolean이어야 합니다.' });
  }
  if (space_id !== null && space_id !== undefined && (typeof space_id !== 'string' || !space_id.trim())) {
    return res.status(400).json({ error: 'space_id는 문자열이어야 합니다.' });
  }
  const redis_key = `sessions:${req.user.sub}`;
  const session = await redisClient.hGetAll(redis_key);
  if (Object.keys(session).length === 0) return res.status(400).send('세션 없음');
  if (session.status !== 'finished') return res.status(400).send('종료되지 않은 세션');

  // goals 파싱
  const goals = (() => { try { return JSON.parse(session.goals || '[]'); } catch { return []; } })();

  // 시간/지속
  const start_time = new Date(session.start_time);
  const end_time = new Date(session.end_time);
  const duration = Number(session.duration);

  const { resolvedIds, notFound, labelCandidates } = await (async () => {
    const isUuid = (s) =>
      typeof s === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
    const inputs = Array.isArray(emotion_tag_ids)
      ? [...new Set(emotion_tag_ids.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    const uuidCandidates = inputs.filter(isUuid);
    const labelCandidates = inputs.filter((v) => !isUuid(v));
    const result = await resolveEmotionIds(emotion_tag_ids, req.headers.authorization);
    return { ...result, labelCandidates };
  })();

  // study record 저장
  const toInsert = {
    user_id: req.user.sub,
    space_id: space_id || null,
    title: title ?? null,
    duration,
    start_time: start_time.toISOString(),
    end_time: end_time.toISOString(),
    goals,
    wifi_score: wifi_score ?? null,
    noise_level: noise_level ?? null,
    crowdness: crowdness ?? null,
    power: (power === null || power === undefined) ? null : !!power
  };

  const { data: recordRows, error: recordErr } = await supabase
    .from('study_record')
    .insert(toInsert)
    .select()
    .setHeader('Authorization', req.headers.authorization);

  if (recordErr) return res.status(500).json({ error: `study_record insert 실패: ${recordErr.message}` });

  const recordId = recordRows[0].id;

  // Record-emotions 저장
  if (labelCandidates.length) {
    const rows = labelCandidates.map(name => ({
      record_id: recordId,
      tag_id: name.trim()
    }));
    const { error: reErr } = await supabase
      .from('record_emotions')
      .insert(rows)
      .setHeader('Authorization', req.headers.authorization);
    if (reErr) return res.status(500).json({ error: `record_emotions insert 실패: ${reErr.message}` });
  }

  // 세션 제거
  await redisClient.del(redis_key);

  // 응답
  return res.status(200).json({
    success: true,
    data: {
      ...toInsert,
      emotion_tag_ids: labelCandidates // name 기반
    }
  });
});

export default router;