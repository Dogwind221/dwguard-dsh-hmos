/**
 * Zero-dependency PNG decoding + perceptual image features (0.6.4).
 *
 * Supports non-interlaced 8-bit PNG (gray / RGB / palette / gray+alpha / RGBA).
 * Features: DCT pHash (64-bit) and a 4×4×4 RGB histogram.
 */
import { inflateSync, crc32 } from 'node:zlib';
import { readResponseTextLimited } from './http.js';
/** Decoder bounds protect against decompression bombs and huge allocations. */
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_IDAT_BYTES = 20 * 1024 * 1024;
const MAX_RAW_BYTES = 160 * 1024 * 1024;
function fail(message) {
    throw new Error(`PNG 解码失败：${message}`);
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    return pb <= pc ? b : c;
}
function unfilter(data, width, height, bpp) {
    const stride = width * bpp;
    const output = Buffer.alloc(stride * height);
    let offset = 0;
    for (let y = 0; y < height; y += 1) {
        if (offset >= data.length)
            fail('像素数据不完整');
        const filter = data[offset] ?? 0;
        offset += 1;
        const rowStart = y * stride;
        const prevStart = (y - 1) * stride;
        for (let x = 0; x < stride; x += 1) {
            const raw = data[offset + x] ?? 0;
            const left = x >= bpp ? (output[rowStart + x - bpp] ?? 0) : 0;
            const up = y > 0 ? (output[prevStart + x] ?? 0) : 0;
            const upLeft = y > 0 && x >= bpp ? (output[prevStart + x - bpp] ?? 0) : 0;
            let value;
            switch (filter) {
                case 0:
                    value = raw;
                    break;
                case 1:
                    value = raw + left;
                    break;
                case 2:
                    value = raw + up;
                    break;
                case 3:
                    value = raw + Math.floor((left + up) / 2);
                    break;
                case 4:
                    value = raw + paeth(left, up, upLeft);
                    break;
                default:
                    fail(`未知行过滤器 ${filter}`);
            }
            output[rowStart + x] = value & 0xff;
        }
        offset += stride;
    }
    return output;
}
/**
 * Decode an 8-bit non-interlaced PNG into RGBA.
 * @param buffer - raw PNG bytes.
 */
export function decodePng(buffer) {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE))
        fail('不是 PNG（签名不匹配）');
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    let idatBytes = 0;
    let palette = null;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length)
            fail(`chunk ${type} 越界`);
        const data = buffer.subarray(dataStart, dataEnd);
        const expected = buffer.readUInt32BE(dataEnd);
        const actual = crc32(buffer.subarray(offset + 4, dataEnd)) >>> 0;
        if (expected !== actual)
            fail(`chunk ${type} CRC 校验失败`);
        if (type === 'IHDR') {
            if (length !== 13)
                fail('IHDR 长度不对');
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8] ?? 0;
            colorType = data[9] ?? 0;
            if ((data[10] ?? 1) !== 0)
                fail('不支持的压缩方法');
            if ((data[11] ?? 1) !== 0)
                fail('不支持的过滤方法');
            interlace = data[12] ?? 0;
            if (width <= 0 || height <= 0)
                fail('IHDR 宽高必须大于 0');
            if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
                fail(`PNG 尺寸过大（${width}×${height}，单边上限 ${MAX_IMAGE_DIMENSION}）`);
            }
            if (width * height > MAX_IMAGE_PIXELS) {
                fail(`PNG 像素数过大（${width * height}，上限 ${MAX_IMAGE_PIXELS}）`);
            }
        }
        else if (type === 'PLTE') {
            palette = Buffer.from(data);
        }
        else if (type === 'IDAT') {
            idatBytes += data.length;
            if (idatBytes > MAX_IDAT_BYTES)
                fail(`PNG IDAT 数据过大（上限 ${MAX_IDAT_BYTES} B）`);
            idat.push(Buffer.from(data));
        }
        else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }
    if (width === 0 || height === 0)
        fail('缺少有效的 IHDR');
    if (interlace !== 0)
        fail('暂不支持隔行扫描 PNG');
    if (bitDepth !== 8)
        fail(`暂只支持 8 位深度（收到 ${bitDepth}）`);
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (channels === 0)
        fail(`不支持的颜色类型 ${colorType}`);
    if (colorType === 3 && palette === null)
        fail('调色板 PNG 缺少 PLTE');
    if (idat.length === 0)
        fail('缺少 IDAT');
    const expectedRaw = height * (1 + width * channels);
    if (expectedRaw > MAX_RAW_BYTES)
        fail(`PNG 解压后数据过大（${expectedRaw} B）`);
    let inflated;
    try {
        inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRaw });
    }
    catch {
        fail(`PNG 解压失败或超过上限（${expectedRaw} B）`);
    }
    const raw = unfilter(inflated, width, height, channels);
    const rgba = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
        const source = index * channels;
        const target = index * 4;
        let r;
        let g;
        let b;
        let a = 255;
        if (colorType === 0) {
            r = g = b = raw[source] ?? 0;
        }
        else if (colorType === 2) {
            r = raw[source] ?? 0;
            g = raw[source + 1] ?? 0;
            b = raw[source + 2] ?? 0;
        }
        else if (colorType === 4) {
            r = g = b = raw[source] ?? 0;
            a = raw[source + 1] ?? 255;
        }
        else if (colorType === 6) {
            r = raw[source] ?? 0;
            g = raw[source + 1] ?? 0;
            b = raw[source + 2] ?? 0;
            a = raw[source + 3] ?? 255;
        }
        else {
            const paletteIndex = raw[source] ?? 0;
            const paletteOffset = palette === null ? -1 : paletteIndex * 3;
            if (paletteOffset < 0 || paletteOffset + 3 > (palette?.length ?? 0))
                fail('调色板索引越界');
            r = palette?.[paletteOffset] ?? 0;
            g = palette?.[paletteOffset + 1] ?? 0;
            b = palette?.[paletteOffset + 2] ?? 0;
        }
        rgba[target] = r;
        rgba[target + 1] = g;
        rgba[target + 2] = b;
        rgba[target + 3] = a;
    }
    return { width, height, rgba };
}
function grayscaleMatrix(image, size) {
    const { width, height, rgba } = image;
    const matrix = [];
    for (let ty = 0; ty < size; ty += 1) {
        const row = [];
        const y0 = Math.floor((ty * height) / size);
        const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / size));
        for (let tx = 0; tx < size; tx += 1) {
            const x0 = Math.floor((tx * width) / size);
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / size));
            let sum = 0;
            let count = 0;
            for (let y = y0; y < y1; y += 1) {
                for (let x = x0; x < x1; x += 1) {
                    const index = (y * width + x) * 4;
                    const r = rgba[index] ?? 0;
                    const g = rgba[index + 1] ?? 0;
                    const b = rgba[index + 2] ?? 0;
                    sum += 0.299 * r + 0.587 * g + 0.114 * b;
                    count += 1;
                }
            }
            row.push(count === 0 ? 0 : sum / count);
        }
        matrix.push(row);
    }
    return matrix;
}
function dct32(matrix) {
    const n = 32;
    const cos = [];
    for (let u = 0; u < n; u += 1) {
        const row = [];
        for (let x = 0; x < n; x += 1)
            row.push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n)));
        cos.push(row);
    }
    const result = Array.from({ length: n }, () => Array(n).fill(0));
    for (let u = 0; u < n; u += 1) {
        for (let v = 0; v < n; v += 1) {
            let sum = 0;
            for (let y = 0; y < n; y += 1) {
                for (let x = 0; x < n; x += 1) {
                    sum += (matrix[y]?.[x] ?? 0) * (cos[u]?.[x] ?? 0) * (cos[v]?.[y] ?? 0);
                }
            }
            const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
            const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
            result[u][v] = 0.25 * cu * cv * sum;
        }
    }
    return result;
}
function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
}
function hashBits(bits) {
    let hex = '';
    for (let start = 0; start < bits.length; start += 4) {
        let value = 0;
        for (let offset = 0; offset < 4; offset += 1) {
            value = (value << 1) | (bits[start + offset] ? 1 : 0);
        }
        hex += value.toString(16);
    }
    return hex;
}
/** Compute DCT pHash + RGB histogram. */
export function imageFeatures(image) {
    const matrix = grayscaleMatrix(image, 32);
    const dct = dct32(matrix);
    const low = [];
    for (let u = 0; u < 8; u += 1) {
        for (let v = 0; v < 8; v += 1)
            low.push(dct[u]?.[v] ?? 0);
    }
    const mid = median(low);
    const phash = hashBits(low.map((value) => value > mid));
    const bins = new Array(64).fill(0);
    const total = image.width * image.height;
    const stride = Math.max(1, Math.floor(total / 20000));
    let sampled = 0;
    for (let index = 0; index < total; index += stride) {
        const offset = index * 4;
        const r = image.rgba[offset] ?? 0;
        const g = image.rgba[offset + 1] ?? 0;
        const b = image.rgba[offset + 2] ?? 0;
        const bin = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6);
        bins[bin] = (bins[bin] ?? 0) + 1;
        sampled += 1;
    }
    return {
        phash,
        histogram: bins.map((count) => Number((count / Math.max(1, sampled)).toFixed(6)))
    };
}
/** Hamming distance between two 16-hex pHashes (0–64). */
export function hashDistance(left, right) {
    let distance = 0;
    for (let index = 0; index < 16; index += 1) {
        const a = Number.parseInt(left[index] ?? '0', 16);
        const b = Number.parseInt(right[index] ?? '0', 16);
        let xor = (Number.isFinite(a) ? a : 0) ^ (Number.isFinite(b) ? b : 0);
        while (xor !== 0) {
            distance += xor & 1;
            xor >>= 1;
        }
    }
    return distance;
}
/** Score two feature sets: 60% pHash similarity + 40% histogram intersection. */
export function imageSimilarity(left, right) {
    const distance = hashDistance(left.phash, right.phash);
    const hashSimilarity = 1 - distance / 64;
    let intersection = 0;
    for (let index = 0; index < 64; index += 1) {
        intersection += Math.min(left.histogram[index] ?? 0, right.histogram[index] ?? 0);
    }
    const histogramSimilarity = Math.min(1, Math.max(0, intersection));
    return {
        score: Number((0.6 * hashSimilarity + 0.4 * histogramSimilarity).toFixed(4)),
        hashDistance: distance,
        hashSimilarity: Number(hashSimilarity.toFixed(4)),
        histogramSimilarity: Number(histogramSimilarity.toFixed(4))
    };
}
/** Cache identity for a multimodal endpoint. */
export function clipIdentity(config) {
    return `${config.provider ?? 'custom'}\u0000${config.endpoint}\u0000${config.model}\u0000${config.modelVersion ?? ''}`;
}
/** DashScope native multimodal embedding endpoint (not supported by compatible mode). */
export const DASHSCOPE_MULTIMODAL_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding';
/** Text-only embedder backed by DashScope's native multimodal endpoint (0.6.6). */
export async function createDashScopeTextEmbedder(config) {
    const client = await createClipClient({ ...config, provider: 'dashscope' });
    return async (texts) => {
        if (texts.length === 0)
            return [];
        const embeddings = await client({ texts });
        return embeddings.textEmbeddings.map((vector) => [...vector]);
    };
}
function asVector(raw, label) {
    if (!Array.isArray(raw) || raw.length === 0)
        throw new Error(`${label} 向量格式不对`);
    return raw.map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value))
            throw new Error(`${label} 含非数值`);
        return value;
    });
}
async function requestJson(config, init, label) {
    const response = await fetch(config.endpoint, init);
    const text = await readResponseTextLimited(response);
    let body = {};
    try {
        body = JSON.parse(text);
    }
    catch {
        throw new Error(`${label} HTTP ${response.status}（非 JSON 响应）`);
    }
    if (!response.ok) {
        const message = typeof body['message'] === 'string' ? body['message'] : text.slice(0, 200);
        throw new Error(`${label} HTTP ${response.status}：${message}`);
    }
    return body;
}
/**
 * Call a multimodal embedding endpoint.
 *
 * `dashscope` follows the native multimodal-embedding API:
 * `POST {model, input:{contents:[{text}|{image}]}}` → `{output:{embeddings:[{index,embedding}]}}`.
 * `custom` follows `POST {model, images?: [dataUrl], texts?: [string]}` →
 * `{imageEmbeddings?: number[][], textEmbeddings?: number[][]}`.
 */
export async function createClipClient(config) {
    return async (request) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs));
        const images = request.images ?? [];
        const texts = request.texts ?? [];
        try {
            const headers = {
                'content-type': 'application/json',
                ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` })
            };
            if (config.provider === 'dashscope') {
                if (config.endpoint.length === 0)
                    throw new Error('DashScope provider 缺少 endpoint');
                const contents = [
                    ...images.map((buffer) => ({ image: `data:image/png;base64,${buffer.toString('base64')}` })),
                    ...texts.map((text) => ({ text }))
                ];
                if (contents.length === 0)
                    return { imageEmbeddings: [], textEmbeddings: [] };
                const body = await requestJson(config, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ model: config.model, input: { contents } }),
                    signal: controller.signal
                }, 'DashScope 多模态');
                const output = body['output'];
                const embeddings = typeof output === 'object' && output !== null ? output['embeddings'] : undefined;
                if (!Array.isArray(embeddings) || embeddings.length !== contents.length) {
                    throw new Error(`DashScope 返回条数与输入不一致（期望 ${contents.length}，实际 ${Array.isArray(embeddings) ? embeddings.length : 0}）`);
                }
                const byIndex = new Map();
                embeddings.forEach((entry) => {
                    if (typeof entry !== 'object' || entry === null)
                        throw new Error('DashScope embedding 条目格式不对');
                    const record = entry;
                    const index = typeof record['index'] === 'number' ? record['index'] : byIndex.size;
                    if (index < 0 || index >= contents.length)
                        throw new Error(`DashScope embedding index 越界：${index}`);
                    byIndex.set(index, asVector(record['embedding'], `DashScope[${index}]`));
                });
                return {
                    imageEmbeddings: images.map((_, index) => byIndex.get(index) ?? []),
                    textEmbeddings: texts.map((_, index) => byIndex.get(images.length + index) ?? [])
                };
            }
            const dataUrls = images.map((buffer) => `data:image/png;base64,${buffer.toString('base64')}`);
            const body = await requestJson(config, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: config.model,
                    ...(dataUrls.length === 0 ? {} : { images: dataUrls }),
                    ...(texts.length === 0 ? {} : { texts })
                }),
                signal: controller.signal
            }, 'CLIP');
            const parse = (raw, expected, label) => {
                if (raw === undefined)
                    return [];
                if (!Array.isArray(raw) || raw.length !== expected)
                    throw new Error(`${label} 条数与输入不一致`);
                return raw.map((row, index) => asVector(row, `${label}[${index}]`));
            };
            return {
                imageEmbeddings: parse(body['imageEmbeddings'], images.length, 'imageEmbeddings'),
                textEmbeddings: parse(body['textEmbeddings'], texts.length, 'textEmbeddings')
            };
        }
        finally {
            clearTimeout(timer);
        }
    };
}
