// express 서버 모듈
import express from "express";
// 환경변수 설정
import "./lib/env.js"
// 라우터 모듈 불러오기
import auth_router from "./routers/auth.js";    
import user_router from "./routers/user.js";
// 파일 입출력
import fs from "fs";


const app = express();
// post, patch에 대해 JSON 파싱 미들웨어 사용
app.post("*splat",express.json());
app.patch("*splat", express.json());
// 라우터 설정
app.use('/auth', auth_router);
app.use('/user', user_router);

// 이메일 인증 시 보여줄 페이지
app.get("/", (req, res) => {
    const html = fs.readFileSync("./verification_page.html", "utf-8");
    res.send(html);
})

app.listen(process.env.PORT)

