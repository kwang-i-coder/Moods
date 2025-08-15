import express from "express";
import crypto from "crypto";
import multer from "multer";
import sharp from "sharp";
import supabase from "../lib/supabaseClient.js";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import verifySupabaseJWT from "../lib/verifyJWT.js";
import { title } from "process";

const router = express.Router();

//업로드 설정, 이미지 MIME만 허용
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 
            'image/jpg',
            'image/png', 
            'image/webp', 
            'image/heic', 
            'image/heif'
        ];
        const ok = allowedTypes.includes(file.mimetype);
        cb(ok ? null : new Error('JPG, PNG, WebP, HEIC, HEIF 형식만 허용합니다.'), ok);
    }
});

// 본인 기록인지 확인
async function assertOwnRecord(recordID, req) {
    console.log('assertOwnRecord 호출:', { recordID, userSub: req.user?.sub }); // 디버깅 로그
    const { data: rec, error } = await supabase
        .from('study_record')
        .select('id, user_id')
        .eq('id', recordID)
        .single()
        .setHeader('Authorization', req.headers.authorization);
    
    console.log('DB 조회 결과:', { rec, error }); // 디버깅 로그
    
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

// 사진 업로드 (1장만 허용)
router.post('/records/:recordId', verifySupabaseJWT, upload.single('file'), async(req, res) => {
    console.log('[라우트 호출] POST /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        console.log('받은 recordId:', recordId, typeof recordId); // 디버깅 로그
        await assertOwnRecord(recordId, req);
        
        // 입력값 검증
        if (!recordId) {
            return res.status(400).json({ error: '기록ID가 필요합니다.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: '업로드 할 파일이 없습니다.' });
        }

        // 기존 사진이 있는지 체크 (Admin 클라이언트 사용)
        const { data: existingPhoto, error: existingError } = await supabaseAdmin
            .from('record_photos')
            .select('id')
            .eq('record_id', recordId)
            .single();

        // 에러가 있는데 '데이터 없음' 에러가 아니면 실제 에러
        if (existingError && existingError.code !== 'PGRST116') {
            throw existingError;
        }

        if (existingPhoto) {
            return res.status(400).json({ error: '이미 사진이 등록되어 있습니다. 기존 사진을 삭제 후 업로드해주세요.' });
        }

        // 이미지 처리 (HEIF 지원 포함)
        let processed;
        try {
            const sharpInstance = sharp(req.file.buffer);
            
            // HEIF 파일인지 확인
            const metadata = await sharpInstance.metadata();
            console.log('이미지 메타데이터:', {
                format: metadata.format,
                width: metadata.width,
                height: metadata.height,
                size: req.file.size
            });

            processed = await sharpInstance
                .rotate() // EXIF 회전 정보 자동 적용
                .resize({ 
                    width: 2000, 
                    height: 2000, 
                    fit: 'inside', 
                    withoutEnlargement: true 
                })
                .webp({ quality: 82 })
                .toBuffer();
                
        } catch (sharpError) {
            console.error('Sharp 처리 에러:', sharpError);
            
            if (sharpError.message.includes('heif') || 
                sharpError.message.includes('HEIC') ||
                sharpError.message.includes('libheif') ||
                sharpError.message.includes('compression format')) {
                throw new Error('HEIC/HEIF 파일 처리를 위한 라이브러리가 설치되지 않았습니다. 서버 관리자에게 문의하거나 JPG/PNG 형식을 사용해주세요.');
            }
            
            // 일반적인 Sharp 에러
            if (sharpError.message.includes('Input buffer contains unsupported image format')) {
                throw new Error('지원되지 않는 이미지 형식입니다. JPG, PNG, WebP 형식을 사용해주세요.');
            }
            
            throw new Error('이미지 처리 중 오류가 발생했습니다: ' + sharpError.message);
        }

        const meta = await sharp(processed).metadata();
        const path = buildPath(req.user.sub, recordId);

        // Storage 업로드
        const { error: uploadError } = await supabaseAdmin.storage
            .from('study-photos')
            .upload(path, processed, { contentType: 'image/webp', upsert: false });
        
        if (uploadError) throw uploadError;

        // DB 저장
        const { data: row, error: insertError } = await supabase
            .from('record_photos')
            .insert({
                record_id: recordId, // parseInt 제거
                path,
                width: meta.width || null,
                height: meta.height || null,
                size_bytes: processed.length,
                mime_type: 'image/webp'
            })
            .select()
            .single()
            .setHeader('Authorization', req.headers.authorization);
            
        if (insertError) {
            // Storage 롤백
            await supabaseAdmin.storage.from('study-photos').remove([path]).catch((rollbackErr) => {
                console.error('Storage 롤백 실패:', rollbackErr);
            });
            throw insertError;
        }

        res.status(201).json({ success: true, photo: row });
    } catch (err) {
        console.error('사진 업로드 에러:', err);
        res.status(err.status || 500).json({ error: err.message || '업로드 실패' });
    }
});

// 사진 조회
router.get('/records/:recordId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        await assertOwnRecord(recordId, req);

        const { data: photo, error } = await supabaseAdmin
            .from('record_photos')
            .select('id, path, created_at')
            .eq('record_id', recordId)
            .single();

        // 데이터가 없는 경우는 정상 (null 반환)
        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        if (!photo) {
            return res.json({ success: true, photo: null });
        }

        // Signed URL 생성
        const { data: signedData, error: signedError } = await supabaseAdmin.storage
            .from('study-photos')
            .createSignedUrl(photo.path, 60 * 60 * 60 * 60);
        
        if (signedError) throw signedError;

        const result = {
            ...photo,
            url: signedData.signedUrl
        };

        res.json({ success: true, photo: result });
    } catch (err) {
        console.error('사진 조회 에러:', err);
        res.status(err.status || 500).json({ error: err.message || '조회 실패' });
    }
});

// 사진 삭제
router.delete('/:photoId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /:photoId');
    try {
        const { photoId } = req.params;

        if (!photoId) {
            return res.status(400).json({ error: '사진ID가 필요합니다.' });
        }

        const { data: photo, error } = await supabaseAdmin
            .from('record_photos')
            .select('id, record_id, path')
            .eq('id', photoId)
            .single();
            
        if (error || !photo) {
            return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });
        }

        // 내 기록인지 확인
        await assertOwnRecord(photo.record_id, req);

        // DB 먼저 삭제 (실패하면 Storage 삭제 안함)
        const { error: deleteError } = await supabase
            .from('record_photos')
            .delete()
            .eq('id', photoId)
            .setHeader('Authorization', req.headers.authorization);

        if (deleteError) throw deleteError;

        // DB 삭제 성공하면 Storage 삭제
        const { error: storageError } = await supabaseAdmin.storage
            .from('study-photos')
            .remove([photo.path]);

        if (storageError) {
            console.error('Storage 삭제 실패 (DB는 이미 삭제됨):', storageError);
            // Storage 삭제 실패해도 200 반환 (DB는 정리됨)
        }

        res.json({ success: true });
    } catch (err) {
        console.error('사진 삭제 에러:', err);
        res.status(err.status || 500).json({ error: err.message || '삭제 실패' });
    }
});

router.get('/wallpaper', async (req, res) => {
    const {query} = req.query;
    if(!query) {
        return res.status(400).json({error: "검색어가 필요합니다."});
    }
    const header = {
        "Content-Type": "application/json",
    }
    const body = {
        title: query.trim()
    }
    const response = await fetch("http://localhost:8000/tasks/wallpaper", {method:"POST", headers:header, body:JSON.stringify(body)})
    const data = await response.json();
    return res.status(200).json({
        success: true,
        data: data
    })
})

export default router;