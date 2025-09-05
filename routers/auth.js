import express from "express"
import supabase from "../lib/supabaseClient.js"
import supabaseAdmin from "../lib/supabaseAdmin.js";
import cookieParser from "cookie-parser";



const router = express.Router();

router.use(cookieParser());
router.use(express.json())
router.use(express.urlencoded({ extended: true }));

// 로그인 라우트
router.post('/signin', async(req, res, next) => {
    console.log('[라우트 호출] POST /auth/signin');
    // 요청 본문에서 이메일, 비번 받아서 검증
    const {email, password} = req.body;
    
    // 이메일과 비밀번호가 없으면 에러 응답
    if(!email || !password) {
        console.error('[에러] POST /auth/signin: 잘못된 양식', req.body);
        return res.status(400).send("잘못된 양식");
    }

    // supabase로 로그인 시도
    try {
        const {data, error} = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        })
        // 로그인 실패 시 에러 응답
        if (error){
            console.error('[에러] POST /auth/signin: 로그인 실패', error);
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
            console.error('[에러] POST /auth/signin: 유저 정보 없음', userError);
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
        console.error('[에러] POST /auth/signin: try-catch', error);
        return res.status(500).json({error: "서버 오류"});
    }
})

router.post('/signin_kakao', async (req, res) => {
    console.log('[라우트 호출] POST /auth/signin_kakao');
    // 요청 본문에서 카카오 토큰 받아서 검증
    const {kakao_token} = req.body;
    // 카카오 토큰이 없으면 에러 응답
    if(!kakao_token){
        console.error('[에러] POST /auth/signin_kakao: 토큰 누락', req.body);
        return res.status(400).send('토큰 누락')
    }
    try {
        // 카카오로 로그인 시도
        const { data, error } = await supabase.auth.signInWithIdToken({
            provider: 'kakao',
            token: kakao_token
            });
        if(error){
            console.error('[에러] POST /auth/signin_kakao: signIn error', error);
            return res.status(500).send(`signIn error: ${error.message}`)
        }
        // 닉네임 정보 가져오기
        const {data: userData, error: userError} = await supabase
            .from('users')
            .select('nickname')
            .eq('id', data.user.id)
            .single()
            .setHeader('Authorization', `Bearer ${data.session.access_token}`);

        if(userError){
            console.error('[에러] POST /auth/signin_kakao: userData error', userError);
            return res.status(500).send(`userData error: ${userError.message}`)
        }
        
        // 성공 응답
        return res.status(200).json({
            message: '로그인 성공',
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
        })
    } catch (error) {
        console.error('[에러] POST /auth/signin_kakao: try-catch', error);
        return res.status(500).send(`signIn error: ${error.message}`)
    }
})


router.post('/send-verification', async(req, res)=>{
    // 확인 이메일 최초 전송 라우트
    console.log('[라우트 호출] POST /auth/send-verification');
    // 요청 검증
    const { email } = req.body;
    if (!email) {
        console.error('[에러] POST /auth/send-verification: 잘못된 양식', req.body);
        return res.status(400).send("잘못된 양식");
    }
    // supabase는 비밀번호 없이는 이메일 인증을 하지 못하므로 임의의 이메일을 사용하여 인증메일 요청
    const password = generateRandomPassword();
    try {
        // 회원가입 호출 (사실상 이메일 최초 전송 기능)
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: `${process.env.API_URL}/verification-page.html`
            }
        });
        if (error) {
            console.error("메일 전송 오류:", error);
            return res.status(400).json({ error: error.message });
        }
        if (!data || !data.user) {
            console.error('[에러] POST /auth/send-verification: 인증메일 전송 오류', data);
            return res.status(500).json({ error: "인증메일 전송 오류가 발생했습니다." });
        }
        // 성공 응답
        return res.status(201).json({
            message: "인증 메일 전송 성공",
            user: {
                id: data.user.id,
                email: email,
                created_at: data.user.created_at,
            }
        });
    } catch (error) {
        return res.status(500).json({ error: "서버 오류" });
    }
})

router.post('/signup', async (req, res) => {
    // 이메일 인증이 완료된 후 비밀번호, 닉네임 등 유저 정보 저장
    console.log('[라우트 호출] POST /auth/signup');
    const {user_id ,password, nickname, birthday, gender} = req.body;
    if(!user_id||!password||!nickname||!birthday||!gender){
        console.error('[에러] POST /auth/signup: 잘못된 양식', req.body);
        return res.status(400).send("잘못된 양식");
    }
    try{
        const {data, error: update_error}= await supabaseAdmin.auth.admin.updateUserById(
            user_id,
            {
                password: password,
                user_metadata: {
                    nickname: nickname,
                    birthday: birthday,
                    gender: gender
                }
            }
        )
        if(update_error){
            console.error('[에러] POST /auth/signup: 비밀번호 설정 에러', update_error);
            return res.status(500).send(`비밀번호 설정 에러: ${update_error.message}`)
        }
        return res.status(200).json({message: "회원가입 성공", user_id: data.user.id, email: data.user.email})
    }catch(error){
        console.error('[에러] POST /auth/signup: try-catch', error);
        return res.status(500).send(`서버 에러: ${error}`)
    }

})

// 이메일 인증이 완료되었는지 확인
router.get('/is-verified', async(req, res) => {
    console.log('[라우트 호출] GET /auth/is-verified');
    // 이메일로 사용자 테이블에서 정보 조회 (이메일 인증 여부와 프로바이더 정보 확인)
    const {data, error} = await supabaseAdmin.auth.admin.getUserById(req.query.id);

    if (error) {
        console.error('[에러] GET /auth/is-verified:', error);
        return res.status(500).json({error: error.message});
    }

    return res.status(200).json({
        confirmed_at: data.user.confirmed_at? data.user.confirmed_at : null,
    });
})

// 이메일 인증 재전송 라우트
router.get('/resend-signup-verification', async (req, res) => {
    console.log('[라우트 호출] GET /auth/resend-signup-verification');
    console.log("이메일 인증 재전송 요청:", req.query.email);
    try {
        const {error} = await supabase.auth.resend({
            type: 'signup',
            email: req.query.email,
        })
        if (error) {
            console.error('[에러] GET /auth/resend-signup-verification: 이메일 인증 재전송 오류', error);
            return res.status(400).json({error: "이메일 인증 재전송에 실패했습니다."});
        }
        return res.status(200).json({message: "이메일 인증 재전송 성공"});
    } catch (error) {
        console.error('[에러] GET /auth/resend-signup-verification: try-catch', error);
        return res.status(500).json({error: "서버 오류"});
    }
})

// 비밀번호 재설정 요청 라우트
// 클라이언트는 이 라우트만 호출함
router.get('/reset-password', async (req, res) => {
    console.log('[라우트 호출] GET /auth/reset-password');
    const email = req.query.email;
    if (!email) {
        console.error('[에러] GET /auth/reset-password: 이메일 누락', req.query);
        return res.status(400).json({error: "이메일이 필요합니다."});
    }
    try {
        const {error} = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${process.env.API_URL}/auth/confirm-password-reset`
        });
        if (error) {
            console.error('[에러] GET /auth/reset-password: 비밀번호 변경 요청 오류', error);
            return res.status(400).json({error: "비밀번호 변경 요청에 실패했습니다."});
        }
        return res.status(200).json({message: "변경 이메일이 전송되었습니다."});
    } catch (error) {
        console.error('[에러] GET /auth/reset-password: try-catch', error);
        return res.status(500).json({error: "서버 오류"});
    }
})

// 비밀번호 재설정 확인 라우트
// 확인 메일의 링크를 누르면 해당 라우트로 이동
router.get('/confirm-password-reset', async (req, res) => {
    console.log('[라우트 호출] GET /auth/confirm-password-reset');
    const token_hash = req.query.token_hash;
    const type = req.query.type;
    const next = req.query.next;
    const email = req.query.email;

    if (!token_hash || !type || !next || !email) {
        console.error('[에러] GET /auth/confirm-password-reset: 파라미터 부족', req.query);
        return res.status(400).json({error: "필요한 정보가 부족합니다."});
    }

    if(token_hash && type){
        const {data,error} = await supabase.auth.verifyOtp({
            token_hash: token_hash,
            type: type,
        })
        if (!error) {
            return res
            .cookie('Authorization', `Bearer ${data.session.access_token}`, {httpOnly: true})
            .cookie('Refresh', `Bearer ${data.session.refresh_token}`, {httpOnly: true})
            .cookie('ID', data.user.id, {httpOnly: true})
            .redirect(303, `/${next.slice(1)}`)
        }
    }
    
    res.redirect(303, '/something_went_wrong.html'); // 인증 코드 오류 페이지로 리다이렉트
})

// 비밀번호 재설정 라우트
// confirm-password-reset에서 otp인증을 한 후 재설정 페이지로 이동한다.
// 재설정 페이지의 form에서 비밀번호를 입력하고 제출하면 이 라우트로 POST 요청이 온다.
// 이 라우트에서 비밀번호를 재설정한다.
router.post('/reset-password', async (req, res) => {
    console.log('[라우트 호출] POST /auth/reset-password');
    console.log(req.body)
    const new_password = req.body.password;

    if (!new_password) {
        console.error('[에러] POST /auth/reset-password: 비밀번호 누락', req.body);
        return res.status(400).json({error: "필요한 정보가 부족합니다."});
    }

    try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(
            req.cookies.ID,
            {
                password: new_password
            }
        );
        
        // 비밀번호가 기존과 같을 시 alert 띄우고 리다이렉트
        if(error !== null && error.code === "same_password") {
            console.error('[에러] POST /auth/reset-password: 기존 비밀번호와 동일', error);
            return res
            .send(`<script>alert("기존 비밀번호와 동일합니다. 다른 비밀번호를 입력해주세요."); window.location.href = "/update_password.html";</script>`);
        }

        if (error) {
            console.error('[에러] POST /auth/reset-password: 비밀번호 변경 오류', error);
            return res.status(400).json({error: "비밀번호 변경에 실패했습니다."});
        }

        return res.redirect(303, '/celebrate-password-reset.html'); // 비밀번호 변경 성공 페이지로 리다이렉트
    } catch (e) {
        console.error('[에러] POST /auth/reset-password: try-catch', e);
        return res.status(500).json({error: "서버 오류"});
    }
})

// 토큰 갱신 라우트
router.post('/refresh-token', async (req, res) => {
    console.log('[라우트 호출] POST /auth/refresh-token');
    const { refresh_token } = req.body;
    if (!refresh_token) {
        console.error('[에러] POST /auth/refresh-token: 리프레시 토큰 누락', req.body);
        return res.status(400).json({error: "리프레시 토큰이 필요합니다."});
    }
    try {
        const { data, error } = await supabase.auth.refreshSession({
            refresh_token: refresh_token
        });
        if (error) {
            console.error('[에러] POST /auth/refresh-token: 토큰 갱신 오류', error);
            return res.status(400).json({error: "토큰 갱신에 실패했습니다."});
        }
        return res.status(200).json({
            message: "토큰 갱신 성공",
            session: {
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token,
            }
        });
    } catch (error) {
        console.error('[에러] POST /auth/refresh-token: try-catch', error);
        return res.status(500).json({error: "서버 오류"});
    }
})

function generateRandomPassword(length = 12, includeUppercase = true, includeNumbers = true, includeSymbols = true) {
  const lowercaseChars = "abcdefghijklmnopqrstuvwxyz";
  const uppercaseChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numberChars = "0123456789";
  const symbolChars = "!@#$%^&*()-_=+[]{}|;:,.<>?";

  let allChars = lowercaseChars;
  if (includeUppercase) allChars += uppercaseChars;
  if (includeNumbers) allChars += numberChars;
  if (includeSymbols) allChars += symbolChars;

  let password = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * allChars.length);
    password += allChars[randomIndex];
  }
  return password;
}


export default router;

