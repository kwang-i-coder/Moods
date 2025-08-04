import express from 'express'
import supabase from '../lib/supabaseClient.js'
import redisClient from '../lib/redisClient.js'
import verifySupabaseJWT from '../lib/verifyJWT.js'

const router = express.Router()

// 공부 세션 시작
router.get('/start', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/start')

    // 최초 기록 시 공간 정보를 받아서 저장
    const {space_id} = req.query;
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

    // 공간 id가 누락된 경우
    if(!space_id){
        return res.status(400).send('space_id가 누락됐습니다.')
    }
    
    // 레디스에 입력
    await redisClient.hSet(redis_key, {
        user_id: req.user.sub,
        space_id: space_id,
        start_time: start_time,
        status: 'active',
        accumulatedPauseSeconds: '0'
    });
    console.log(`세션 등록 완료: ${await redisClient.hGet(redis_key, 'user_id')}`)
    return res.status(200).json({success: true, start_time: start_time});
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
    await redisClient.hSet(redis_key, {
        last_paused_at: last_paused_at,
        status: 'paused'
    });
    console.log(`일시 정지 성공: ${redis_key}`);
    return res.status(200).json({success: true, last_paused_at: last_paused_at});

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
    const duration = Math.floor((resume_at.getTime() - last_paused_at.getTime()) / 1000);
    const accumulatedPauseSeconds = Number(session.accumulatedPauseSeconds || 0) + duration;

    await redisClient.hSet(redis_key, {
        status: 'active',
        accumulatedPauseSeconds: accumulatedPauseSeconds
    });

    res.status(200).json({
        success: true,
        resume_at: resume_at.toISOString(),
        accumulatedPauseSeconds: accumulatedPauseSeconds
    });
});

// 공부 세션 종료
router.get('/finish', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/finish')

    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);

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
        const duration = Math.floor((stopped_at.getTime() - last_paused_at.getTime())/1000);
        const accumulatedPauseSeconds = Number(session.accumulatedPauseSeconds||0) + duration;
        await redisClient.hSet(redis_key, {accumulatedPauseSeconds: accumulatedPauseSeconds});
        console.log(`일시정지 상태에서 바로 종료: ${redis_key}`);
    };

    await redisClient.hSet(redis_key, {
        status: 'finished',
        end_time: stopped_at.toISOString()
    });

    console.log(`세션 종료됨: ${redis_key}`);
    return res.status(200).json({success: true, end_time: stopped_at.toISOString()});
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
})

export default router;