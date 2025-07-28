// express 서버 모듈
import express from "express";
// 환경변수 설정
import "./lib/env.js"
// 라우터 모듈 불러오기
import auth_router from "./routers/auth.js";    
import user_router from "./routers/user.js";
import record_router from "./routers/record.js";

const app = express();

// 정적 파일 제공을 위한 미들웨어
app.use(express.static('public'))

// post, patch에 대해 JSON 파싱 미들웨어 사용
app.post("*splat",express.json());
app.patch("*splat", express.json());

// 라우터 설정
app.use('/auth', auth_router);
app.use('/user', user_router);
app.use('/record', record_router);

app.get("/", (req, res) => {
    res.send("this is root page");
})

app.listen(process.env.PORT)