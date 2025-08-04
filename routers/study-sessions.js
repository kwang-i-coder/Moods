import express from 'express'
import supabase from '../lib/supabaseClient.js'
import redisClient from '../lib/redisClient.js'
import verifySupabaseJWT from '../lib/verifyJWT.js'

const router = express.Router()

router.get('/start', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/start')

    // 최초 기록 시 공간 정보를 받아서 저장
    const {space_id} = req.query;
    // 공부 시작시간은 서버 시각으로 정한 후 클라이언트에게 응답으로 줌
    const start_time = new Date().toISOString();
    // 해당 유저의 세션이 저장되는 redis id
    const redis_key = `sessions:${req.user.sub}`

    const session = await redisClient.hGetAll(redis_key);

    if (Object.keys(session).length !== 0) {
        console.log(`다중 세션 시도: ${redis_key}`)
        return res.status(400).send('이미 세션이 존재합니다.');
    }

    if(!space_id){
        return res.status(400).send('space_id가 누락됐습니다.')
    }
    
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

router.get('/pause', verifySupabaseJWT, async (req, res) => {
    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);

    if (Object.keys(session).length === 0) {
        console.log(`세션 시작 안 함: ${redis_key}`);
        return res.status(400).send('세션이 없습니다.');
    };

    const last_paused_at = new Date().toISOString();
    await redisClient.hSet(redis_key, {
        last_paused_at: last_paused_at,
        status: 'paused'
    });
    console.log(`일시 정지 성공: ${redis_key}`);
    return res.status(200).json({success: true, last_paused_at: last_paused_at});

})

router.get('/resume', verifySupabaseJWT, async (req, res) => {
    const redis_key = `sessions:${req.user.sub}`;
    const session = await redisClient.hGetAll(redis_key);


    if (Object.keys(session).length === 0) {
        console.log(`세션 시작 안 함: ${redis_key}`);
        return res.status(400).send('세션이 없습니다.');
    }

    if (session.status !== 'paused') {
        console.log(`일시정지 상태가 아님: ${redis_key}`);
        return res.status(400).send('일시정지 상태가 아닙니다.');
    }

    const last_paused_at = new Date(session.last_paused_at);
    console.log(`last_paused: ${last_paused_at}`)
    const resume_at = new Date();
    const duration = Math.floor((resume_at.getTime() - last_paused_at.getTime()) / 1000);
    console.log("accumulated: "+ session.accumulatedPauseSeconds);
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


export default router;