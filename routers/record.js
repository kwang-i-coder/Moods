import express from "express";
import supabase from "../lib/supabaseClient.js"

const router = express.Router();

// record 생성
router.post("/", async (req, res) => {
    const { user_id, space_id, duration, start_time, end_time, is_public = false, tag_ids } = req.body;

    // 필수 필드 검증
    if (!user_id || !space_id || !duration || !start_time || !end_time) {
        return res.status(400).json({ error: "모든 필수 필드를 입력해야 합니다." });
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
                .from("study_record")
                .delete()
                .eq("id", record.id);
            return res.status(500).json({ error: "태그 관계 생성에 실패했습니다.", details: tagError.message });
        }
        
        // 생성된 레코드와 태그 관계 반환
        const { data: createdRecord, error: fetchError } = await supabase
            .from("study_record")
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

// record 조회 (사용자별, 날짜별))
router.get("/", async (req, res) => {
    const { date, user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        let query = supabase
            .from("study_record")
            .select(`
                *,
                record_tags (
                    tag_id,
                    tags ( id, name )
                )
            `)
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

// 특정 record 조회
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        const { data, error } = await supabase
            .from("study_record")
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
                return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
            }
            return res.status(500).json({ error: "레코드 조회에 실패했습니다.", details: error.message });
        }

        res.status(200).json({ record: data });

    } catch (error) {
        console.error("레코드 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// record 삭제
router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id, space_id, duration, start_time, end_time, is_public, tag_ids } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        // 먼저 레코드가 존재하는지 확인
        const { data: existingRecord, error: checkError } = await supabase
            .from("study_record")
            .select()
            .eq("id", id)
            .eq("user_id", user_id)
            .single();

        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }

        // 태그가 제공된 경우 유효성 검사
        if (tag_ids && Array.isArray(tag_ids) && tag_ids.length > 0) {
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
        }

        // 레코드 업데이트를 위한 데이터
        const updateData = {};
        if (space_id !== undefined) updateData.space_id = space_id;
        if (duration !== undefined) updateData.duration = duration;
        if (start_time !== undefined) updateData.start_time = start_time;
        if (end_time !== undefined) updateData.end_time = end_time;
        if (is_public !== undefined) updateData.is_public = is_public;

        // 레코드 업데이트
        const { data: updatedRecord, error: updateError } = await supabase
            .from("study_record")
            .update(updateData)
            .eq("id", id)
            .eq("user_id", user_id)
            .select()
            .single();
        
        if (updateError) {
            return res.status(500).json({ error: "레코드 수정에 실패했습니다.", details: updateError.message });
        }

        // 태그 관계 업데이트
        if (tag_ids && Array.isArray(tag_ids)) {
            // 기존 태그 관계 삭제
            await supabase
                .from("record_tags")
                .delete()
                .eq("record_id", id);
            
            // 새로운 태그 관계 생성
            if (tag_ids.length > 0) {
                const tagRelations = tag_ids.map(tag_id => ({
                  record_id: id,
                  tag_id
                }));

                const { error: tagError } = await supabase
                    .from("record_tags")
                    .insert(tagRelations);
                
                if (tagError) {
                    return res.status(500).json({ error: "태그 관계 업데이트에 실패했습니다.", details: tagError.message });
                }
            }
        }

        // 업데이트된 레코드와 태그 관계 변환
        const { data: finalRecord, error: fetchError } = await supabase
            .from("study_record")
            .select(`
                *,
                record_tags (
                    tag_id,
                    tags ( id, name )
                )
            `)
            .eq("id", id)
            .single();

            if (fetchError) {
                return res.status(500).json({ error: "레코드 정보를 가져오는 데 실패했습니다." });
            }

            res.status(200).json({
                message: "레코드가 성공적으로 수정되었습니다.",
                record: finalRecord
            });

    } catch (error) {
        console.error("레코드 수정 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// record 삭제
router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        // 기존 레코드 확인
        const { data: existingRecord, error: checkError } = await supabase
            .from("study_record")
            .select()
            .eq("id", id)
            .eq("user_id", user_id)
            .single();

        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }

        // 태그 관계 먼저 삭제
        await supabase
            .from("record_tags")
            .delete()
            .eq("record_id", id);
        
        // 레코드 삭제
        const { error: deleteError } = await supabase
            .from("study_record")
            .delete()
            .eq("id", id)
            .eq("user_id", user_id);

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