import express from "express";
import crypto from "crypto";
import multer from "multer";
import sharp from "sharp";
import supabase from "../lib/supabaseClient.js";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import verifySupabaseJWT from "../lib/verifyJWT.js";

const router = express.Router();

//업로드 설정, 이미지 MIME만 허용
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.mimetype);
        cb(ok ? null : new Error('이미지 형식만 허용합니다.'), ok);
    }
});

// 본인 기록인지 확인
async function assertOwnRecord(recordID, req) {
    const { data: rec, error } = await supabase
        .from('study_record')
        .select('id, user_id')
        .eq('id', recordID)
        .single()
        .setHeader('Authorization', req.headers.authorization);
    if (error || !rec || rec.user_id !== req.user.sub) {
        const e = new Error('기록을 찾을 수 없거나 권한이 없습니다.');
        e.status = 403;
        throw e;
    }
    return rec;
}

// 경로 생성
const buildPath = (userID, recordID) =>
    `${userID}/${recordID}/${crypto.randomUUID()}.webp`;

// 사진 업로드
// 원본 -> 리사이즈 -> webp 변환 후 스토리즈 업로드
router.post('/records/:recordId', verifySupabaseJWT, upload.single('file'), async(req, res) => {
    console.log('[라우트 호출] POST /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        await assertOwnRecord(recordId, req);
        
        // 입력값 검증
        if (!recordId || isNaN(recordId)) {
            return res.status(400).json({ error: '유효하지 않은 기록ID입니다.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: '업로드 할 파일이 없습니다. '});
        }

        // 기존 사진이 있는지 체크
        const { data: existingPhoto } = await supabase
            .from('record_photos')
            .select('id')
            .eq('record_id', recordId)
            .single()
            .setHeader('Authorization', req.headers.authorization);

        if (existingPhoto) {
            return res.status(400).json({ error: '이미 사진이 등록되어 있습니다.'});
        }

        const file = req.file;

        // 이미지 리사이즈
        const processed = await sharp(file.buffer)
            .rotate()
            .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true})
            .webp({ quality: 82 })
            .toBuffer();

        const meta = await sharp(processed).metadata();

        // 경로 생성
        const path = buildPath(req.user.sub, recordId);

        // Storage 업로드
        const { error: uploadError } = await supabaseAdmin.storage.from('study-photos')
            .upload(path, processed, { contentType: 'image/webp', upsert: false });
        if(uploadError) throw uploadError;

        // DB 저장
        const { data: row, error: insErr} = await supabase
            .from('record_photos')
            .insert({
                record_id: recordId,
                path,
                width: meta.width || null,
                height: meta.height || null,
                size_bytes: processed.length,
                mime_type: 'image/webp'
            })
            .select()
            .single()
            .setHeader('Authorization', req.headers.authorization);
            
        if (insErr) {
            // 스토리지 롤백
            await supabaseAdmin.storage.from('study-photos').remove([path]).catch(() => {});
            throw insErr;
        }

        res.status(201).json({ success: true, photo: row});
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || '업로드 실패'});
    }
});

// 사진 조회
router.get('/records/:recordId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        await assertOwnRecord(recordId, req);

        const { data: photo, error } = await supabase
            .from('record_photos')
            .select('id, path, created_at')
            .eq('record_id', recordId)
            .single()
            .setHeader('Authorization', req.headers.authorization);

        if (error && error.code !== 'PGRST116') throw error;

        if (!photo) {
            return res.json({ success: true, photo: null });
        }

        const { data: signedData, error: signedError } = await supabaseAdmin.storage
            .from('study-photos')
            .createSignedUrl(photo.path, 60 * 5);
        
        if (signedError) throw signedError;

        const result = {
            ...photo,
            url: signedData.signedUrl
        };

        res.json({ success: true, photo: result });
    } catch(err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || '조회 실패' });
    }
});

// 사진 삭제
router.delete('/:photoId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /:photoId');
    try {
        const { photoId } = req.params;

        const { data: photo, error } = await supabase
            .from('record_photos')
            .select('id, record_id, path')
            .eq('id', photoId)
            .single()
            .setHeader('Authorization', req.headers.authorization);
        if (error || !photo) return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });

        // 내 기록인지 확인
        await assertOwnRecord(photo.record_id, req);

        // Storage 삭제
        await supabaseAdmin.storage.from('study-photos').remove([photo.path]);

        // DB 삭제
        const { error: deleteError } = await supabase
            .from('record_photos')
            .delete()
            .eq('id', photoId)
            .setHeader('Authorization', req.headers.authorization);

        if (deleteError) throw deleteError;

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: '삭제 실패'});
    }
});

export default router;