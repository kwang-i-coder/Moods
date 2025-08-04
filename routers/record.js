import express from "express";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";

const router = express.Router();

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

            // 해당 날짜에 시작된 ₩들 조회
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