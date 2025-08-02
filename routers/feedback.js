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

export default router;