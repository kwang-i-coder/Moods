import express from 'express'
import supabase from '../lib/supabaseClient.js'
import redisClient from '../lib/redisClient.js'
import verifySupabaseJWT from '../lib/verifyJWT.js'
import { v4 as uuidv4 } from "uuid";

const router = express.Router()

// 공부 세션 시작 (제목, 공간, 오늘 할일 추가)
router.post('/start', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/start')

    // 요청 바디에서 title, goals(체크리스트) 받기
    const {title, goals = [], space_id} = req.body;

    if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({error: "제목은 필수입니다."});
    }

    // goals 정규화
    const normalizeGoals = (arr) => {
        if (!Array.isArray(arr)) return [];
        return arr.slice(0, 10).map((g) => {
            if (typeof g === 'string') {
                return {text: g.trim(), done: false};
            }
            const text = typeof g?.text === 'string' ? g.text.trim() : '';
            const done = typeof g?.done === 'boolean' ? g.done : false;
            return {text, done};
        }).filter(g => g.text.length > 0);
    };
    const goalsNorm = normalizeGoals(goals);

    if(!space_id || typeof space_id != 'string'){
        return res.status(400).send('space_id가 누락됐습니다.')
    }

    // 공부 시작시간은 서버 시각으로 정한 후 클라이언트에게 응답으로 줌
    const start_time = new Date().toISOString();
    // 해당 유저의 세션이 저장되는 redis id
    const redis_key = `sessions:${req.user.sub}`
    // redis_key에 해당하는 세션 데이터
    const session = await redisClient.hGetAll(redis_key);

    // 세션이 이미 존재한다면 다중 세션 시도로 감지하고 에러 반환
    if (Object.keys(session).length !== 0) {
        console.log(`다중 세션 시도: ${redis_key}`)
        return res.status(400).send('이미 세션이 존재합니다.');
    }
    
    // 레디스에 입력
    await redisClient.hSet(redis_key, {
        user_id: req.user.sub,
        title:title.trim(),
        space_id: space_id,
        start_time: start_time,
        status: 'active',
        accumulatedPauseSeconds: '0',
        goals: JSON.stringify(goalsNorm)
    });
    console.log(`세션 등록 완료: ${await redisClient.hGet(redis_key, 'user_id')}`)
    return res.status(200).json({
        success: true,
        start_time,
        session: {title: title.trim(), space_id: space_id, goals: goalsNorm}
    });
});

// 목표 완료 토글
router.patch('/goals/:index', verifySupabaseJWT, async (req, res) => {
    const idx = Number(req.params.index);
    const {done} = req.body;
    const key = `sessions:${req.user.sub}`;
    const sess = await redisClient.hGetAll(key);

    if (Object.keys(sess).length === 0) {
        return res.status(400).json({error: '세션이 없습니다.'});
    }

    const goals = (() => { try { return JSON.parse(sess.goals || '[]'); } catch { return []; } })();
    if (!Number.isInteger(idx) || idx < 0 || idx >= goals.length) {
        return res.status(400).json({ error: '잘못된 index' });
    }
    goals[idx].done = !!done;                                  

    await redisClient.hSet(key, { goals: JSON.stringify(goals) });
    res.json({ success: true, goals });
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

router.post('/session-to-record', verifySupabaseJWT, async (req, res) => {
    const {is_public=false, tags = []} = req.body;
    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);

    //goals
    const goals = (() => {
        try {
            return JSON.parse(session.goals || '[]');
        } catch { return []; }
    })();

    if(Object.keys(session).length === 0){
        console.log(`세션이 존재하지 않음: ${redis_key}`);
        return res.status(400).send('세션 없음');
    };

    if(session.status !== "finished"){
        console.log(`세션이 종료되지 않음: ${redis_key}`);
        return res.status(400).send('종료되지 않은 세션');
    }

    const start_time = new Date(session.start_time);
    const end_time = new Date(session.end_time);
    const duration = Number(session.duration);
    const data = {
        user_id: req.user.sub,
        space_id: session.space_id,
        duration,
        start_time: start_time.toISOString(),
        end_time: end_time.toISOString(),
        is_public,
        title: session.title || null,
        goals
    };
    
    const {data:record_data, error: record_error} = await supabase.from('study_record').insert(data).setHeader('Authorization', req.headers.authorization).select();
    if(record_error){
        console.log(record_error.message);
        return res.status(500).send(record_error.message);
    }
    
    if(tags.length > 0){
        const {data: existing_tags, error} = await supabase
        .from('tags')
        .select('*')
        .in('tag', tags)
        .setHeader('Authorization', req.headers.authorization);

        if (error) {
            return res.status(500).send('supabase select error');
        };

        const tag_hash = {}
        for(const existing_tag of existing_tags){
            tag_hash[existing_tag.tag] = existing_tag.id;
        }
        
        if(error){
            res.status(500).send('supabase select error');
        };
        var tag_table = [];

        for(const tag of tags){
            tag_table.push({
                id: tag_hash[tag]||uuidv4(),
                tag: tag
            });
        }

        const {error:upsert_error} = await supabase.from('tags').upsert(tag_table).setHeader('Authorization', req.headers.authorization);

        if(upsert_error){
            console.log(upsert_error.message);
            return res.status(500).send(`upsert error`);
        }
        
        var data_for_recordtag = [];
        for(const tag of tag_table){
            data_for_recordtag.push({record_id: record_data[0].id, tag_id: tag.id})
        }
        const {error:recordtag_error} = await supabase.from('record_tag').insert(data_for_recordtag).setHeader('Authorization', req.headers.authorization);
        if(recordtag_error){
            console.log(recordtag_error.message);
            return res.status(500).send(`record_tag table error: ${recordtag_error.message}`);
        }
    }

    await redisClient.del(redis_key);
    return res.status(200).json({success: true, data: data});
})


// 공부 시간 계산 함수
function calculate_duration(start_time, end_time, accumulatedPauseSeconds) {
    const end = new Date(end_time);
    const start = new Date(start_time);
    const duration = ((end.getTime() - start.getTime()) / 1000) - accumulatedPauseSeconds;
    return duration;
}

export default router;