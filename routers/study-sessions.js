import express from 'express'
import supabase from '../lib/supabaseClient.js'
import redisClient from '../lib/redisClient.js'
import verifySupabaseJWT from '../lib/verifyJWT.js'

const router = express.Router()

router.get('/start', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] /study-sessions/start')
    const {space_id} = req.query;
    const start_time = new Date().toISOString();
    const redis_key = `sessions:${req.user.sub}`

    // if(await redisClient.hGetAll(redis_key)){
    //     res.status(400).send('이미 세션이 존재합니다.')
    // }

    if(!space_id){
        res.status(400).send('space_id가 누락됐습니다.')
    }
    
    await redisClient.hSet(redis_key, {
        user_id: req.user.sub,
        space_id: space_id,
        start_time: start_time,
        status: 'active'
    });
    console.log(`세션 등록 완료: ${await redisClient.hGet(redis_key, 'user_id')}`)
    res.status(200).json({success: true, start_time: start_time});
})

export default router;