import express from "express"
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";
import supabaseAdmin from "../lib/supabaseAdmin.js";

const router = express.Router();


router.get('/', verifySupabaseJWT, async(req, res)=>{
    // public.users 테이블에서 유저 정보 가져오기
    const {data: userData, error: userError} = await supabase
        .from('users')
        .select('*')
        .setHeader('Authorization', req.headers.authorization);
        
    if (userError) {
        return res.status(400).json({ error: userError.message });
    }
    res.json({
        message:"사용자 정보 조회에 성공했습니다.",
        user: userData[0]
    })
})

router.delete('/', verifySupabaseJWT, async(req, res)=>{
    // 유저 삭제 요청
    const {error} = await supabaseAdmin.auth.admin.deleteUser(req.user.sub);
    if (error) {
        return res.status(400).json({error: error.message});
    }
    res.json({
        message: "유저 삭제에 성공했습니다."
    })
});

router.patch('/', verifySupabaseJWT, async(req, res)=>{
    // 유저 정보 수정 요청
    var fields_to_update = {};

    for (const field of ['nickname', 'profile_img_url', 'birthday', 'gender']){
        if (req.body[field]) {
            fields_to_update[field] = req.body[field];
        }
    }
    
    // 유저 정보 업데이트
    const {error} = await supabase
        .from('users')
        .update(fields_to_update)
        .eq('id', req.user.sub)
        .setHeader('Authorization', req.headers.authorization);

    if (error) {
        return res.status(400).json({error: "유저 정보를 업데이트하는데 실패했습니다."});
    }

    res.json({
        message: "유저 정보가 성공적으로 업데이트되었습니다.",
    });
})
    

export default router;