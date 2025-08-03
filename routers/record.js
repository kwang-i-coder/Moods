import express from "express";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import supabase from "../lib/supabaseClient.js"

const router = express.Router();

// 공부 세션 시작
router.post("/start", async (req, res) => {
    const { user_id, space_id } = req.body; 
    if (!user_id || !space_id) {
        return res.status(400).json({ error: "사용자 ID와 스페이스 ID는 필수입니다." });
    }
    try {
        // 현재 시간으로 시작 시작 설정
        const start_time = new Date().toISOString();

        // 진행 중인 세션 생성 (임시 레코드)
        const { data: session, error: sessionError } = await supabaseAdmin
            .from("study_sessions")
            .insert({
                user_id,
                space_id,
                start_time,
                status: 'active' 
            })
            .select()
            .single();

        if (sessionError) {
            return res.status(500).json({ error: "세션 생성에 실패했습니다.", details: sessionError.message });
        }
        res.status(201).json({
            message: "학습 세션이 시작되었습니다.",
            session_id: session.id,
            start_time: session.start_time,
        });

    } catch (error) {
        console.error("세션 시작 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// 공부 세션 종료 및 레코드 생성
router.post("/sessions/:session_id", async (req, res) => {
    const { session_id } = req.params;
    const { user_id, is_public = false } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        // 활성 세션 조회
        const { data: session, error: sessionError } = await supabaseAdmin
            .from("study_sessions")
            .select("*")  
            .eq("id", session_id)
            .eq("user_id", user_id)
            .eq("status", 'active')
            .single();

        if (sessionError || !session) {
            return res.status(404).json({ error: "해당 세션을 찾을 수 없습니다." });
        }

        // 종료시간, 기간 계산
        const end_time = new Date().toISOString();
        const duration = Math.round((new Date(end_time) - new Date(start_time)) / 60000);
        if (duration < 1) {
            return res.status(400).json({ error: "최소 1분 이상 공부해야 합니다." });
        }

        // 레코드 생성
        const { data: record, error: recordError } = await supabaseAdmin
            .from("study_record")
            .insert({
                user_id,
                space_id: session.space_id,
                duration,
                start_time: session.start_time,
                end_time,
                is_public
            })
            .select()
            .single();
        
        if (recordError) {
            return res.status(500).json({ error: "레코드 생성에 실패했습니다.", details: recordError.message });
        }

        // 세션 상태 업데이트
        const { error: updateError } = await supabaseAdmin
            .from("study_sessions")
            .update({
                status: "completed",
                end_time,
                record_id: record.id,
                duration,
            })
            .eq("id", session_id);

        if (updateError) {
            await supabaseAdmin.from("study_record").delete().eq("id", record.id);
            return res.status(500).json({ error: "세션 업데이트 실패", details: updErr.message });
        }

        return res.status(201).json({ message: "세션 완료", record });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "서버 오류" });
    }
});

// 활성 세션 조회
router.get("/sessions/active", async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        const { data: error } = await supabaseAdmin
            .from("study_sessions")
            .select("*, space_details(wifi_score, power, mood_id)")
            .eq("user_id", user_id)
            .eq("status", "active")
            .order("start_time", { ascending: false });

        if (error) {
            return res.status(500).json({ error: "활성 세션 조회에 실패했습니다.", details: error.message });
        }

         const sessions = data.map((s) => ({
            ...s,
            elapsed_minutes: Math.floor((new Date() - new Date(s.start_time)) / 60000),
        }));

        return res.status(200).json({ active_sessions: sessions });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "서버 오류" });
    }
});

// 세션 취소
router.delete("/sessions/:sesion_id/cancel", async (req, res) => {
    const { session_id } = req.params;
    const { user_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        const { data: activeSession, error: checkError } = await supabaseAdmin
            .from("study_sessions")
            .select()
            .eq("id", session_id)
            .eq("user_id", user_id)
            .eq("status", "active")
            .single();

        if (checkError || !activeSession) {
        return res.status(404).json({ error: "활성 세션을 찾을 수 없습니다." });
    }

    // 세션 상태를 취소로 변경 (또는 삭제)
        const { error: updateError } = await supabaseAdmin
            .from("study_sessions")
            .update({ status: 'cancelled' })
            .eq("id", session_id)

        if (updateError) {
            return res.status(500).json({ error: "세션 취소에 실패했습니다." });
        }

        res.status(200).json({ message: "세션이 취소되었습니다." });

    } catch (error) {
        console.error("세션 취소 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});
 

// record 생성
router.post("/records", async (req, res) => {
    const { user_id, space_id, duration, start_time, end_time, is_public = false } = req.body;

    // 필수 필드 검증
    if (!user_id || !space_id || !start_time || !end_time || duration == null) {
        return res.status(400).json({ error: "모든 필수 필드를 입력해야 합니다." });
    }

    try {
        // 레코드 생성
        const { data: record, error: recordError } = await supabase
            .from("study_record")
            .insert({
                user_id,
                space_id,
                duration,
                start_time,
                end_time,
                is_public
            })
            .select()
            .single();
        
        if (recordError) {
            return res.status(500).json({ error: "레코드 생성에 실패했습니다.", details: recordError.message });
        }

        return res.status(201).json({ 
            message: "레코드가 생성되었습니다.",
            record 
        });
    } catch (error) {
        console.error("레코드 생성 중 오류 발생:", error);
        return res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// record 조회 (사용자별, 날짜별))
router.get("/records", async (req, res) => {
    const { date, user_id, space_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        let query = supabaseAdmin
            .from("study_record")
            .select("*")
            .setHeader("Authorization", req.headers.authorization)

        // 날짜 필터링
        if (date) {
            // 날짜 형식 검증 (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(date)) {
                return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" });
            }

            // 해당 날짜에 시작된 기록들 조회
            const startOfDay = `${date}T00:00:00.000Z`;
            const endOfDay = `${date}T23:59:59.999Z`;
            
            query = query
                .gte("start_time", startOfDay)
                .lte("end_time", endOfDay);
        }

        // 스페이스 필터링
        if (space_id) {
            query = query.eq("space_id", space_id);
        }

        const { data, error } = await query.order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({ error: "레코드 조회에 실패했습니다.", details: error.message });
        }

        res.status(200).json({
            message: "학습 기록을 조회했습니다.",
            count: data.length,
            records: data
        });
    
    } catch (error) {
        console.error("레코드 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// 단일 record 조회
router.get("/records/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        const { data, error } = await supabaseAdmin
            .from("study_record")
            .select("*")
            .eq("id", id)
            .eq("user_id", user_id)
            .single();

        if (error) {
            return res.status(404).json({ error: "레코드를 찾을 수 없습니다.", details: error.message });
        }
        return res.status(200).json({ record: data });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "서버 오류" });
    }
});

// record 수정
router.put("/records/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id, space_id, duration, start_time, end_time, is_public } = req.body;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        // 먼저 레코드가 존재하는지 확인
        const { data: existingRecord, error: checkError } = await supabaseAdmin
            .from("study_record")
            .select()
            .eq("id", id)
            .eq("user_id", user_id)
            .single();
        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }

        // 레코드 업데이트를 위한 데이터
        const updateData = {};
        if (space_id) updateData.space_id = space_id;
        if (start_time) updateData.start_time = start_time;
        if (end_time) updateData.end_time = end_time;
        if (duration != null) updateData.duration = duration;
        if (is_public != null) updateData.is_public = is_public;

        // 레코드 업데이트
        const { data: updatedRecord, error: updateError } = await supabaseAdmin
            .from("study_record")
            .update(updateData)
            .eq("id", id)
            .select()
            .single();
        
        if (updateError) {
            return res.status(500).json({ error: "레코드 수정 실패.", details: updateError.message });
        }
        return res.status(200).json({ message: "레코드 수정 완료.", record: updatedRecord });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "서버 오류 "});
    }
});
        
// record 삭제
router.delete("/records/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        // 기존 레코드 확인
        const { data: existingRecord, error: checkError } = await supabaseAdmin
            .from("study_record")
            .select()
            .eq("id", id)
            .eq("user_id", user_id)
            .single();
        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }
        
        // 레코드 삭제
        const { error: deleteError } = await supabaseAdmin
            .from("study_record")
            .delete()
            .eq("id", id)
        if (deleteError) {
            return res.status(500).json({ error: "레코드 삭제에 실패했습니다.", details: deleteError.message });
        }

        res.status(200).json({ message: "레코드가 성공적으로 삭제되었습니다." });

    } catch (error) {
        console.error("레코드 삭제 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

export default router;