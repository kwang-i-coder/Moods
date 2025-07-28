import express from "express";
import supabase from "../lib/supabaseClient.js"

const router = express.Router();

// record 생성
router.post("/", async (req, res) => {
    const { user_id, date, content, space_name, tag_ids } = req.body;

    // 필수 필드 검증
    if (!user_id || !date || !content || !space_name) {
        return res.status(400).json({ error: "모든 필드를 입력해야 합니다." });
    }

    if (!tag_ids || !Array.isArray(tag_ids) || tag_ids.length === 0) {
        return res.status(400).json({ error: "최소 하나의 태그를 선택해야 합니다." })
    }

    try {
        // 태그 유효성 검사
        const { data: validTags, error: tagValidationError } = await supabase
            .from("tags")
            .select("id")
            .in("id", tag_ids);

        if (tagValidationError) {
            return res.status(500).json({ error: "태그 유효성 검사에 실패했습니다." });
        }

        if (validTags.length !== tag_ids.length) {
            return res.status(400).json({ error: "유효하지 않은 태그가 포함되어 있습니다." });
        }

        // 레코드 생성
        const { data: record, error: recordError } = await supabase
            .from("records")
            .insert({ user_id, date, content, space_name })
            .select()
            .single();
        
        if (recordError) {
            return res.status(500).json({ error: "레코드 생성에 실패했습니다.", details: recordError.message });
        }

        // 태그 관계 생성
        const tagRelations = tag_ids.map(tag_id => ({
            record_id: record.id,
            tag_id
        }));

        const { error: tagError } = await supabase
            .from("record_tags")
            .insert(tagRelations);
            
        if (tagError) {
            await supabase
                .from("records")
                .delete()
                .eq("id", record.id);
            return res.status(500).json({ error: "태그 관계 생성에 실패했습니다.", details: tagError.message });
        }
        
        // 생성된 레코드와 태그 관계 반환
        const { data: createdRecord, error: fetchError } = await supabase
            .from("records")
            .select(`
                *,
                record_tags (
                    tag_id,
                    tags ( id, name )
                )
            `)
            .eq("id", record.id)
            .single();

        if (fetchError) {
            return res.status(500).json({ error: "레코드 정보를 가져오는 데 실패했습니다." });
        }

        res.status(201).json({
            message: "레코드가 성공적으로 생성되었습니다.",
            record: createdRecord
        });

    } catch (error) {
        console.error("레코드 생성 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// record 조회
router.get("/", async (req, res) => {
    const { date, user_id } = req.query;

    if (!date || !user_id) {
        return res.status(400).json({ error: "날짜와와 사용자 ID는 필수입니다." });
    }

    // 날짜 형식 검증 (YYYY-MM-DD 또는 YYYYMMDD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$|^\d{8}$/;
    if (!dateRegex.test(date)) {
        return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" });
    }

    try {
        const { data, error } = await supabase
            .from("records")
            .select(`
                *,
                record_tags (
                    tag_id,
                    tags ( id, name )
                )
            `)
            .eq("user_id", user_id)
            .eq("date", date)
            .order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({ error: "레코드 조회에 실패했습니다.", details: error.message });
        }

        res.status(200).json({
            message: `${date} 날짜의 기록을 조회했습니다.`,
            count: data.length,
            records: data
        });

    } catch (error) {
        console.error("레코드 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

router.get("/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        const { data, error } = await supabase
            .from("records")
            .select(`
                *,
                record_tags (
                    tag_id,
                    tags ( id, name )
                )
            `)
            .eq("id", id)
            .eq("user_id", user_id)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: "레코드를 찾을 수 없습니다." });
            }
            return res.status(500).json({ error: "레코드 조회에 실패했습니다.", details: error.message });
        }

        res.status(200).json({ record: data });

    } catch (error) {
        console.error("레코드 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

export default router;