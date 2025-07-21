import express from "express"
import supabase from "../lib/supabaseClient.js"
import supabaseAdmin from "../lib/supabaseAdmin.js";

const router = express.Router();

router.use(express.json())

// 로그인 라우트
router.post('/signin', async(req, res, next) => {
    // 요청 본문에서 이메일, 비번 받아서 검증
    const {email, password} = req.body;
    
    // 이메일과 비밀번호가 없으면 에러 응답
    if(!email || !password) return res.status(400).send("잘못된 양식");

    // supabase로 로그인 시도
    try {
        const {data, error} = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        })
        // 로그인 실패 시 에러 응답
        if (error){
            return res.status(400).json({error: "로그인에 실패했습니다."});
        }
        // 닉네임 정보 가져오기 (닉네임 정보가 있어야 유저가 활동할 수 있으므로 닉네임 정보가 있는지 확인)
        const {data: userData, error: userError} = await supabase
            .from('users')
            .select('nickname')
            .eq('id', data.user.id)
            .single()
            .setHeader('Authorization', `Bearer ${data.session.access_token}`);

        if (userError || !userData) {
            return res.status(404).json({ error: "유저 정보를 찾을 수 없습니다." });
        }


        // 성공 응답 (session 정보만 보냄)
        return res.status(200).json({
            message: `로그인 성공`,
            session: {
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token,
                expires_at: data.session.expires_at,
                user: {
                    id: data.user.id,
                    email: data.user.email,
                    nickname: userData.nickname,
                    created_at: data.user.created_at,
                }
            }
        });
    } catch (error) {
        return res.status(500).json({error: "서버 오류"});
    }
})

router.post('/signup', async(req, res)=>{
    // 요청 검증
    const { email, password, nickname, birthday, gender} = req.body;
    if (!email || !password || !nickname || !birthday || !gender) return res.status(400).send("잘못된 양식");
    try {
        // 회원가입 호출 (추가 정보 저장)
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    nickname: nickname,
                    birthday: birthday,
                    gender: gender
                }
            }
        });
        if (error) {
            console.error("회원가입 오류:", error);
            return res.status(400).json({ error: error.message });
        }
        if (!data || !data.user) {
            return res.status(500).json({ error: "회원가입 처리 중 오류가 발생했습니다." });
        }
        // 성공 응답
        return res.status(201).json({
            message: "회원가입 성공",
            user: {
                id: data.user.id,
                email: email,
                nickname: nickname,
                created_at: data.user.created_at,
            }
        });
    } catch (error) {
        return res.status(500).json({ error: "서버 오류" });
    }
})

router.get('/is-verified', async(req, res) => {
    // 이메일로 사용자 테이블에서 정보 조회 (이메일 인증 여부와 프로바이더 정보 확인)
    const {data, error} = await supabaseAdmin.auth.admin.getUserById(req.query.id);

    if (error) {
        return res.status(500).json({error: error.message});
    }

    return res.status(200).json({
        confirmed_at: data.user.confirmed_at? data.user.confirmed_at : null,
    });
})

export default router;