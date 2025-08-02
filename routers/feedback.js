import express from "express";
import supabase  from "../lib/supabaseClient.js";
import verifySupabaseJWT from "../lib/verifyJWT.js";

const router = express.Router();

router.get("/", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /feedback');
    const {space_id} = req.query;
    
    if(space_id){// 피드백 데이터를 가져오기
        try {
            const { data, error } = await supabase
                .from('feedback')
                .select('*')
                .eq('space_id', space_id)
                .setHeader('Authorization', req.headers.authorization);

            if (error) {
                return res.status(500).json({ error: "피드백 데이터를 가져오는 데 실패했습니다." + error.message });
            }

            // 성공적으로 데이터를 가져온 경우
            return res.status(200).json({seuccess: true, data: data});
        } catch (error) {
            return res.status(500).json({ error: "서버 오류" });
        }
    }else{
        // space_id가 없을 경우 사용자가 남긴 모든 피드백 데이터 가져오기
        try {
            const { data, error } = await supabase
                .from('feedback')
                .select('*')
                .setHeader('Authorization', req.headers.authorization);

            if (error) {
                return res.status(500).json({ error: "피드백 데이터를 가져오는 데 실패했습니다."+ error.message });
            }

            // 성공적으로 데이터를 가져온 경우
            return res.status(200).json({seuccess: true, data: data});
        } catch (error) {
            return res.status(500).json({ error: "서버 오류" });
        }
    }
})

router.post("/", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] POST /feedback');
    const { wifi_score, power, comment, noise_level, crowdness, space_id } = req.body;

    if (!wifi_score || (power===null) || !comment || !noise_level || !crowdness || !space_id) {
        return res.status(400).json({ error: "모든 필드를 입력해야 합니다." });
    }

    try {
        const { data, error } = await supabase
            .from('feedback')
            .insert([
                { user_id: req.user.sub, wifi_score: wifi_score, power: power, comment: comment, noise_level: noise_level, crowdness: crowdness, space_id: space_id }
            ])
            .setHeader('Authorization', req.headers.authorization);

        if (error) {
            return res.status(500).json({ error: "피드백 데이터를 저장하는 데 실패했습니다." + error.message });
        }

        // 성공적으로 데이터를 저장한 경우
        return res.status(201).json({ success: true, data: data });
    } catch (error) {
        return res.status(500).json({ error: "서버 오류" });
    }
});

router.patch("/", verifySupabaseJWT, async (req, res) => {
    var fields_to_update = {};
    console.log('[라우트 호출] PATCH /feedback');
    console.log(req.body.power);
    for(const field of ['wifi_score', 'power', 'comment', 'noise_level', 'crowdness']){
        if (!(req.body[field]===null)) {
            fields_to_update[field] = req.body[field];
        }
    }

    if (Object.keys(fields_to_update).length === 0) {
        return res.status(400).json({ error: "수정할 필드가 없습니다." });
    }

    try {
        const { data, error } = await supabase
            .from('feedback')
            .update(fields_to_update)
            .eq('id', req.query.feedback_id)
            .setHeader('Authorization', req.headers.authorization);

        if (error) {
            return res.status(500).json({ error: "피드백 데이터를 수정하는 데 실패했습니다." + error.message });
        }

        // 성공적으로 데이터를 수정한 경우
        return res.status(200).json({ success: true, data: data });
    } catch (error) {
        return res.status(500).json({ error: "서버 오류" });
    }
})

export default router;