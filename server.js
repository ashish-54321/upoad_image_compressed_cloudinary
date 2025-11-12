require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');

const app = express();
app.use(express.json());

// ✅ Enable CORS
app.use(
    cors({
        origin: 'https://blog-news-admin.netlify.app',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    })
);

// ✅ Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ✅ Multer (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only image files are allowed'));
        }
        cb(null, true);
    },
});

// ✅ Function: Convert & compress to WebP (~100KB)
async function convertAndCompressToWebP(
    inputBuffer,
    { targetBytes = 100 * 1024, minQuality = 20, startQuality = 90, step = 8 } = {}
) {
    let quality = startQuality;
    let lastBuffer = null;

    while (quality >= minQuality) {
        try {
            const buffer = await sharp(inputBuffer)
                .rotate() // auto-orient but keep original dimensions
                .webp({ quality, lossless: false })
                .toBuffer();

            lastBuffer = buffer;

            if (buffer.length <= targetBytes) {
                return { buffer, qualityUsed: quality, reached: true };
            }

            quality -= step;
        } catch (err) {
            throw err;
        }
    }

    // final attempt
    const finalBuffer = await sharp(inputBuffer)
        .rotate()
        .webp({ quality: Math.max(minQuality - 5, 10), lossless: false })
        .toBuffer();

    return {
        buffer: finalBuffer,
        qualityUsed: Math.max(minQuality - 5, 10),
        reached: finalBuffer.length <= targetBytes,
    };
}

// ✅ Upload to Cloudinary
function uploadBufferToCloudinary(buffer, folder = 'uploads') {
    return new Promise((resolve, reject) => {
        const base64 = buffer.toString('base64');
        const dataUri = `data:image/webp;base64,${base64}`;

        cloudinary.uploader.upload(
            dataUri,
            {
                folder,
                resource_type: 'image',
                format: 'webp',
                use_filename: false,
                unique_filename: true,
                overwrite: false,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
    });
}

// ✅ API Route
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded. Field name should be "image".',
            });
        }

        const inputBuffer = req.file.buffer;
        const { buffer: finalBuffer, qualityUsed, reached } = await convertAndCompressToWebP(inputBuffer);
        const uploadResult = await uploadBufferToCloudinary(finalBuffer, 'janta-times-uploads');

        return res.status(200).json({
            success: true,
            message: reached
                ? 'Image processed & uploaded successfully (target size reached).'
                : 'Image processed & uploaded (best-effort, target size not fully reached).',
            url: uploadResult.secure_url,
            public_id: uploadResult.public_id,
            bytes: finalBuffer.length,
            format: 'webp',
            qualityUsed,
        });
    } catch (err) {
        console.error('Upload error:', err);

        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ success: false, message: 'File too large.' });
            }
            return res.status(400).json({ success: false, message: `Multer error: ${err.message}` });
        }

        if (err.name === 'Error' && err.http_code) {
            return res.status(err.http_code).json({
                success: false,
                message: 'Cloudinary upload failed.',
                details: err,
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Internal server error during image processing/upload.',
            error: err.message || err,
        });
    }
});

// ✅ Health check
app.get('/api/health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
