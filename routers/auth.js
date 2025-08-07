import express from "express"
import supabase from "../lib/supabaseClient.js"
import supabaseAdmin from "../lib/supabaseAdmin.js";
import cookieParser from "cookie-parser";
import { v4 as uuidv4 } from "uuid";
import e from "express";



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

router.post('/send-verification', async(req, res)=>{
    console.log('[라우트 호출] POST /auth/send-verification');
    // 요청 검증
    const { email } = req.body;
    if (!email) return res.status(400).send("잘못된 양식");
    const password = generateRandomPassword();
    try {
        // 회원가입 호출 (추가 정보 저장)
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
    console.log('[라우트 호출] POST /auth/signup');
    const {user_id ,password, nickname, birthday, gender} = req.body;
    if(!user_id||!password||!nickname||!birthday||!gender){
        return res.status(400).send("잘못된 양식");
    };
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
            return res.status(500).send(`비밀번호 설정 에러: ${update_error.message}`)
        }
        return res.status(200).json({message: "회원가입 성공", user_id: data.user.id, email: data.user.email})
    }catch(error){
        return res.status(500).send(`서버 에러: ${error}`)
    }

})

router.get('/is-verified', async(req, res) => {
    console.log('[라우트 호출] GET /auth/is-verified');
    // 이메일로 사용자 테이블에서 정보 조회 (이메일 인증 여부와 프로바이더 정보 확인)
    const {data, error} = await supabaseAdmin.auth.admin.getUserById(req.query.id);

    if (error) {
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
            console.error("이메일 인증 재전송 오류:", error);
            return res.status(400).json({error: "이메일 인증 재전송에 실패했습니다."});
        }
        return res.status(200).json({message: "이메일 인증 재전송 성공"});
    } catch (error) {
        return res.status(500).json({error: "서버 오류"});
    }
})

// 비밀번호 재설정 요청 라우트
// 클라이언트는 이 라우트만 호출함
router.get('/reset-password', async (req, res) => {
    console.log('[라우트 호출] GET /auth/reset-password');
    const email = req.query.email;
    if (!email) {
        return res.status(400).json({error: "이메일이 필요합니다."});
    }
    try {
        const {error} = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${process.env.API_URL}/auth/confirm-password-reset`
        });
        if (error) {
            console.error("비밀번호 변경 요청 오류:", error);
            return res.status(400).json({error: "비밀번호 변경 요청에 실패했습니다."});
        }
        return res.status(200).json({message: "변경 이메일이 전송되었습니다."});
    } catch (error) {
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
    const access_token = req.cookies['Authorization']?.split(' ')[1];
    const refresh_token = req.cookies['Refresh']?.split(' ')[1];
    await supabase.auth.setSession({refresh_token: refresh_token, access_token: access_token});
    const new_password = req.body.password;

    if (!new_password) {
        return res.status(400).json({error: "필요한 정보가 부족합니다."});
    }

    try {
        const { error } = await supabase.auth.updateUser({
            password: new_password
        });
        
        // 비밀번호가 기존과 같을 시 alert 띄우고 리다이렉트
        if(error.code === "same_password") {
            return res
            .send(`<script>alert("기존 비밀번호와 동일합니다. 다른 비밀번호를 입력해주세요."); window.location.href = "/update_password.html";</script>`);
        }

        if (error) {
            console.error("비밀번호 변경 오류:", error.code);
            return res.status(400).json({error: "비밀번호 변경에 실패했습니다."});
        }

        return res.redirect(303, '/celebrate-password-reset.html'); // 비밀번호 변경 성공 페이지로 리다이렉트
    } catch (error) {
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

