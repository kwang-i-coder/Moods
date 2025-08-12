// express 서버 모듈
import express from "express";
// 환경변수 설정
import "./lib/env.js"
// 라우터 모듈 불러오기
import auth_router from "./routers/auth.js";    
import user_router from "./routers/user.js";
import space_router from "./routers/space.js";
import session_router from "./routers/study-sessions.js";
import record_router from "./routers/record.js";
import feedback_router from "./routers/feedback.js";
import photo_router from "./routers/photo-management.js";

const app = express();


// 정적 파일 제공을 위한 미들웨어
app.use(express.static('public'))

// post, patch에 대해 JSON 파싱 미들웨어 사용
app.post("*splat",express.json());
app.patch("*splat", express.json());
app.use(express.json()); // 전역 JSON 파서로 적용 (모든 POST/PUT/PATCH 요청에 필요)


// 라우터 설정
app.use('/auth', auth_router);
app.use('/user', user_router);
app.use('/spaces', space_router);
app.use('/record', record_router);
app.use('/feedback', feedback_router);
app.use('/study-sessions', session_router);
app.use('/photos', photo_router);

app.get("/", (req, res) => {
    res.send("this is root page");
})

app.listen(process.env.PORT)