import express from 'express'
import supabase from '../lib/supabaseClient.js'
import redisClient from '../lib/redisClient.js'
import verifySupabaseJWT from '../lib/verifyJWT.js'
import { v4 as uuidv4 } from "uuid";



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


// 공부 세션 시작 (오늘 할일 + mood만 추가)
router.post('/start', verifySupabaseJWT, async (req, res) => {
  console.log('[라우트 호출] /study-sessions/start')

  const {
    goals = [],
    mood_id = [], 
  } = req.body;

  if (!Array.isArray(mood_id)) {
    return res.status(400).json({ error: 'mood_id는 배열이어야 합니다.' });
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

  // 세션 검증
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
    mood_id: JSON.stringify(mood_id),
    record_id: uuidv4()
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

// 무드 수정
router.patch('/mood', verifySupabaseJWT, async (req, res) => {
    const {mood_id=[]} = req.body;
    const redis_key = `sessions:${req.user.sub}`;
    const sess = await redisClient.hGetAll(redis_key);
    // 세션 존재 여부 확인
    if (Object.keys(sess).length === 0) {
      return res.status(400).json({ error: '세션이 없습니다.' });
    } 
    try {
        // 세션 상태에 무드 업데이트
        await redisClient.hSet(redis_key, { mood_id: JSON.stringify(mood_id) });

    } catch (error) {
        console.error('무드 수정 중 오류', error);
        return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
    res.status(200).json({
        success: true,
        mood_id: mood_id
    });
})
    
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
        duration: duration,
    });

    console.log(`세션 종료됨: ${redis_key}`);
    return res.status(200).json({success: true, end_time: stopped_at.toISOString(), duration: duration, record_id: session.record_id});
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
  console.log('[라우트 호출] /study-sessions/session-to-record')
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
  // mood_id 파싱
  const mood_id = (() => { try { return JSON.parse(session.mood_id || '[]'); } catch { return []; } })();

  // 시간/지속
  const start_time = new Date(session.start_time);
  const end_time = new Date(session.end_time);
  const duration = Number(session.duration);

  // db에 없는 공간에서 공부한 경우(공간에서 최초로 공부한 경우)를 대비하여 upsert 진행
  try {
    const {error: spaceErr} = await supabase
      .from('spaces')
      .upsert({
        id: space_id,
      })
      .setHeader('Authorization', req.headers.authorization);
    if(spaceErr) {
      console.error('spaces upsert 실패:', spaceErr);
      return res.status(500).json({ error: `spaces upsert 실패: ${spaceErr.message}` });
    }
  } catch (error) {
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }

  // study record 저장
  const toInsert = {
    id: session.record_id,
    user_id: req.user.sub,
    space_id: space_id || null,
    title: title ?? null,
    duration,
    start_time: start_time.toISOString(),
    end_time: end_time.toISOString(),
    goals,
    feedback_id: null // placeholder to be updated later
  };

  const { error: recordErr } = await supabase
    .from('study_record')
    .upsert(toInsert)
    .setHeader('Authorization', req.headers.authorization);

  if (recordErr) return res.status(500).json({ error: `study_record insert 실패: ${recordErr.message}` });

  const recordId = session.record_id;

  // feedback 저장
  const {data:exist_feedback, error:exist_err} = await supabase.from('feedback').select('*').eq('user_id', req.user.sub).eq('space_id', space_id).setHeader('Authorization', req.headers.authorization);
  if(exist_err) return res.status(500).json({ error: `feedback select 실패: ${exist_err.message}` });

  if(exist_feedback && exist_feedback.length > 0){
    // 기존 피드백이 있는 경우
    var { data: feedbackRows, error: feedbackErr } = await supabase
    .from('feedback')
    .update({
      user_id: req.user.sub,
      space_id: space_id || null,
      wifi_score: wifi_score ?? null,
      noise_level: noise_level ?? null,
      crowdness: crowdness ?? null,
      power: (power === null || power === undefined) ? null : !!power
    })
    .select()
    .eq('user_id', req.user.sub)
    .eq('space_id', space_id)
    .setHeader('Authorization', req.headers.authorization);
    console.log('기존 피드백:', exist_feedback);
  }else{
    // 기존 피드백이 없는 경우
    var { data: feedbackRows, error: feedbackErr } = await supabase
    .from('feedback')
    .insert({
      user_id: req.user.sub,
      space_id: space_id || null,
      wifi_score: wifi_score ?? null,
      noise_level: noise_level ?? null,
      crowdness: crowdness ?? null,
      power: (power === null || power === undefined) ? null : !!power
    })
    .select()
    .setHeader('Authorization', req.headers.authorization);
    console.log('기존 피드백 없음');
  }

  

  if (feedbackErr) {
    await supabase.from('study_record').delete().eq('id', recordId).setHeader('Authorization', req.headers.authorization);
    return res.status(500).json({ error: `feedback insert 실패: ${feedbackErr.message}` });
  }

  const feedbackId = feedbackRows[0]?.id;

  // study_record 업데이트 (feedback_id)
  const { error: updateErr } = await supabase
    .from('study_record')
    .update({ feedback_id: feedbackId })
    .eq('id', recordId)
    .setHeader('Authorization', req.headers.authorization);

  if (updateErr) {
    await supabase.from('study_record').delete().eq('id', recordId).setHeader('Authorization', req.headers.authorization);
    await supabase.from('feedback').delete().eq('id', feedbackId).setHeader('Authorization', req.headers.authorization);
    return res.status(500).json({ error: `feedback_id update 실패: ${updateErr.message}` });
  }

  var emotion_names = emotion_tag_ids.map(s => String(s).trim()).filter(Boolean);

  const emotion_ids = [];

  const {data:emotions, error:emotionsError} = await supabase.from('emotions').select('*').setHeader('Authorization', req.headers.authorization);
  if(emotionsError) return [];

  var emotion_to_id = Object.fromEntries(emotions.map(emotion => [emotion.name.trim(), emotion.id]));

  // 없는 태그는 삽입
  emotion_names.forEach(async name => {
    if(emotion_to_id[name] === undefined){
      const new_id = uuidv4();
      const {error:insertErr} = await supabase.from('emotions').insert({id:new_id, name:name}).setHeader('Authorization', req.headers.authorization);
      if(!insertErr){
        emotion_to_id[name] = new_id;
        console.log(`새 감정 태그 삽입 (${name}, ${new_id})`);
      }else{
        console.error(`감정 태그 삽입 실패 (${name}):`, insertErr);
      }
    }
  });

  // id로 변환
  emotion_names.forEach(name => {
    if(emotion_to_id[name]){
      emotion_ids.push(emotion_to_id[name]);
    }
  });

  // Record-emotions 저장
  if (emotion_ids.length) {
    const rows = emotion_ids.map(id => ({
      record_id: recordId,
      emotion_id: id
    }));
    console.log('record_emotions에 삽입할 행:', rows);
    
    const { error: reErr } = await supabase
      .from('record_emotions')
      .insert(rows)
      .setHeader('Authorization', req.headers.authorization);
    if (reErr) {
      await supabase.from('study_record').delete().eq('id', recordId).setHeader('Authorization', req.headers.authorization);
      await supabase.from('feedback').delete().eq('id', feedbackId).setHeader('Authorization', req.headers.authorization);
      return res.status(500).json({ error: `record_emotions insert 실패: ${reErr.message}` });
    }
  }
  const {error:mood_tags_error, data:mood_tags_data} = await supabase.from('mood_tags').select('*').setHeader('Authorization', req.headers.authorization);
  if(mood_tags_error){
    await supabase.from('study_record').delete().eq('id', recordId).setHeader('Authorization', req.headers.authorization);
    await supabase.from('feedback').delete().eq('id', feedbackId).setHeader('Authorization', req.headers.authorization);
    return res.status(500).json({ error: `mood_tags select 실패: ${mood_tags_error.message}` });
  }
  console.log('mood_tags_data:', mood_tags_data);
  const mood_to_id = Object.fromEntries(mood_tags_data.map(tag => [tag.mood_id.trim(), tag.id]));

  const to_insert_mood = mood_id.map(tag_id => ({
    record_id: recordId,
    mood_tag_id: mood_to_id[tag_id.trim()]
  }))
  console.log('to_insert_mood:', to_insert_mood);
  const { error: moodErr } = await supabase.from('study_record_mood_tags').insert(to_insert_mood).setHeader('Authorization', req.headers.authorization);

  if (moodErr) {
    await supabase.from('study_record').delete().eq('id', recordId).setHeader('Authorization', req.headers.authorization);
    await supabase.from('feedback').delete().eq('id', feedbackId).setHeader('Authorization', req.headers.authorization);
    return res.status(500).json({ error: `study_record_mood_tags insert 실패: ${moodErr.message}` });
  }

  // 세션 제거
  await redisClient.del(redis_key);

  // 응답
  return res.status(200).json({
    success: true,
    data: {
      ...toInsert,
      feedback_id: feedbackId,
      emotion_tag_ids: emotion_names,
      mood_id
    }
  });
});

export default router;